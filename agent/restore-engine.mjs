/**
 * AddInvoice geri yükleme motoru (Aşama 1, 20 Kas 2026) — borg arşivlerinden GÜVENLİ KOPYAYA açar; canlı veriye ASLA yazmaz.
 *  • Dosyalar: arşivde gezin → seçilenleri çalışma alanına aç → şifreli indirilebilir paket.
 *  • Veritabanı: dökümü geçici bir veritabanına (restore_<id>) açar → tablolar/satır sayıları → önizleme → CSV / şirket paketi.
 * Çalışma alanı: /var/lib/addinvoice-restore/<id> (root 700) + manifest.json; 24 saat sonra (geçici veritabanıyla birlikte) silinir.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import * as BE from "./backup-engine.mjs"

const { UserError, run, borgEnv } = BE
export const ROOT = process.env.AIR_ROOT || "/var/lib/addinvoice-restore"
const DB = "addinvoice_db"
const LIVE_DB = process.env.AIR_LIVE_DB || DB // (yalnız testler için geçersiz kılınır)
const LIVE_FILES_PREFIX = "var/www/addinvoice/data/uploads/"
const LIVE_FILES_ROOT = process.env.AIR_LIVE_FILES || "/var/www/addinvoice/data/uploads"
const UNDO_ROOT = path.join(process.env.AIR_ROOT || "/var/lib/addinvoice-restore", "undo")
const MAX_BYTES = 5 * 1024 ** 3
const EXPORT_TMP = "/var/backups/addinvoice-companies"
export const newId = () => crypto.randomBytes(4).toString("hex")
const ID_RE = /^[a-f0-9]{8}$/
const ARCHIVE_RE = /^[a-z0-9][a-z0-9-]{0,40}-\d{4}-\d\d-\d\d_\d{4}$/
const asPg = (cmd, args, opts) => run("runuser", ["-u", "postgres", "--", cmd, ...args], opts)
const wsDir = (id) => path.join(ROOT, id)
const dbName = (id) => `restore_${id}`

function checkId(id) { if (!ID_RE.test(String(id ?? ""))) throw new UserError("Geçersiz çalışma alanı kimliği"); return String(id) }
function checkArchive(a) { if (!ARCHIVE_RE.test(String(a ?? ""))) throw new UserError("Geçersiz arşiv adı"); return String(a) }
function target(id) { const t = BE.loadConfig().targets.find((x) => x.id === String(id)); if (!t) throw new UserError("Hedef bulunamadı"); return t }
const prefixOf = (archive) => archive.replace(/-\d{4}-\d\d-\d\d_\d{4}$/, "")

function manifest(id) { try { return JSON.parse(fs.readFileSync(path.join(wsDir(id), "manifest.json"), "utf8")) } catch { return null } }
function writeManifest(id, patch) {
  const dir = wsDir(id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...(manifest(id) ?? { id, created: Date.now() }), ...patch }, null, 1), { mode: 0o600 })
}
export function workspace(id, init) {
  checkId(id)
  const dir = wsDir(id)
  if (init) { fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); writeManifest(id, init) }
  else if (!fs.existsSync(dir)) throw new UserError("Çalışma alanı bulunamadı (24 saat sonra silinir)")
  return dir
}

// ── Arşiv içinde gezinme ─────────────────────────────────────────────────────
const cache = new Map()
async function archiveIndex(t, archive) {
  const key = `${t.id}|${archive}`
  const c = cache.get(key)
  if (c && Date.now() - c.at < 10 * 60_000) return c.entries
  const r = await run("borg", ["list", "--format", "{type}{TAB}{size}{TAB}{isomtime}{TAB}{path}{NL}", `::${archive}`], { env: borgEnv(t), timeout: 10 * 60_000 })
  if (r.code > 1) throw new UserError("Arşiv okunamadı: " + r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  const entries = []
  for (const l of r.stdout.split("\n")) {
    if (!l) continue
    const [type, size, mtime, ...rest] = l.split("\t")
    entries.push({ d: type === "d", s: Number(size) || 0, m: mtime, p: rest.join("\t") })
    if (entries.length > 400_000) break
  }
  cache.set(key, { at: Date.now(), entries })
  while (cache.size > 4) cache.delete(cache.keys().next().value)
  return entries
}

export async function browse({ target: tid, archive, dir = "", auto = false }) {
  const t = target(tid); checkArchive(archive)
  const entries = await archiveIndex(t, archive)
  let cur = String(dir ?? "").replace(/^\/+|\/+$/g, "")
  if (cur.includes("..") || cur.includes("\0")) throw new UserError("Geçersiz yol")
  const children = (d) => {
    const prefix = d ? d + "/" : ""
    const map = new Map()
    for (const e of entries) {
      if (!e.p.startsWith(prefix) || e.p === d) continue
      const rest = e.p.slice(prefix.length), i = rest.indexOf("/"), name = i < 0 ? rest : rest.slice(0, i)
      let c = map.get(name)
      if (!c) { c = { name, path: prefix + name, dir: false, files: 0, size: 0, mtime: "" }; map.set(name, c) }
      if (i >= 0 || e.d) c.dir = true
      if (!e.d) { c.files++; c.size += e.s; if (i < 0) c.mtime = e.m }
    }
    return [...map.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }
  let list = children(cur)
  if (auto) for (let i = 0; i < 10 && list.length === 1 && list[0].dir; i++) { cur = list[0].path; list = children(cur) }
  return { dir: cur, children: list.slice(0, 1000), truncated: list.length > 1000, totalEntries: entries.length }
}

// ── Dosyaları güvenli kopyaya aç ─────────────────────────────────────────────
export async function extractFiles({ target: tid, archive, paths }, id, actor) {
  const t = target(tid); checkArchive(archive)
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200) throw new UserError("1-200 yol seçin")
  const clean = paths.map((p) => String(p).replace(/^\/+|\/+$/g, ""))
  if (clean.some((p) => !p || p.includes("..") || p.includes("\0") || p.includes("\n") || p.length > 500)) throw new UserError("Geçersiz yol seçimi")
  const entries = await archiveIndex(t, archive)
  let bytes = 0, files = 0
  for (const e of entries) if (!e.d && clean.some((p) => e.p === p || e.p.startsWith(p + "/"))) { bytes += e.s; files++ }
  if (files === 0) throw new UserError("Seçimde dosya bulunamadı")
  if (bytes > MAX_BYTES) throw new UserError(`Seçim çok büyük (${Math.round(bytes / 1048576)} MB; en çok ${MAX_BYTES / 1024 ** 3} GB)`)
  const free = fs.statfsSync(path.dirname(ROOT)); if (free.bavail * free.bsize < bytes * 2 + 512 * 1048576) throw new UserError("Diskte yeterli yer yok")
  const dir = workspace(id, { type: "files", target: t.id, archive, actor, paths: clean })
  const out = path.join(dir, "files"); fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const r = await run("borg", ["extract", `::${archive}`, ...clean], { env: borgEnv(t), cwd: out, timeout: 2 * 3600_000 })
  if (r.code > 1) throw new UserError("Açma başarısız: " + r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  return { dir: out, files, bytes }
}

// ── Veritabanı dökümünü geçici veritabanına aç ───────────────────────────────
async function extractDump(t, archive, dir, sub) {
  const prefix = prefixOf(archive)
  const out = path.join(dir, sub); fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const r = await run("borg", ["extract", `::${archive}`, `var/backups/addinvoice-staging/${prefix}`], { env: borgEnv(t), cwd: out, timeout: 30 * 60_000 })
  if (r.code > 1) throw new UserError("Döküm açılamadı: " + r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  const f = (await run("find", [out, "-name", "*.dump"])).stdout.split("\n").filter(Boolean)
  if (!f.length) throw new UserError("Arşivde veritabanı dökümü (.dump) yok — bu görev veritabanı yedeklemiyor")
  return f
}
const loadFile = (db, file, flags) => new Promise((resolve) => {
  const fd = fs.openSync(file, "r")
  const p = spawn("runuser", ["-u", "postgres", "--", "pg_restore", "-d", db, "--no-owner", "--no-privileges", ...flags], { stdio: [fd, "ignore", "pipe"] })
  let err = ""; p.stderr.on("data", (d) => { err += d.toString().slice(0, 2000) })
  p.on("close", (code) => { fs.closeSync(fd); resolve({ code, err }) })
})
const sql = (db, q, vars = {}) => asPg("psql", ["-X", "-At", "-d", db, "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"], { input: q, timeout: 5 * 60_000 })

export async function dbPrepare({ target: tid, archive, jobType }, id, actor, log) {
  const t = target(tid); checkArchive(archive)
  if (!["db", "tables"].includes(jobType)) throw new UserError("Bu arşiv veritabanı dökümü içermiyor")
  const dir = workspace(id, { type: "db", target: t.id, archive, actor, db: dbName(id) })
  const name = dbName(id)
  const created = await asPg("createdb", [name]); if (created.code !== 0) throw new UserError("Geçici veritabanı oluşturulamadı: " + created.stderr.slice(0, 200))
  const dumps = await extractDump(t, archive, dir, "dump")
  if (jobType === "db") {
    const r = await loadFile(name, dumps.find((f) => f.endsWith("db-full.dump")) ?? dumps[0], [])
    if (r.code > 1) throw new UserError("Döküm geri yüklenemedi: " + r.err.slice(0, 300))
    if (r.err) log?.("uyarı: " + r.err.split("\n")[0].slice(0, 200))
  } else {
    // 'tables' dökümü yalnız seçili tabloların verisidir; enum tipleri/şema için en yeni TAM dökümün 'pre-data' bölümü önce yüklenir.
    const cfg = BE.loadConfig()
    const dbJob = cfg.jobs.find((j) => j.type === "db" && j.targets.includes(t.id))
    const latest = dbJob ? (await run("borg", ["list", "--short", "--glob-archives", `${dbJob.id}-*`, "--last", "1"], { env: borgEnv(t) })).stdout.trim() : ""
    if (!latest) throw new UserError("Şema için tam veritabanı dökümü (db görevi) bulunamadı")
    log?.(`şema kaynağı: ${latest}`)
    const full = await extractDump(t, latest, dir, "schema")
    const pre = await loadFile(name, full.find((f) => f.endsWith("db-full.dump")) ?? full[0], ["--section=pre-data"])
    if (pre.code > 1) throw new UserError("Şema yüklenemedi: " + pre.err.slice(0, 300))
    const data = await loadFile(name, dumps[0], ["--data-only", "--disable-triggers"])
    if (data.code > 1) throw new UserError("Veri yüklenemedi: " + data.err.slice(0, 300))
    fs.rmSync(path.join(dir, "schema"), { recursive: true, force: true })
  }
  fs.rmSync(path.join(dir, "dump"), { recursive: true, force: true })
  return summary(id)
}

export async function summary(id) {
  checkId(id); const m = manifest(id); if (!m?.db) throw new UserError("Geçici veritabanı yok")
  const counts = await sql(m.db, `select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;`)
  if (counts.code !== 0) throw new UserError("Tablolar okunamadı: " + counts.stderr.slice(0, 200))
  const tables = counts.stdout.split("\n").filter(Boolean).map((l) => { const [n, c] = l.split("|"); return { name: n, rows: Number(c) || 0 } })
  const cc = await sql(m.db, `select distinct table_name from information_schema.columns where table_schema='public' and column_name='company_id';`)
  const companyTables = cc.stdout.split("\n").filter(Boolean)
  let companies = []
  if (tables.some((t) => t.name === "companies")) {
    const r = await sql(m.db, `select coalesce(json_agg(c), '[]'::json) from (select id, name from public.companies order by name limit 500) c;`)
    try { companies = JSON.parse(r.stdout.trim() || "[]") } catch {}
  }
  return { id, db: m.db, archive: m.archive, tables: tables.filter((t) => t.rows > 0 || true), companyTables, companies }
}

async function validTable(id, table) {
  const s = await summary(id)
  if (!s.tables.some((t) => t.name === table)) throw new UserError("Tablo bulunamadı")
  return s
}
const UUIDISH = /^[A-Za-z0-9_-]{8,40}$/

export async function dbPreview({ id, table, companyId }) {
  const s = await validTable(id, String(table))
  let where = ""
  const vars = {}
  if (companyId) {
    if (!UUIDISH.test(companyId)) throw new UserError("Geçersiz şirket kimliği")
    if (!s.companyTables.includes(table)) throw new UserError("Bu tabloda şirket sütunu yok")
    where = "where company_id = :'cid'"; vars.cid = companyId
  }
  const r = await sql(s.db, `select coalesce(json_agg(t), '[]'::json) from (select * from public."${table}" ${where} limit 50) t;`, vars)
  if (r.code !== 0) throw new UserError("Önizleme başarısız: " + r.stderr.slice(0, 200))
  let rows = []; try { rows = JSON.parse(r.stdout.trim()) } catch {}
  const cut = (v) => (typeof v === "string" && v.length > 160 ? v.slice(0, 160) + "…" : v && typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v)
  rows = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cut(v)])))
  const cnt = await sql(s.db, `select count(*) from public."${table}" ${where};`, vars)
  return { table, total: Number(cnt.stdout.trim()) || 0, shown: rows.length, rows }
}

const toFile = (file, db, query, vars) => new Promise((resolve) => {
  const fd = fs.openSync(file, "w", 0o600)
  const p = spawn("runuser", ["-u", "postgres", "--", "psql", "-X", "-d", db, "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"], { stdio: ["pipe", fd, "pipe"] })
  let err = ""; p.stderr.on("data", (d) => { err += d.toString().slice(0, 1000) })
  p.stdin.end(query)
  p.on("close", (code) => { fs.closeSync(fd); resolve({ code, err }) })
})

/** Seçili tabloları (isteğe bağlı şirkete göre süzerek) CSV yapar ya da seçili şirketin tam paketini (company-backup) üretir. */
export async function dbExport({ id, tables, companyId, companyPackage }, scriptDir) {
  const s = await summary(id)
  const out = path.join(wsDir(id), "export"); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  if (companyPackage) {
    if (!UUIDISH.test(companyId ?? "")) throw new UserError("Şirket seçin")
    // company-backup, postgres kullanıcısıyla (\copy) yazar → çıktı root-700 çalışma alanında OLAMAZ; ajanın mevcut dışa aktarma klasörünü kullan
    const pkg = path.join(EXPORT_TMP, `restore-${id}`)
    fs.mkdirSync(EXPORT_TMP, { recursive: true, mode: 0o700 }); fs.rmSync(pkg, { recursive: true, force: true })
    const r = await run("node", [path.join(scriptDir, "company-backup.mjs"), "export", companyId, "--out", pkg, "--db", s.db], { timeout: 3600_000 })
    if (r.code !== 0) { fs.rmSync(pkg, { recursive: true, force: true }); throw new UserError("Şirket paketi üretilemedi: " + r.stderr.slice(0, 300)) }
    return { dir: pkg, files: (await run("find", [pkg, "-type", "f"])).stdout.split("\n").filter(Boolean).length, removeAfter: true }
  }
  if (!Array.isArray(tables) || tables.length < 1 || tables.length > 60) throw new UserError("1-60 tablo seçin")
  let n = 0
  for (const table of tables) {
    if (!s.tables.some((t) => t.name === table)) throw new UserError("Tablo bulunamadı: " + String(table).slice(0, 40))
    let where = ""; const vars = {}
    if (companyId && s.companyTables.includes(table)) { if (!UUIDISH.test(companyId)) throw new UserError("Geçersiz şirket kimliği"); where = "where company_id = :'cid'"; vars.cid = companyId }
    const r = await toFile(path.join(out, `${table}.csv`), s.db, `copy (select * from public."${table}" ${where}) to stdout with csv header;`, vars)
    if (r.code !== 0) throw new UserError(`${table} dışa aktarılamadı: ${r.err.slice(0, 200)}`)
    n++
  }
  return { dir: out, files: n }
}

// ══ AŞAMA 2: CANLIYA UYGULAMA ═══════════════════════════════════════════════════════════════════════════
// Güvenlik ilkeleri: önce plan (kuru çalıştırma) → yazarak onay → uygula. Hiçbir şey sessizce silinmez: üzerine yazılan dosyalar/satırlar
// "geri alma" klasörüne (14 gün) alınır; veritabanı işlemi TEK işlemdir (hata → tamamı geri alınır); öncesinde pgBackRest restore noktası konur.
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else if (e.isFile()) out.push(path.relative(base, full))
  }
  return out
}
const liveOf = (p) => (p.startsWith(LIVE_FILES_PREFIX) ? path.join(LIVE_FILES_ROOT, p.slice(LIVE_FILES_PREFIX.length)) : null)
function safeLive(live) {
  const root = path.resolve(LIVE_FILES_ROOT)
  const r = path.resolve(live)
  if (!r.startsWith(root + path.sep)) return false
  // var olan en yakın üst klasörün gerçek yolu da kökün içinde kalmalı (sembolik bağlantı kaçışı yok)
  let d = path.dirname(r)
  while (!fs.existsSync(d) && d.length > root.length) d = path.dirname(d)
  return fs.realpathSync(d).startsWith(fs.realpathSync(root))
}

/** Dosya planı: çalışma alanına açılmış (extractFiles) dosyaların canlı bilag klasörüyle karşılaştırması. */
export function filesPlan(id) {
  checkId(id)
  const m = manifest(id); if (!m || m.type !== "files") throw new UserError("Dosya çalışma alanı bulunamadı")
  const base = path.join(wsDir(id), "files")
  if (!fs.existsSync(base)) throw new UserError("Açılmış dosya yok")
  const res = { id, archive: m.archive, new: [], same: [], different: [], blocked: [] }
  for (const rel of walk(base)) {
    const live = liveOf(rel)
    if (!live || !safeLive(live)) { res.blocked.push(rel); continue }
    if (!fs.existsSync(live)) { res.new.push(rel); continue }
    const a = fs.statSync(path.join(base, rel)), b = fs.statSync(live)
    if (a.size === b.size && sha(path.join(base, rel)) === sha(live)) res.same.push(rel); else res.different.push(rel)
  }
  const cut = (l) => l.slice(0, 40)
  return { id, archive: m.archive, counts: { new: res.new.length, same: res.same.length, different: res.different.length, blocked: res.blocked.length }, samples: { new: cut(res.new), different: cut(res.different), blocked: cut(res.blocked) } }
}

/** mode: "missing" (yalnız olmayanları ekle) | "overwrite" (farklıları da değiştir; eskileri geri-al klasörüne taşır). */
export function filesApply({ id, mode }, actor) {
  if (!["missing", "overwrite"].includes(mode)) throw new UserError("Geçersiz kip")
  const plan = filesPlan(id)
  const base = path.join(wsDir(id), "files")
  const undoDir = path.join(UNDO_ROOT, `${id}-dosyalar`)
  let added = 0, replaced = 0
  const copyIn = (rel) => {
    const src = path.join(base, rel), live = liveOf(rel), st = fs.statSync(src)
    fs.mkdirSync(path.dirname(live), { recursive: true })
    const tmp = live + `.restore-${id}`
    fs.copyFileSync(src, tmp); fs.chmodSync(tmp, st.mode & 0o7777)
    try { fs.chownSync(tmp, st.uid, st.gid) } catch {}
    fs.utimesSync(tmp, st.atime, st.mtime); fs.renameSync(tmp, live)
  }
  const all = walk(base)
  for (const rel of all) {
    const live = liveOf(rel); if (!live || !safeLive(live)) continue
    if (!fs.existsSync(live)) { copyIn(rel); added++; continue }
    if (mode === "overwrite" && plan.samples && (fs.statSync(live).size !== fs.statSync(path.join(base, rel)).size || sha(live) !== sha(path.join(base, rel)))) {
      const keep = path.join(undoDir, rel); fs.mkdirSync(path.dirname(keep), { recursive: true, mode: 0o700 })
      fs.copyFileSync(live, keep, fs.constants.COPYFILE_FICLONE); fs.utimesSync(keep, fs.statSync(live).atime, fs.statSync(live).mtime)
      copyIn(rel); replaced++
    }
  }
  if (replaced) fs.writeFileSync(path.join(undoDir, "README.txt"), `Geri alma: bu klasördeki dosyalar ${new Date().toISOString()} tarihinde ${actor} tarafından üzerine yazılmadan önce alınmış ESKİ sürümlerdir (14 gün saklanır).\nBir dosyayı eski haline döndürmek için: cp -a ${undoDir}/<yol> ${LIVE_FILES_ROOT}/<yol> (yol, 'var/www/addinvoice/data/uploads/' sonrasıdır).\n`, { mode: 0o600 })
  return { added, replaced, same: plan.counts.same, blocked: plan.counts.blocked, undoDir: replaced ? undoDir : null }
}

// ── Veritabanı: seçili tabloları geçici kopyadan canlıya aktar ───────────────────────────────────────────
const SENSITIVE = /(password|passwd|secret|token|api_?key|private_?key|hash)/i
const NAME = /^[a-z][a-z0-9_]{0,62}$/
// Kimlik/oturum/anahtar/denetim izi/gizli ayar tabloları canlıya OTOMATİK uygulanamaz (denetim izi yasal kontrol izidir; kimlik ve ayarlar elle yönetilir).
const DENY_TABLE = /^(users|sessions|trusted_devices|api_keys|pos_api_credentials|system_settings|settings|company_imap_settings|einvoice_consents|audit_logs.*|ek_audit_logs|time_clock_devices|ek_measuring_devices)$/
const qid = (n) => `"${n}"`
const liveSql = (q, vars = {}, input) => asPg("psql", ["-X", "-q", "-At", "-d", LIVE_DB, "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"], { input: input ?? q, timeout: 10 * 60_000 })

async function liveTableInfo(table) {
  const c = await liveSql(`select column_name from information_schema.columns where table_schema='public' and table_name=:'t' order by ordinal_position;`, { t: table })
  const cols = c.stdout.split("\n").filter(Boolean)
  if (!cols.length) throw new UserError(`Canlı veritabanında tablo yok: ${table}`)
  const k = await liveSql(`select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey) where i.indrelid = ('public.' || quote_ident(:'t'))::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum);`, { t: table })
  return { cols, pk: k.stdout.split("\n").filter(Boolean) }
}
async function tempCols(db, table) {
  const r = await sql(db, `select column_name from information_schema.columns where table_schema='public' and table_name=:'t' order by ordinal_position;`, { t: table })
  return r.stdout.split("\n").filter(Boolean)
}
async function fkOrder(tables) {
  const r = await liveSql(`select conrelid::regclass::text || '>' || confrelid::regclass::text from pg_constraint where contype='f';`)
  const norm = (x) => x.replace(/"/g, "").replace(/^public\./, "")
  const deps = new Map(tables.map((t) => [t, new Set()]))
  for (const l of r.stdout.split("\n").filter(Boolean)) {
    const [child, parent] = l.split(">").map(norm)
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent) // child, parent'a bağlı → parent önce
  }
  const order = []; const left = new Map([...deps].map(([k, v]) => [k, new Set(v)]))
  while (left.size) {
    const ready = [...left].filter(([, v]) => v.size === 0).map(([k]) => k).sort()
    if (!ready.length) throw new UserError("Seçili tablolar arasında döngüsel bağımlılık var: " + [...left.keys()].join(", "))
    for (const k of ready) { order.push(k); left.delete(k) }
    for (const v of left.values()) for (const k of ready) v.delete(k)
  }
  return order
}
const copyOut = (db, query, vars = {}) => new Promise((resolve, reject) => {
  const p = spawn("runuser", ["-u", "postgres", "--", "psql", "-X", "-q", "-d", db, "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"], { stdio: ["pipe", "pipe", "pipe"] })
  const chunks = []; let size = 0, err = ""
  p.stdout.on("data", (d) => { size += d.length; if (size > 150 * 1048576) { p.kill(); reject(new UserError("Seçim çok büyük (150 MB üstü)")) } else chunks.push(d) })
  p.stderr.on("data", (d) => { err += d.toString().slice(0, 500) })
  p.on("close", (c) => (c === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new UserError("Veri okunamadı: " + err.slice(0, 200)))))
  p.stdin.end(query)
})

/**
 * Seçili tabloları geçici kopyadan canlıya aktarır. dry=true → aynı işlem çalıştırılır ama sonunda GERİ ALINIR (plan: FK/kısıt hataları dahil görünür).
 * mode: "missing" → yalnız olmayan satırları ekler (ON CONFLICT DO NOTHING) · "overwrite" → olmayanları ekler + farklı satırları yedekteki hâline getirir
 * (üzerine yazılan canlı satırlar önce geri-al CSV'sine alınır).
 */
export async function dbApply({ id, tables, companyId, mode, dry }, actor) {
  checkId(id)
  const m = manifest(id); if (!m?.db) throw new UserError("Geçici veritabanı yok")
  if (!["missing", "overwrite"].includes(mode)) throw new UserError("Geçersiz kip")
  if (!Array.isArray(tables) || tables.length < 1 || tables.length > 20) throw new UserError("1-20 tablo seçin")
  if (tables.some((t) => !NAME.test(t))) throw new UserError("Geçersiz tablo adı")
  if (companyId && !UUIDISH.test(companyId)) throw new UserError("Geçersiz şirket kimliği")
  const s = await summary(id)
  const info = {}
  for (const t of tables) {
    if (!s.tables.some((x) => x.name === t)) throw new UserError(`Yedekte tablo yok: ${t}`)
    if (DENY_TABLE.test(t)) throw new UserError(`'${t}' kimlik/oturum/denetim izi/ayar tablosudur; canlıya otomatik uygulanamaz — elle yapılmalı`)
    const live = await liveTableInfo(t)
    const bad = live.cols.filter((c) => SENSITIVE.test(c))
    if (bad.length) throw new UserError(`'${t}' gizli alan içeriyor (${bad.join(", ")}); canlıya otomatik uygulanamaz — elle yapılmalı`)
    if (!live.pk.length) throw new UserError(`'${t}' tablosunda birincil anahtar yok; güvenle uygulanamaz`)
    const back = await tempCols(m.db, t)
    const common = live.cols.filter((c) => back.includes(c))
    if (!live.pk.every((k) => common.includes(k))) throw new UserError(`'${t}': birincil anahtar sütunları yedekte yok`)
    const missingInBackup = live.cols.filter((c) => !back.includes(c))
    info[t] = { ...live, common, missingInBackup, filter: companyId && s.companyTables.includes(t) }
  }
  const order = await fkOrder(tables)
  // 1) yedekten seçili satırları CSV olarak oku
  const data = {}
  let total = 0
  for (const t of order) {
    const i = info[t]
    const where = i.filter ? "where company_id = :'cid'" : ""
    data[t] = await copyOut(m.db, `copy (select ${i.common.map(qid).join(", ")} from public.${qid(t)} ${where}) to stdout with (format csv, header true);`, i.filter ? { cid: companyId } : {})
    if (/\n\\\.\n/.test(data[t])) throw new UserError("Veri güvenli biçimde aktarılamıyor (\\. satırı)")
    total += data[t].length
    if (total > 200 * 1048576) throw new UserError("Seçim çok büyük")
  }
  const cols = (t) => info[t].common.map(qid).join(", ")
  const pkEq = (t, a, b) => info[t].pk.map((k) => `${a}.${qid(k)} = ${b}.${qid(k)}`).join(" and ")
  const nonPk = (t) => info[t].common.filter((c) => !info[t].pk.includes(c))
  const same = (t, a, b) => nonPk(t).map((c) => `${a}.${qid(c)}::text`).join(", ")
  const stage = (t, n) => `create temp table stg_${n} as select ${cols(t)} from public.${qid(t)} with no data;\ncopy stg_${n} (${cols(t)}) from stdin with (format csv, header true);\n${data[t].endsWith("\n") ? data[t] : data[t] + "\n"}\\.\n`
  // 2) (overwrite) üzerine yazılacak canlı satırları geri-al klasörüne al
  let undoDir = null
  const results = []
  if (mode === "overwrite" && !dry) {
    undoDir = path.join(UNDO_ROOT, `${id}-veritabani`); fs.mkdirSync(undoDir, { recursive: true, mode: 0o700 })
    let n = 0
    for (const t of order) {
      if (!nonPk(t).length) continue
      n++
      const q = `begin;\n${stage(t, 1)}copy (select x.* from public.${qid(t)} x join stg_1 s on ${pkEq(t, "x", "s")} where (${same(t, "x")}) is distinct from (${same(t, "s")})) to stdout with (format csv, header true);\nrollback;\n`
      const out = await copyOut(LIVE_DB, q)
      if (out.trim().split("\n").length > 1) fs.writeFileSync(path.join(undoDir, `${t}.csv`), out, { mode: 0o600 })
    }
    fs.writeFileSync(path.join(undoDir, "README.txt"), `Geri alma: ${new Date().toISOString()} tarihinde ${actor} tarafından canlıya uygulanan geri yüklemeden ÖNCE, üzerine yazılan canlı satırların kopyası (tablo başına CSV; 14 gün saklanır).\nBir satırı eski haline döndürmek için bu CSV'den ilgili satırı seçip güncelleyin (veya yöneticiyle birlikte COPY/UPSERT).\n`, { mode: 0o600 })
    void n
  }
  // 3) tek işlemde uygula (dry ise sonunda geri al)
  let script = `begin;\nset local statement_timeout = '300s';\nset local lock_timeout = '15s';\n`
  order.forEach((t, n) => {
    script += stage(t, n + 1)
    const nc = nonPk(t)
    const target = `public.${qid(t)}`
    if (mode === "missing" || !nc.length) {
      script += `with i as (insert into ${target} (${cols(t)}) select ${cols(t)} from stg_${n + 1} on conflict (${info[t].pk.map(qid).join(", ")}) do nothing returning 1) select 'RES|${t}|' || (select count(*) from stg_${n + 1}) || '|' || count(*) || '|0' from i;\n`
    } else {
      const set = nc.map((c) => `${qid(c)} = excluded.${qid(c)}`).join(", ")
      const when = `(${nc.map((c) => `${target}.${qid(c)}::text`).join(", ")}) is distinct from (${nc.map((c) => `excluded.${qid(c)}::text`).join(", ")})`
      script += `with i as (insert into ${target} (${cols(t)}) select ${cols(t)} from stg_${n + 1} on conflict (${info[t].pk.map(qid).join(", ")}) do update set ${set} where ${when} returning (xmax = 0) as ins) select 'RES|${t}|' || (select count(*) from stg_${n + 1}) || '|' || count(*) filter (where ins) || '|' || count(*) filter (where not ins) from i;\n`
    }
  })
  let restorePoint = null
  if (!dry) {
    restorePoint = `pre_restore_${id}`
    const rp = await liveSql(`select pg_create_restore_point('${restorePoint}');`)
    if (rp.code !== 0) throw new UserError("Restore noktası konamadı: " + rp.stderr.slice(0, 200))
  }
  script += dry ? "rollback;\n" : "commit;\n"
  const r = await liveSql("", {}, script)
  if (r.code !== 0) throw new UserError("Uygulanamadı (işlem geri alındı): " + (r.stderr.split("\n").find((l) => /ERROR|DETAIL/.test(l)) ?? r.stderr).slice(0, 400))
  for (const l of r.stdout.split("\n")) if (l.startsWith("RES|")) { const [, table, backup, ins, upd] = l.split("|"); results.push({ table, backupRows: Number(backup), inserted: Number(ins), updated: Number(upd) }) }
  return { order, mode, dry: !!dry, results, restorePoint, undoDir, notes: order.filter((t) => info[t].missingInBackup.length).map((t) => `${t}: yedekte olmayan sütunlar (varsayılan değerle): ${info[t].missingInBackup.join(", ")}`) }
}

// ── Liste / temizlik ─────────────────────────────────────────────────────────
export function listWorkspaces() {
  if (!fs.existsSync(ROOT)) return []
  return fs.readdirSync(ROOT).filter((d) => ID_RE.test(d)).map((id) => manifest(id)).filter(Boolean).map((m) => ({ id: m.id, created: m.created, type: m.type, archive: m.archive, target: m.target, actor: m.actor, db: m.db ?? null })).sort((a, b) => b.created - a.created)
}
export async function destroy(id) {
  checkId(id)
  const m = manifest(id)
  if (m?.db) await asPg("dropdb", ["--if-exists", m.db])
  fs.rmSync(wsDir(id), { recursive: true, force: true })
  fs.rmSync(path.join(EXPORT_TMP, `restore-${id}`), { recursive: true, force: true })
  return "Çalışma alanı ve geçici veritabanı silindi"
}
export async function cleanupExpired(maxAgeMs = 24 * 3600_000) {
  let n = 0
  if (fs.existsSync(UNDO_ROOT)) for (const d of fs.readdirSync(UNDO_ROOT)) { const f = path.join(UNDO_ROOT, d); if (Date.now() - fs.statSync(f).mtimeMs > 14 * 24 * 3600_000) { fs.rmSync(f, { recursive: true, force: true }); n++ } }
  for (const w of listWorkspaces()) if (Date.now() - w.created > maxAgeMs) { await destroy(w.id).catch(() => {}); n++ }
  return n
}
