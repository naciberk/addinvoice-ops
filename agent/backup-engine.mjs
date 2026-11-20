#!/usr/bin/env node
/**
 * AddInvoice yedekleme motoru (20 Kas 2026) — görev/hedef yapılandırması, EasyCron tarzı zamanlayıcı, çalıştırıcı, sağlık kontrolü.
 *
 * Hem root ajanı (import) hem cron (CLI) kullanır. Bağımlılık yok. Yapılandırma: /etc/addinvoice-backup/config.json (root:root 600).
 * CLI:  backup-engine.mjs tick                  → her dakika cron'dan: zamanı gelen görevleri başlatır
 *       backup-engine.mjs run <jobId> [targetId] → bir görevi (tüm hedeflere ya da yalnız birine) şimdi çalıştırır
 *       backup-engine.mjs health                → JSON: her görev×hedef için {ok, detail}
 *       backup-engine.mjs next <jobId> [n]      → sonraki n çalışma zamanı
 * Depolar append-only (borg serve --append-only): bu motor ASLA arşiv silmez/budamaz.
 */
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import crypto from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export class UserError extends Error {}

// (AIB_* ortam değişkenleri yalnız testler içindir)
export const CONFIG_FILE = process.env.AIB_CONFIG || "/etc/addinvoice-backup/config.json"
export const STATE = process.env.AIB_STATE || "/var/lib/addinvoice-backup"
export const LOG_DIR = process.env.AIB_LOG || "/var/log/addinvoice-backup"
export const KEY_ROOT = process.env.AIB_KEYROOT || "/root/.config/addinvoice-backup"
const STAGE_ROOT = process.env.AIB_STAGE || "/var/backups/addinvoice-staging"
const LOCK_DIR = process.env.AIB_LOCK || "/run/addinvoice-backup"
const APP = "/var/www/addinvoice"
const SITE = "/var/www/addinvoice-site"
const OPS = "/var/www/addinvoice-ops"
const DB = "addinvoice_db"
const SELF = fileURLToPath(import.meta.url)

/** Seçilebilir dizin kökleri (yol listesine yalnız bunların altı girebilir). Yeni kök eklemek = bu dosyayı root olarak değiştirmek. */
export const ALLOWED_ROOTS = ["/var/www", "/etc", "/srv", "/home", "/opt", "/var/lib/addinvoice-ops", "/var/lib/addinvoice-backup", "/var/log/addinvoice-ops", "/usr/local", "/root/deploy-app.sh", "/root/.pm2/dump.pm2", "/var/spool/cron/crontabs", "/var/lib/pgbackrest", "/root/.claude/projects", "/mnt"]
export const JOB_TYPES = {
  uploads: "Bilag dosyaları (uploads)",
  code: "Site/uygulama dosyaları",
  db: "Tüm veritabanı",
  tables: "Önemli tablolar",
  server: "Sunucu ayarları + kurulu programlar",
  custom: "Özel yollar",
  verify: "Yedek doğrulama",
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────
export const run = (cmd, args, { timeout = 60_000, env, input, cwd } = {}) =>
  new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout, maxBuffer: 256 << 20, encoding: "utf8", env: env ?? process.env, cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 255) : 0, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
    if (input) p.stdin.end(input)
  })
const ensureDir = (d, mode = 0o750) => fs.mkdirSync(d, { recursive: true, mode })
const nowIso = () => new Date().toISOString()
const pad = (n) => String(n).padStart(2, "0")
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
function atomicWrite(file, content, mode = 0o600) {
  ensureDir(path.dirname(file))
  const tmp = file + ".tmp-" + process.pid
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return d } }
const ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/

// ══ Zamanlayıcı (EasyCron tarzı) ═════════════════════════════════════════════
const RANGE = { minutes: [0, 59], hours: [0, 23], months: [1, 12], dow: [0, 6], dom: [1, 31] }
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const intList = (arr, [lo, hi], label) => {
  if (!Array.isArray(arr) || arr.length === 0) throw new UserError(`${label}: en az bir değer seçin`)
  const out = [...new Set(arr.map((x) => Number(x)))]
  if (out.some((x) => !Number.isInteger(x) || x < lo || x > hi)) throw new UserError(`${label}: geçersiz değer (${lo}-${hi})`)
  return out.sort((a, b) => a - b)
}
const full = ([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

function parseCronField(txt, [lo, hi], names) {
  const set = new Set()
  for (const part of String(txt).toLowerCase().split(",")) {
    const m = part.match(/^(\*|\?|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/)
    if (!m) throw new UserError(`Cron alanı anlaşılamadı: "${part}"`)
    const val = (s) => { const i = names ? names.indexOf(s) : -1; return i >= 0 ? i + (names === MONTH_NAMES ? 1 : 0) : Number(s) }
    let a = lo, b = hi
    if (m[1] !== "*" && m[1] !== "?") {
      const [x, y] = m[1].split("-")
      a = val(x); b = y !== undefined ? val(y) : (m[2] ? hi : a)
    }
    const step = m[2] ? Number(m[2]) : 1
    if (![a, b, step].every(Number.isInteger) || step < 1) throw new UserError(`Cron alanı geçersiz: "${part}"`)
    if (a < lo || b > hi || a > b) throw new UserError(`Cron alanı aralık dışı: "${part}" (${lo}-${hi})`)
    for (let v = a; v <= b; v += step) set.add(v)
  }
  return [...set]
}

/** Üç girdi biçimini (every / cron / manual) tek, kesin biçime çevirir. */
export function normalizeSchedule(input) {
  if (!input || typeof input !== "object") throw new UserError("Zamanlama eksik")
  const kind = input.kind
  let s
  if (kind === "every") {
    const n = Number(input.n)
    const minute = input.minute === undefined ? 0 : Number(input.minute)
    const hour = input.hour === undefined ? 0 : Number(input.hour)
    if (input.unit === "minutes") {
      if (![1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30].includes(n)) throw new UserError("Dakika aralığı: 1,2,3,4,5,6,10,12,15,20,30")
      s = { minutes: full([0, 59]).filter((m) => m % n === 0), hours: full(RANGE.hours), months: full(RANGE.months), years: null, dom: null, dow: null }
    } else if (input.unit === "hours") {
      if (![1, 2, 3, 4, 6, 8, 12].includes(n)) throw new UserError("Saat aralığı: 1,2,3,4,6,8,12")
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new UserError("Dakika 0-59")
      s = { minutes: [minute], hours: full(RANGE.hours).filter((h) => h % n === 0), months: full(RANGE.months), years: null, dom: null, dow: null }
    } else if (input.unit === "days") {
      if (n !== 1) throw new UserError("Günlük çalışma için 'her 1 gün' seçin (başka sıklıklar için elle seçim)")
      if (![hour, minute].every(Number.isInteger) || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new UserError("Saat/dakika geçersiz")
      s = { minutes: [minute], hours: [hour], months: full(RANGE.months), years: null, dom: null, dow: null }
    } else throw new UserError("Birim: minutes, hours veya days")
  } else if (kind === "cron") {
    const f = String(input.expr ?? "").trim().split(/\s+/)
    if (f.length !== 5) throw new UserError("Cron ifadesi 5 alan olmalı: dakika saat gün ay haftanın-günü")
    const dom = f[2] === "*" || f[2] === "?" ? null : parseCronField(f[2], RANGE.dom)
    let dowTxt = f[4]
    const dowL = parseCronField(dowTxt, [0, 7], DOW_NAMES).map((x) => (x === 7 ? 0 : x))
    const dow = f[4] === "*" || f[4] === "?" ? null : [...new Set(dowL)]
    if (dom && dow) throw new UserError("Cron: gün ve haftanın günü birlikte kısıtlanamaz (standart cron bunları 'VEYA' sayar). Elle seçimi kullanın")
    s = {
      minutes: parseCronField(f[0], RANGE.minutes), hours: parseCronField(f[1], RANGE.hours),
      months: parseCronField(f[3], RANGE.months, MONTH_NAMES), years: null,
      dom: dom ? { days: dom } : null, dow: dow ? { days: dow } : null,
    }
  } else if (kind === "manual") {
    s = {
      minutes: input.minutes === "*" ? full(RANGE.minutes) : intList(input.minutes, RANGE.minutes, "Dakika"),
      hours: input.hours === "*" ? full(RANGE.hours) : intList(input.hours, RANGE.hours, "Saat"),
      months: input.months === "*" ? full(RANGE.months) : intList(input.months, RANGE.months, "Ay"),
      years: input.years === "*" || input.years == null ? null : intList(input.years, [2026, 2100], "Yıl"),
      dom: null, dow: null,
    }
    const d = input.dom ?? { mode: "all" }
    if (d.mode === "days") s.dom = { days: intList(d.days, RANGE.dom, "Gün") }
    else if (d.mode === "last") s.dom = { last: true }
    else if (d.mode !== "all") throw new UserError("Gün seçimi geçersiz")
    const w = input.dow ?? { mode: "all" }
    if (w.mode === "days") s.dow = { days: intList(w.days, RANGE.dow, "Haftanın günü") }
    else if (w.mode === "nth") {
      const n = Number(w.n), day = Number(w.day)
      if (![1, 2, 3, 4, 5, -1].includes(n) || !Number.isInteger(day) || day < 0 || day > 6) throw new UserError("Hafta günü sırası geçersiz")
      s.dow = { nth: { n, day } }
    } else if (w.mode !== "all") throw new UserError("Haftanın günü seçimi geçersiz")
  } else throw new UserError("Zamanlama türü: every, cron veya manual")
  s.source = { ...input }
  if (typeof s.source.expr === "string") s.source.expr = s.source.expr.slice(0, 120)
  return s
}

const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate()
function dayMatches(s, y, m0, d) {
  if (s.years && !s.years.includes(y)) return false
  if (!s.months.includes(m0 + 1)) return false
  if (s.dom) {
    if (s.dom.days && !s.dom.days.includes(d)) return false
    if (s.dom.last && d !== daysInMonth(y, m0)) return false
  }
  if (s.dow) {
    const wd = new Date(y, m0, d).getDay()
    if (s.dow.days && !s.dow.days.includes(wd)) return false
    if (s.dow.nth) {
      const { n, day } = s.dow.nth
      if (wd !== day) return false
      if (n > 0 ? Math.ceil(d / 7) !== n : d + 7 <= daysInMonth(y, m0)) return false
    }
  }
  return true
}
export const matchesNow = (s, d = new Date()) => dayMatches(s, d.getFullYear(), d.getMonth(), d.getDate()) && s.hours.includes(d.getHours()) && s.minutes.includes(d.getMinutes())

export function nextRuns(s, from = new Date(), count = 5) {
  const out = []
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < 366 * 6 && out.length < count; i++, day.setDate(day.getDate() + 1)) {
    if (!dayMatches(s, day.getFullYear(), day.getMonth(), day.getDate())) continue
    for (const h of s.hours) for (const m of s.minutes) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
      if (t > from && out.length < count) out.push(t)
    }
  }
  return out.sort((a, b) => a - b).slice(0, count)
}
/** `before` ve öncesindeki en son planlı zaman (yoksa null). */
export function prevRun(s, before = new Date()) {
  const day = new Date(before.getFullYear(), before.getMonth(), before.getDate())
  for (let i = 0; i < 800; i++, day.setDate(day.getDate() - 1)) {
    if (!dayMatches(s, day.getFullYear(), day.getMonth(), day.getDate())) continue
    for (const h of [...s.hours].reverse()) for (const m of [...s.minutes].reverse()) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
      if (t <= before) return t
    }
  }
  return null
}

// ══ Yapılandırma ═════════════════════════════════════════════════════════════
export function loadConfig() {
  return readJson(CONFIG_FILE, { version: 1, targets: [], jobs: [] })
}
const HOST_RE = /^(?!-)[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const REPO_RE = /^\/[A-Za-z0-9_.\/-]{1,200}$/

function checkPath(p) {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0") || p.split("/").includes("..") || path.normalize(p) !== p.replace(/\/+$/, "") && p !== "/") throw new UserError(`Geçersiz yol: ${String(p).slice(0, 80)}`)
  if (!ALLOWED_ROOTS.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"))) throw new UserError(`İzin verilen kökler dışında: ${p} (izinli: ${ALLOWED_ROOTS.join(", ")})`)
  return p
}

export function validateConfig(cfg, { keepSystem = true } = {}) {
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.targets) || !Array.isArray(cfg.jobs)) throw new UserError("Yapılandırma biçimi geçersiz")
  if (cfg.targets.length > 12 || cfg.jobs.length > 40) throw new UserError("Çok fazla hedef/görev")
  const tids = new Set()
  const targets = cfg.targets.map((t) => {
    if (!ID_RE.test(t.id ?? "")) throw new UserError("Hedef kimliği: küçük harf/rakam/-, en çok 30")
    if (tids.has(t.id)) throw new UserError("Hedef kimliği tekrarlanıyor: " + t.id)
    tids.add(t.id)
    const name = String(t.name ?? t.id).slice(0, 60)
    if (t.type === "ssh") {
      const port = Number(t.port ?? 22)
      if (!HOST_RE.test(t.host ?? "") || !USER_RE.test(t.user ?? "") || !REPO_RE.test(t.repoPath ?? "") || !Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`Hedef "${t.id}": sunucu/kullanıcı/depo yolu/port geçersiz`)
      return { id: t.id, name, type: "ssh", enabled: t.enabled !== false, host: t.host, port, user: t.user, repoPath: t.repoPath, credDir: t.credDir ? checkCred(t.credDir) : `${KEY_ROOT}/targets/${t.id}`, note: String(t.note ?? "").slice(0, 200) }
    }
    if (t.type === "path") {
      if (!REPO_RE.test(t.repoPath ?? "") || !checkPathOnly(t.repoPath)) throw new UserError(`Hedef "${t.id}": depo yolu geçersiz`)
      const mount = t.mountCheck ? String(t.mountCheck) : ""
      if (mount && !REPO_RE.test(mount)) throw new UserError(`Hedef "${t.id}": bağlama yolu geçersiz`)
      return { id: t.id, name, type: "path", enabled: t.enabled !== false, repoPath: t.repoPath, mountCheck: mount, credDir: t.credDir ? checkCred(t.credDir) : `${KEY_ROOT}/targets/${t.id}`, note: String(t.note ?? "").slice(0, 200) }
    }
    throw new UserError(`Hedef "${t.id}": tür ssh veya path olmalı`)
  })
  const jids = new Set()
  const jobs = cfg.jobs.map((j) => {
    if (!ID_RE.test(j.id ?? "")) throw new UserError("Görev kimliği: küçük harf/rakam/-, en çok 30")
    if (jids.has(j.id)) throw new UserError("Görev kimliği tekrarlanıyor: " + j.id)
    jids.add(j.id)
    if (!Object.hasOwn(JOB_TYPES, j.type)) throw new UserError(`Görev "${j.id}": bilinmeyen tür`)
    const tg = Array.isArray(j.targets) ? [...new Set(j.targets)] : []
    if (tg.some((x) => !tids.has(x))) throw new UserError(`Görev "${j.id}": bilinmeyen hedef`)
    const o = j.options ?? {}
    const options = {}
    if (j.type === "custom") {
      if (!Array.isArray(o.paths) || o.paths.length === 0 || o.paths.length > 50) throw new UserError(`Görev "${j.id}": en az bir yol seçin`)
      options.paths = o.paths.map(checkPath)
    }
    if (Array.isArray(o.excludes)) {
      if (o.excludes.length > 50 || o.excludes.some((e) => typeof e !== "string" || !e || e.length > 200 || /[\n\0]/.test(e))) throw new UserError(`Görev "${j.id}": hariç tutma desenleri geçersiz`)
      options.excludes = o.excludes
    }
    if (j.type === "tables") {
      const list = Array.isArray(o.tables) && o.tables.length ? o.tables : ["transactions", "transaction_payment_entries", "journals", "journal_entries"]
      if (list.length > 60 || list.some((t) => !/^[a-z][a-z0-9_]{0,62}$/.test(t))) throw new UserError(`Görev "${j.id}": tablo adları geçersiz`)
      options.tables = [...new Set(list)]
    }
    if (j.type === "db") options.includePgbackrest = o.includePgbackrest !== false
    if (j.type === "verify" && o.checkJobId != null) {
      if (!ID_RE.test(o.checkJobId)) throw new UserError("Doğrulanacak görev kimliği geçersiz")
      options.checkJobId = o.checkJobId
    }
    const schedule = normalizeSchedule(j.schedule?.source ?? j.schedule)
    return { id: j.id, name: String(j.name ?? JOB_TYPES[j.type]).slice(0, 80), type: j.type, enabled: j.enabled !== false, targets: tg, schedule, options, graceMin: Math.min(Math.max(Number(j.graceMin ?? 45), 5), 1440), createdAt: j.createdAt && !isNaN(Date.parse(j.createdAt)) ? j.createdAt : nowIso() }
  })
  void keepSystem
  return { version: 1, targets, jobs }
}
function checkCred(d) {
  if (typeof d !== "string" || !d.startsWith(KEY_ROOT) || d.includes("..") || !/^[A-Za-z0-9_.\/-]+$/.test(d)) throw new UserError("Kimlik bilgisi klasörü geçersiz")
  return d
}
function checkPathOnly(p) { return !p.split("/").includes("..") }

export function saveConfig(cfg, actor = "?") {
  const clean = validateConfig(cfg)
  ensureDir(path.dirname(CONFIG_FILE), 0o700)
  ensureDir(`${STATE}/config-history`, 0o700)
  if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, `${STATE}/config-history/config-${Date.now()}.json`)
  const old = fs.readdirSync(`${STATE}/config-history`).sort()
  for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.unlinkSync(`${STATE}/config-history/${f}`)
  atomicWrite(CONFIG_FILE, JSON.stringify({ ...clean, savedAt: nowIso(), savedBy: actor }, null, 2))
  return clean
}

// ══ Hedef erişimi ════════════════════════════════════════════════════════════
const credPaths = (t) => ({ key: `${t.credDir}/id_ed25519`, pass: `${t.credDir}/borg-passphrase`, known: `${t.credDir}/known_hosts` })
export function borgEnv(t) {
  const c = credPaths(t)
  const env = { ...process.env, BORG_PASSCOMMAND: `cat ${c.pass}`, BORG_RELOCATED_REPO_ACCESS_IS_OK: "no", BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: "no", BORG_EXIT_CODES: "legacy" }
  if (t.type === "ssh") {
    env.BORG_REPO = `ssh://${t.user}@${t.host}:${t.port}${t.repoPath}`
    env.BORG_RSH = `ssh -i ${c.key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${c.known} -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o ConnectTimeout=20`
  } else env.BORG_REPO = t.repoPath
  return env
}
async function mountOk(t) {
  if (t.type !== "path" || !t.mountCheck) return true
  return (await run("mountpoint", ["-q", t.mountCheck])).code === 0
}

export async function targetTest(t) {
  const steps = []
  const add = (name, ok, detail) => steps.push({ name, ok, detail })
  const c = credPaths(t)
  if (!fs.existsSync(c.pass)) add("Parola dosyası", false, "Hedef için parola üretilmemiş")
  if (t.type === "ssh") {
    const reach = await new Promise((resolve) => { const s = net.connect({ host: t.host.replace(/^\[|\]$/g, ""), port: t.port, timeout: 6000 }); s.on("connect", () => { s.destroy(); resolve(true) }); s.on("error", () => resolve(false)); s.on("timeout", () => { s.destroy(); resolve(false) }) })
    add("Ağ erişimi", reach, reach ? `${t.host}:${t.port} açık` : `${t.host}:${t.port} ulaşılamıyor (güvenlik duvarı/IP izni?)`)
    if (!reach) return steps
    add("Anahtar dosyası", fs.existsSync(c.key), fs.existsSync(c.key) ? "var" : "özel anahtar yok")
    add("Sunucu parmak izi kayıtlı", fs.existsSync(c.known), fs.existsSync(c.known) ? "kayıtlı" : "known_hosts yok")
  } else {
    add("Bağlı klasör", await mountOk(t), t.mountCheck ? `${t.mountCheck} bağlı mı` : "bağlama denetimi kapalı")
    add("Depo klasörü", fs.existsSync(path.dirname(t.repoPath)), path.dirname(t.repoPath))
  }
  if (steps.some((s) => !s.ok)) return steps
  const r = await run("borg", ["info", "--json"], { env: borgEnv(t), timeout: 60_000 })
  if (r.code === 0) {
    let j = {}; try { j = JSON.parse(r.stdout) } catch {}
    add("Depo erişimi", true, `şifreli depo açıldı (${j.cache?.stats?.unique_csize != null ? Math.round(j.cache.stats.unique_csize / 1048576) + " MB" : "boş"})`)
  } else add("Depo erişimi", false, /does not exist|Repository .* does not exist/i.test(r.stderr) ? "Depo henüz oluşturulmamış (başlat düğmesi)" : r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  return steps
}

export async function targetInit(t) {
  if (!(await mountOk(t))) throw new UserError("Bağlı klasör görünmüyor")
  const r = await run("borg", ["init", "--encryption=repokey-blake2", ...(t.type === "path" ? ["--make-parent-dirs"] : ["--make-parent-dirs"])], { env: borgEnv(t), timeout: 120_000 })
  if (r.code !== 0) throw new UserError("Depo oluşturulamadı: " + r.stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400))
  return "Şifreli depo oluşturuldu"
}

/** Yeni hedef için anahtar + parola üretir; ağ hedefi için sunucu parmak izini okur ve kurulum komutlarını döndürür. Parola YALNIZ burada döner. */
export async function targetCreateCreds(t) {
  const c = credPaths(t)
  ensureDir(t.credDir, 0o700)
  const out = { publicKey: null, fingerprint: null, passphrase: null, setup: "" }
  if (!fs.existsSync(c.pass)) {
    const pass = crypto.randomBytes(36).toString("base64")
    fs.writeFileSync(c.pass, pass, { mode: 0o400 })
    out.passphrase = pass
  }
  if (t.type === "ssh") {
    if (!fs.existsSync(c.key)) {
      const r = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `addinvoice-backup-${t.id}@${(await run("hostname", [])).stdout.trim()}`, "-f", c.key, "-q"])
      if (r.code !== 0) throw new UserError("Anahtar üretilemedi")
    }
    out.publicKey = fs.readFileSync(c.key + ".pub", "utf8").trim()
    const ks = await run("ssh-keyscan", ["-T", "8", "-t", "ed25519", "-p", String(t.port), t.host.replace(/^\[|\]$/g, "")])
    if (ks.stdout.trim()) {
      fs.writeFileSync(c.known, ks.stdout, { mode: 0o600 })
      out.fingerprint = (await run("ssh-keygen", ["-lf", c.known])).stdout.trim()
    }
  }
  out.setup = setupInstructions(t, out.publicKey)
  return out
}

export function setupInstructions(t, pub) {
  if (t.type === "path") {
    return [
      "# Bağlı klasör hedefi (NAS paylaşımı / USB disk / ayrı disk)",
      "# 1) NAS'ta bu sunucu için ayrı bir kullanıcı ve paylaşım oluştur (yönetici hesabı DEĞİL), paylaşımda NAS ANLIK GÖRÜNTÜLERİ (snapshot) aç.",
      "#    Bu tür hedefte append-only koruma YOKTUR: fidye yazılımı bağlı klasördeki yedekleri silebilir; snapshot bu yüzden şart.",
      "# 2) Bu sunucuya bağla (örnek SMB; kimlik dosyası yalnız root okuyabilir):",
      "apt-get install -y cifs-utils",
      "install -d -m 700 /mnt/nas-backup",
      "printf 'username=KULLANICI\\npassword=PAROLA\\n' > /root/.nas-credentials && chmod 600 /root/.nas-credentials",
      "echo '//NAS-ADRESI/paylasim /mnt/nas-backup cifs credentials=/root/.nas-credentials,vers=3.0,_netdev,nofail 0 0' >> /etc/fstab && mount -a",
      "mountpoint /mnt/nas-backup   # 'is a mountpoint' demeli",
      `# 3) Hedef ayarında depo yolu: ${t.repoPath}  ve 'bağlama denetimi': /mnt/nas-backup (bağlı değilse yedek yerel diske YAZILMAZ)`,
      "# 4) Aşağıdaki ADIMDA 'Depoyu başlat' düğmesine bas.",
    ].join("\n")
  }
  const repoDir = path.posix.dirname(t.repoPath)
  return [
    `# Hedef sunucuda (${t.host}) root olarak, bir kez:`,
    `adduser --disabled-password --gecos "AddInvoice borg backup" ${t.user}`,
    `install -d -m 700 -o ${t.user} -g ${t.user} ${repoDir}`,
    `install -d -m 700 -o ${t.user} -g ${t.user} /home/${t.user}/.ssh`,
    `apt-get install -y borgbackup && borg --version   # (NAS'ta: Synology/QNAP paket merkezi, Docker veya Entware ile borg kur)`,
    `cat > /home/${t.user}/.ssh/authorized_keys <<'KEY'`,
    `command="borg serve --append-only --restrict-to-path ${repoDir}",restrict ${pub ?? "<genel anahtar>"}`,
    `KEY`,
    `chown ${t.user}:${t.user} /home/${t.user}/.ssh/authorized_keys && chmod 600 /home/${t.user}/.ssh/authorized_keys`,
    `grep -i "^AllowUsers\\|^AllowGroups" /etc/ssh/sshd_config   # satır çıkarsa '${t.user}' ekle`,
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub          # parmak izi panelde gösterilenle AYNI olmalı`,
    `# Güvenlik duvarı: bu sunucunun IP adresinin SSH portuna (${t.port}) erişmesine izin ver.`,
    `# Sonra panelde 'Bağlantıyı sına' ve 'Depoyu başlat'.`,
  ].join("\n")
}

// ══ Çalıştırıcı ══════════════════════════════════════════════════════════════
const statusFile = (job, target) => `${STATE}/status/${job}.${target}.json`
function writeStatus(job, t, patch) {
  const f = statusFile(job.id, t.id)
  const prev = readJson(f, {})
  const next = { ...prev, ...patch, job: job.id, target: t.id }
  if (patch.ok) next.lastOkAt = patch.finishedAt
  atomicWrite(f, JSON.stringify(next), 0o640)
  if (patch.ok === undefined) return // 'çalışıyor' güncellemesi geçmişe yazılmaz
  try {
    const h = `${STATE}/history.jsonl`
    fs.appendFileSync(h, JSON.stringify({ ts: nowIso(), job: job.id, target: t.id, ok: patch.ok, rc: patch.rc, durationSec: patch.durationSec, archive: patch.archive, sizes: patch.sizes, message: patch.message }) + "\n", { mode: 0o640 })
    const lines = fs.readFileSync(h, "utf8").split("\n").filter(Boolean)
    if (lines.length > 6000) fs.writeFileSync(h, lines.slice(-4000).join("\n") + "\n", { mode: 0o640 })
  } catch {}
}
const logger = (jobId) => { ensureDir(LOG_DIR); const f = `${LOG_DIR}/${jobId}.log`; return (m) => fs.appendFileSync(f, `[${new Date().toLocaleString("sv-SE")}] ${m}\n`) }

function dumpTo(file, user, cmd, args) {
  return new Promise((resolve) => {
    const fd = fs.openSync(file, "w", 0o600)
    const p = spawn("runuser", ["-u", user, "--", cmd, ...args], { stdio: ["ignore", fd, "pipe"] })
    let err = ""
    p.stderr.on("data", (d) => { err += d })
    p.on("close", (code) => { fs.closeSync(fd); resolve({ code, err }) })
  })
}

/** Görev türüne göre arşivlenecek yolları ve hariç tutmaları hazırlar (gerekirse hazırlık klasörüne dökümler üretir). */
async function prepare(job, stage, log) {
  const ex = [...(job.options.excludes ?? [])]
  const common = ["*/node_modules", `${APP}/.next*`, `${SITE}/.next*`, `${OPS}/.next*`]
  switch (job.type) {
    case "uploads": return { paths: [`${APP}/data/uploads`], excludes: ex }
    case "code": return { paths: [APP, SITE, OPS], excludes: [...common, `${APP}/data/uploads`, "*/.env", "*/.env.*", "*/.git/objects/pack/*.tmp", ...ex] }
    case "db": {
      let rc = 0
      const a = await dumpTo(`${stage}/db-full.dump`, "postgres", "pg_dump", ["-Fc", DB]); if (a.code !== 0) { log("pg_dump: " + a.err.slice(0, 300)); rc = 2 }
      const b = await dumpTo(`${stage}/globals.sql`, "postgres", "pg_dumpall", ["--globals-only"]); if (b.code !== 0) { log("pg_dumpall: " + b.err.slice(0, 300)); rc = 2 }
      if (rc) throw new Error("Veritabanı dökümü alınamadı")
      const ok = (await run("pg_restore", ["-l", `${stage}/db-full.dump`])).code === 0
      if (!ok) throw new Error("Döküm okunamıyor (pg_restore -l)")
      return { paths: [stage, ...(job.options.includePgbackrest ? ["/var/lib/pgbackrest"] : [])], excludes: ex }
    }
    case "tables": {
      const have = new Set((await run("runuser", ["-u", "postgres", "--", "psql", "-X", "-At", "-d", DB, "-c", "select tablename from pg_tables where schemaname='public'"])).stdout.split("\n").filter(Boolean))
      const miss = job.options.tables.filter((t) => !have.has(t))
      if (miss.length) throw new Error("Tablo(lar) yok: " + miss.join(", "))
      const r = await dumpTo(`${stage}/tables.dump`, "postgres", "pg_dump", ["-Fc", ...job.options.tables.flatMap((t) => ["-t", `public.${t}`]), DB])
      if (r.code !== 0) throw new Error("Tablo dökümü alınamadı: " + r.err.slice(0, 300))
      const n = (await run("pg_restore", ["-l", `${stage}/tables.dump`])).stdout.split("\n").filter((l) => l.includes("TABLE DATA")).length
      if (n < job.options.tables.length) throw new Error(`Döküm eksik: ${n}/${job.options.tables.length} tablo verisi`)
      return { paths: [stage], excludes: ex }
    }
    case "server": {
      const list = {
        "dpkg-selections.txt": ["dpkg", ["--get-selections"]], "apt-manual.txt": ["apt-mark", ["showmanual"]], "npm-global.txt": ["npm", ["ls", "-g", "--depth=0"]],
        "versions.txt": ["sh", ["-c", "echo node $(node -v); echo npm $(npm -v); echo pm2 $(pm2 -v 2>/dev/null); psql --version; pgbackrest version; borg --version; nginx -v 2>&1; lsb_release -ds; uname -a"]],
        "pm2-jlist.json": ["pm2", ["jlist"]], "root-crontab.txt": ["crontab", ["-l"]], "ufw-status.txt": ["ufw", ["status", "verbose"]],
        "systemd-enabled.txt": ["systemctl", ["list-unit-files", "--state=enabled", "--no-pager"]], "disks.txt": ["sh", ["-c", "lsblk -o NAME,SIZE,TYPE,MOUNTPOINT; df -h; cat /proc/mdstat 2>/dev/null"]],
        "pg-clusters.txt": ["pg_lsclusters", []], "listening-ports.txt": ["ss", ["-tlnp"]],
      }
      for (const [name, [cmd, args]] of Object.entries(list)) { const r = await run(cmd, args, { timeout: 30_000 }); fs.writeFileSync(`${stage}/${name}`, r.stdout || r.stderr, { mode: 0o600 }) }
      const paths = [stage, "/etc", "/var/spool/cron/crontabs", "/usr/local/bin", "/usr/local/sbin", "/root/deploy-app.sh", "/root/.pm2/dump.pm2"]
      return { paths: paths.filter((p) => p === stage || fs.existsSync(p)), excludes: ex }
    }
    case "custom": return { paths: job.options.paths.filter((p) => fs.existsSync(p)), excludes: ex }
    default: throw new Error("Bu tür çalıştırılamaz: " + job.type)
  }
}

function parseBorgStats(stdout) {
  try { const j = JSON.parse(stdout); const s = j.archive?.stats; return s ? { original: s.original_size, compressed: s.compressed_size, deduplicated: s.deduplicated_size, files: s.nfiles } : null } catch { return null }
}

async function runVerify(job, t, cfg, log) {
  const env = borgEnv(t)
  const chk = await run("borg", ["check", "--last", "5"], { env, timeout: 30 * 60_000 })
  if (chk.code > 1) throw new Error("borg check başarısız: " + chk.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  const srcJob = cfg.jobs.find((j) => j.id === job.options.checkJobId) ?? cfg.jobs.find((j) => j.type === "tables" && j.targets.includes(t.id)) ?? cfg.jobs.find((j) => j.type === "db" && j.targets.includes(t.id))
  if (!srcJob) return "Depo bütünlüğü tamam (okunabilirlik testi için tables/db görevi yok)"
  const last = (await run("borg", ["list", "--short", "--glob-archives", `${srcJob.id}-*`, "--last", "1"], { env })).stdout.trim()
  if (!last) throw new Error(`"${srcJob.id}" için arşiv yok`)
  const tmp = fs.mkdtempSync(`${STAGE_ROOT}/verify-`)
  try {
    const ex = await run("borg", ["extract", `::${last}`], { env, cwd: tmp, timeout: 30 * 60_000 })
    if (ex.code > 1) throw new Error("Arşiv açılamadı: " + ex.stderr.slice(-200))
    const dump = (await run("find", [tmp, "-name", "*.dump"])).stdout.split("\n").filter(Boolean)[0]
    if (!dump) throw new Error("Arşivde .dump yok")
    const n = (await run("pg_restore", ["-l", dump])).stdout.split("\n").filter((l) => l.includes("TABLE DATA")).length
    if (n < 1) throw new Error("Döküm okunamadı")
    return `Depo bütünlüğü tamam; ${last} okunur (${n} tablo verisi)`
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

function lock(name) {
  ensureDir(LOCK_DIR, 0o700)
  const f = `${LOCK_DIR}/${name}.lock`
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(f, "wx", 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(f) } catch {} } } catch {
      const pid = Number(fs.readFileSync(f, "utf8"))
      try { process.kill(pid, 0); return null } catch { try { fs.unlinkSync(f) } catch {} }
    }
  }
  return null
}

export async function runJob(jobId, onlyTarget) {
  const cfg = loadConfig()
  const job = cfg.jobs.find((j) => j.id === jobId)
  if (!job) throw new UserError("Görev yok: " + jobId)
  const log = logger(job.id)
  const targets = cfg.targets.filter((t) => job.targets.includes(t.id) && t.enabled && (!onlyTarget || t.id === onlyTarget))
  if (targets.length === 0) { log("çalıştırılacak etkin hedef yok"); return [] }
  const release = lock(job.id)
  if (!release) { log("zaten çalışıyor, atlandı"); return [{ target: "-", ok: true, message: "zaten çalışıyor" }] }
  const results = []
  ensureDir(STAGE_ROOT, 0o700)
  const stage = `${STAGE_ROOT}/${job.id}` // sabit yol: borg dosya önbelleği/tekilleştirme için (kilit tek çalışmayı garanti eder)
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { mode: 0o700 })
  try {
    let prep = null, prepErr = null
    if (job.type !== "verify") { try { prep = await prepare(job, stage, log) } catch (e) { prepErr = e.message } }
    for (const t of targets) {
      const start = Date.now()
      const archive = `${job.id}-${stamp()}`
      writeStatus(job, t, { running: true, startedAt: Math.floor(start / 1000) })
      let ok = false, rc = 2, message = "", sizes = null
      try {
        if (prepErr) throw new Error(prepErr)
        if (!(await mountOk(t))) throw new Error(`Bağlı klasör yok: ${t.mountCheck} (yedek yerel diske yazılmadı)`)
        if (job.type === "verify") { message = await runVerify(job, t, cfg, log); ok = true; rc = 0 } else {
          const args = ["create", "--json", "--compression", "zstd,3", ...prep.excludes.flatMap((e) => ["--exclude", e]), `::${archive}`, ...prep.paths]
          const r = await run("borg", args, { env: borgEnv(t), timeout: 6 * 3600_000 })
          rc = r.code
          if (r.code > 1) throw new Error(r.stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400) || "borg hata kodu " + r.code)
          sizes = parseBorgStats(r.stdout); ok = true; message = r.code === 1 ? "tamam (uyarı: dosya yedek sırasında değişti)" : "tamam"
          if (r.stderr.trim()) log(r.stderr.trim().split("\n").slice(-5).join(" | "))
        }
      } catch (e) { message = e.message; log(`HATA [${t.id}]: ${message}`) }
      const finishedAt = Math.floor(Date.now() / 1000)
      writeStatus(job, t, { running: false, ok, rc, finishedAt, durationSec: finishedAt - Math.floor(start / 1000), archive: job.type === "verify" ? null : archive, sizes, message })
      log(`${ok ? "OK" : "HATA"} [${t.id}] ${message}${sizes ? ` (${Math.round(sizes.original / 1048576)} MB → ${Math.round(sizes.deduplicated / 1048576)} MB)` : ""}`)
      results.push({ target: t.id, ok, message })
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); release() }
  return results
}

/** Zamanı gelen görevleri ayrı süreç olarak başlatır (dakikada bir). */
export function tick(now = new Date()) {
  const cfg = loadConfig()
  const started = []
  const key = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
  for (const job of cfg.jobs) {
    if (!job.enabled || !job.targets.length || !matchesNow(job.schedule, now)) continue
    const mark = `${STATE}/ticks/${job.id}`
    ensureDir(`${STATE}/ticks`)
    if (fs.existsSync(mark) && fs.readFileSync(mark, "utf8") === key) continue
    fs.writeFileSync(mark, key)
    spawnJob(job.id)
    started.push(job.id)
  }
  return started
}
export function spawnJob(jobId, targetId) {
  ensureDir(LOG_DIR)
  const out = fs.openSync(`${LOG_DIR}/${jobId}.log`, "a")
  const p = spawn(process.execPath, [SELF, "run", jobId, ...(targetId ? [targetId] : [])], { detached: true, stdio: ["ignore", out, out] })
  p.unref()
}

// ══ Durum / sağlık ═══════════════════════════════════════════════════════════
/** Görevin hangi kaynakları yedeklediğini insan diliyle döndürür (arayüzde gösterilir). */
export function describeSources(job) {
  const ex = job.options?.excludes?.length ? [` (hariç: ${job.options.excludes.join(", ")})`] : []
  switch (job.type) {
    case "uploads": return [`${APP}/data/uploads`, ...ex]
    case "code": return [APP, SITE, OPS, "(node_modules, derleme çıktıları, .env dosyaları ve uploads hariç)"]
    case "db": return [`PostgreSQL veritabanı ${DB}: tam döküm + roller`, ...(job.options?.includePgbackrest ? ["/var/lib/pgbackrest (pgBackRest deposu)"] : [])]
    case "tables": return (job.options?.tables ?? []).map((t) => `tablo: ${t}`)
    case "server": return ["/etc", "/var/spool/cron/crontabs", "/usr/local/bin", "/usr/local/sbin", "/root/deploy-app.sh", "/root/.pm2/dump.pm2", "+ paket/sürüm listeleri, pm2, ufw, systemd, disk/port bilgisi"]
    case "custom": return [...(job.options?.paths ?? []), ...ex]
    case "verify": return ["depo bütünlüğü + son dökümün okunabilirliği (veri yedeklemez)"]
    default: return []
  }
}
export function targetLocation(t) {
  return t.type === "ssh" ? `ssh://${t.user}@${t.host}:${t.port}${t.repoPath}` : `${t.repoPath}${t.mountCheck ? `  (bağlama: ${t.mountCheck})` : ""}`
}

export function overview(now = new Date()) {
  const cfg = loadConfig()
  const jobs = cfg.jobs.map((j) => {
    const st = cfg.targets.filter((t) => j.targets.includes(t.id)).map((t) => ({ target: t.id, ...readJson(statusFile(j.id, t.id), {}) }))
    return { ...j, sources: describeSources(j), next: nextRuns(j.schedule, now, 3).map((d) => d.toISOString()), last: prevRun(j.schedule, now)?.toISOString() ?? null, status: st }
  })
  return { targets: cfg.targets.map((t) => ({ ...t, location: targetLocation(t) })), jobs, typeNames: JOB_TYPES, allowedRoots: ALLOWED_ROOTS, savedAt: cfg.savedAt ?? null, savedBy: cfg.savedBy ?? null }
}

export function health(now = new Date()) {
  const cfg = loadConfig()
  const out = []
  for (const j of cfg.jobs) {
    if (!j.enabled) continue
    const slot = prevRun(j.schedule, now)
    for (const t of cfg.targets.filter((x) => j.targets.includes(x.id) && x.enabled)) {
      const st = readJson(statusFile(j.id, t.id), null)
      const key = `backup:${j.id}:${t.id}`
      const label = `Yedek: ${j.name} → ${t.name}`
      if (st?.running && Date.now() / 1000 - (st.startedAt ?? 0) < 6 * 3600) { out.push({ key, label, ok: true, detail: "şu an çalışıyor", severity: "warn" }); continue }
      if (st && st.ok === false) { out.push({ key, label, ok: false, detail: `SON YEDEK BAŞARISIZ: ${st.message ?? ""} (günlük: ${LOG_DIR}/${j.id}.log)`.slice(0, 300), severity: "warn" }); continue }
      const lastOk = st?.lastOkAt ? st.lastOkAt * 1000 : 0
      const overdue = slot && now.getTime() - slot.getTime() > j.graceMin * 60_000 && lastOk < slot.getTime() - 60_000 && slot.getTime() > Date.parse(j.createdAt)
      out.push({ key, label, ok: !overdue, detail: overdue ? `planlı ${slot.toLocaleString("sv-SE")} yedeği alınmadı (zamanlayıcı/ağ?)` : lastOk ? `son başarılı yedek ${((now.getTime() - lastOk) / 3600_000).toFixed(1)} sa önce` : "henüz ilk planlı çalışma gelmedi", severity: "warn" })
    }
  }
  return out
}

export async function listArchives(t, jobId, limit = 15) {
  const args = ["list", "--format", "{archive}\t{time}\t{id}{NL}", ...(jobId ? ["--glob-archives", `${jobId}-*`] : []), "--last", String(limit)]
  const r = await run("borg", args, { env: borgEnv(t), timeout: 120_000 })
  if (r.code > 1) throw new UserError("Arşivler okunamadı: " + r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300))
  const rows = r.stdout.split("\n").filter(Boolean).map((l) => { const [name, time] = l.split("\t"); return { name, time } }).reverse()
  const info = await run("borg", ["info", "--json"], { env: borgEnv(t), timeout: 120_000 })
  let total = null; try { total = JSON.parse(info.stdout).cache.stats } catch {}
  return { archives: rows, totalOriginal: total?.total_size ?? null, totalUniqueCompressed: total?.unique_csize ?? null }
}

export async function listTables() {
  const r = await run("runuser", ["-u", "postgres", "--", "psql", "-X", "-At", "-d", DB, "-c", "select tablename from pg_tables where schemaname='public' order by 1"])
  return r.stdout.split("\n").filter(Boolean)
}

export function browse(dir) {
  if (dir === "/" || dir == null) return ALLOWED_ROOTS.map((r) => ({ name: r, path: r, dir: !/\.(pm2|sh)|dump\.pm2$/.test(r) && r !== "/root/deploy-app.sh" }))
  const p = checkPath(String(dir))
  const st = fs.statSync(p)
  if (!st.isDirectory()) return []
  return fs.readdirSync(p, { withFileTypes: true }).slice(0, 400).map((e) => ({ name: e.name, path: path.join(p, e.name), dir: e.isDirectory() })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

// ══ CLI ══════════════════════════════════════════════════════════════════════
if (process.argv[1] === SELF) {
  const [cmd, a, b] = process.argv.slice(2)
  try {
    if (cmd === "tick") { const s = tick(); if (s.length) console.log(`[${new Date().toLocaleString("sv-SE")}] başlatıldı: ${s.join(", ")}`) }
    else if (cmd === "run") { const r = await runJob(a, b); process.exit(r.every((x) => x.ok) ? 0 : 2) }
    else if (cmd === "borg") { // borg <hedef|-> <borg argümanları…>: o hedefin deposu/parolası/anahtarıyla borg çalıştırır (geri yükleme için)
      const cfg = loadConfig(); const t = a === "-" ? cfg.targets.find((x) => x.enabled) : cfg.targets.find((x) => x.id === a)
      if (!t) throw new UserError("Hedef bulunamadı: " + a)
      const r = spawn("borg", process.argv.slice(4), { env: borgEnv(t), stdio: "inherit" })
      r.on("exit", (c) => process.exit(c ?? 1)); await new Promise(() => {})
    }
    else if (cmd === "health") console.log(JSON.stringify(health(), null, 2))
    else if (cmd === "next") console.log(nextRuns(loadConfig().jobs.find((j) => j.id === a).schedule, new Date(), Number(b) || 5).map((d) => d.toLocaleString("sv-SE")).join("\n"))
    else { console.error("Kullanım: tick | run <job> [target] | health | next <job> [n] | borg <hedef|-> <borg args…>"); process.exit(64) }
  } catch (e) { console.error(e.message); process.exit(1) }
}
