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
  for (const w of listWorkspaces()) if (Date.now() - w.created > maxAgeMs) { await destroy(w.id).catch(() => {}); n++ }
  return n
}
