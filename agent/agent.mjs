#!/usr/bin/env node
/**
 * AddInvoice Ops — root ajanı (26 Ekim 2026).
 *
 * Web uygulaması (kullanıcı addinvoice-ops, root DEĞİL) buraya bir unix soketi üzerinden SADECE aşağıdaki izin listesindeki
 * eylemleri ister. Ajan: (1) HMAC imzasını + zaman damgasını doğrular, (2) eylem adını ve parametre biçimini KENDİ doğrular,
 * (3) komutu kabuk olmadan (execFile) çalıştırır, (4) her isteği kendi root-sahipli denetim kaydına yazar (web uygulaması
 * bu dosyayı DEĞİŞTİREMEZ). Web uygulaması ele geçirilse bile yapabileceği şey bu listeyle sınırlıdır.
 *
 * Bağımlılık yok (yalnız node yerleşikleri). Yapılandırma: /etc/addinvoice-ops/env (root:addinvoice-ops 640).
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile, spawn } from "node:child_process"
import * as BE from "./backup-engine.mjs"
import * as RE from "./restore-engine.mjs"

// ── Ortam ────────────────────────────────────────────────────────────────────
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1")
    }
  } catch {}
}
loadEnv("/etc/addinvoice-ops/env")

const SOCKET = process.env.OPS_AGENT_SOCKET || "/run/addinvoice-ops/agent.sock"
const SECRET = process.env.OPS_SESSION_SECRET || ""
const DL_DIR = process.env.OPS_DOWNLOAD_DIR || "/var/lib/addinvoice-ops/downloads"
const AUDIT = "/var/log/addinvoice-ops/agent-audit.jsonl"
const DB = "addinvoice_db"
const STANZA = "addinvoice"
const MAIN_APP = "/var/www/addinvoice"
const EXPORT_TMP = "/var/backups/addinvoice-companies"
const WEB_USER = "addinvoice-ops"
const HEALTH_DIR = "/var/log/addinvoice-db-health"
if (SECRET.length < 32) {
  console.error("OPS_SESSION_SECRET eksik")
  process.exit(1)
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────
const sh = (cmd, args, { timeout = 30_000, input } = {}) =>
  new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout, maxBuffer: 16 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
    if (input) p.stdin.end(input)
  })

const asPg = (cmd, args, opts) => sh("runuser", ["-u", "postgres", "--", cmd, ...args], opts)
const psql = (sql, opts) => asPg("psql", ["-X", "-At", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", sql], opts)

function auditLine(e) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true, mode: 0o750 })
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o640 })
  } catch (err) {
    console.error("audit yazılamadı", err)
  }
}

const RANK = { viewer: 1, operator: 2, admin: 3 }
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

// ── İş (job) yönetimi: uzun işler arka planda, aynı anda tek mutasyon işi ────
const jobs = new Map()
let busy = null
function newJob(kind, label, actor) {
  const id = crypto.randomBytes(6).toString("hex")
  const job = { id, kind, label, actor, state: "running", startedAt: Date.now(), endedAt: null, log: [], result: null, secret: null, secretDelivered: false }
  jobs.set(id, job)
  if (jobs.size > 50) {
    const old = [...jobs.values()].filter((j) => j.state !== "running").sort((a, b) => a.startedAt - b.startedAt)[0]
    if (old) jobs.delete(old.id)
  }
  return job
}
const jlog = (job, line) => {
  job.log.push(String(line).slice(0, 400))
  if (job.log.length > 60) job.log.shift()
}
function runJob(kind, label, actor, fn) {
  if (busy) throw new UserError(`Başka bir iş çalışıyor: ${busy.label}. Bitmesini bekle.`)
  const job = newJob(kind, label, actor)
  busy = job
  ;(async () => {
    try {
      const result = await fn(job)
      job.state = "done"
      job.result = result ?? null
    } catch (e) {
      job.state = "failed"
      job.result = String(e?.message ?? e).slice(0, 600)
    } finally {
      job.endedAt = Date.now()
      busy = null
      auditLine({ kind: "job-end", job: job.id, action: kind, label, actor: actor.email, state: job.state })
    }
  })()
  return { jobId: job.id }
}
const UserError = BE.UserError

// ── Eylemler ─────────────────────────────────────────────────────────────────
const UNITS = ["postgresql@16-main", "pgbouncer", "nginx", "pm2-root", "addinvoice-ops", "addinvoice-ops-agent"]
const LOGS = {
  app_error: { file: "/root/.pm2/logs/addinvoice-error.log", label: "Uygulama (hata)" },
  app_out: { file: "/root/.pm2/logs/addinvoice-out.log", label: "Uygulama (çıktı)" },
  nginx_error: { file: "/var/log/nginx/error.log", label: "nginx (hata)" },
  postgres: { file: "/var/log/postgresql/postgresql-16-main.log", label: "PostgreSQL" },
  pgbouncer: { file: "/var/log/pgbouncer/pgbouncer.log", label: "pgBouncer" },
  pgbackrest: { file: "/var/log/pgbackrest/addinvoice-backup.log", label: "pgBackRest (yedek)" },
  partition: { file: "/var/log/pgbackrest/partition-maintain.log", label: "Bölüm bakımı" },
  ops_web: { unit: "addinvoice-ops", label: "Ops web (journal)" },
  ops_agent: { unit: "addinvoice-ops-agent", label: "Ops ajan (journal)" },
}

const actions = {
  // — Okuma —
  services: { min: "viewer", run: async () => {
    const out = []
    for (const u of UNITS) {
      const a = await sh("systemctl", ["is-active", u])
      const s = await sh("systemctl", ["show", u, "-p", "ActiveEnterTimestamp,MemoryCurrent,NRestarts,SubState"])
      const kv = Object.fromEntries(s.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)))
      out.push({ unit: u, active: a.stdout.trim(), sub: kv.SubState, since: kv.ActiveEnterTimestamp, memory: Number(kv.MemoryCurrent) || null, restarts: Number(kv.NRestarts) || 0 })
    }
    return out
  } },

  backup_info: { min: "viewer", run: async () => {
    const r = await asPg("pgbackrest", [`--stanza=${STANZA}`, "info", "--output=json"], { timeout: 60_000 })
    if (r.code !== 0) throw new UserError("pgbackrest info başarısız: " + r.stderr.slice(0, 300))
    return JSON.parse(r.stdout)
  } },

  health_report: { min: "viewer", run: async () => {
    const files = fs.existsSync(HEALTH_DIR) ? fs.readdirSync(HEALTH_DIR).filter((f) => /^\d{4}-\d\d-\d\d\.txt$/.test(f)).sort() : []
    const latest = files.at(-1)
    const status = fs.existsSync(path.join(HEALTH_DIR, "STATUS")) ? fs.readFileSync(path.join(HEALTH_DIR, "STATUS"), "utf8").trim() : "?"
    const warnF = latest ? path.join(HEALTH_DIR, latest + ".warn") : null
    const warn = warnF && fs.existsSync(warnF) ? fs.readFileSync(warnF, "utf8").trim().split("\n").filter(Boolean) : []
    return { date: latest?.replace(".txt", "") ?? null, status, warnings: warn, text: latest ? fs.readFileSync(path.join(HEALTH_DIR, latest), "utf8").slice(0, 20_000) : "" }
  } },

  // Bağımsız izleyicinin son sonucu (agent/watchdog.mjs, cron */15). Dosya yoksa / bozuksa null.
  watchdog_status: { min: "viewer", run: async () => {
    try { return JSON.parse(fs.readFileSync("/var/lib/addinvoice-ops/watchdog-state.json", "utf8")) } catch { return null }
  } },

  agent_audit: { min: "admin", run: async (p) => {
    const n = Math.min(Math.max(Number(p.lines) || 200, 10), 1000)
    try {
      return fs.readFileSync(AUDIT, "utf8").trimEnd().split("\n").slice(-n).map((l) => JSON.parse(l)).reverse()
    } catch { return [] }
  } },

  jobs: { min: "viewer", run: async (_p, actor) => {
    const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15).map((j) => {
      const out = { ...j }
      // Tek seferlik sır (dışa aktarma parolası): yalnız işi BAŞLATAN kişiye ve yalnız BİR kez teslim edilir.
      if (j.secret && !j.secretDelivered && j.actor.email === actor.email) j.secretDelivered = true
      else out.secret = null
      return out
    })
    return list
  } },

  logs: { min: "operator", run: async (p) => {
    const src = LOGS[p.source]
    if (!src) throw new UserError("Bilinmeyen günlük kaynağı")
    const n = Math.min(Math.max(Number(p.lines) || 200, 10), 500)
    const r = src.unit
      ? await sh("journalctl", ["-u", src.unit, "-n", String(n), "--no-pager", "-o", "short-iso"])
      : await sh("tail", ["-n", String(n), src.file])
    return { source: p.source, label: src.label, text: (r.stdout || r.stderr).slice(-60_000) }
  } },

  log_sources: { min: "operator", run: async () => Object.entries(LOGS).map(([k, v]) => ({ key: k, label: v.label })) },

  // — Mutasyon (operatör) —
  backup_run: { min: "operator", run: async (p, actor) => {
    const type = p.type
    if (!["full", "diff", "incr"].includes(type)) throw new UserError("Geçersiz yedek türü")
    return runJob("backup", `pgBackRest ${type} yedek`, actor, async (job) => {
      const r = await asPg("pgbackrest", [`--stanza=${STANZA}`, `--type=${type}`, "backup"], { timeout: 3 * 3600_000 })
      jlog(job, (r.stdout + r.stderr).split("\n").slice(-8).join(" | "))
      if (r.code !== 0) throw new Error("Yedek başarısız (kod " + r.code + ")")
      return "Yedek tamamlandı"
    })
  } },

  restore_point: { min: "operator", run: async (p, actor) => {
    const name = String(p.name ?? "")
    if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(name)) throw new UserError("Ad: 3-40 karakter, küçük harf/rakam/-/_")
    const r = await psql(`select pg_create_restore_point('${name}')`)
    if (r.code !== 0) throw new UserError("Restore noktası oluşturulamadı: " + r.stderr.slice(0, 200))
    await psql("select pg_switch_wal()") // WAL'ı hemen arşive düşür ki nokta kurtarılabilir olsun
    return { name, lsn: r.stdout.trim() }
  } },

  maintenance: { min: "operator", run: async (p, actor) => {
    const op = p.op
    const table = String(p.table ?? "")
    if (!["analyze", "vacuum", "reindex"].includes(op)) throw new UserError("Geçersiz işlem")
    if (op === "reindex" && RANK[actor.role] < RANK.admin) throw new UserError("REINDEX için yönetici rolü gerekir")
    if (!IDENT.test(table)) throw new UserError("Geçersiz tablo adı")
    // psql -c değişken yorumlamaz → SQL stdin'den (-f -) verilir; :'t' güvenli tırnaklanır.
    const ex = await asPg("psql", ["-X", "-At", "-d", DB, "-v", `t=${table}`, "-f", "-"], { input: "select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition and c.relname = :'t';" })
    if (ex.stdout.trim() !== "1") throw new UserError("Tablo bulunamadı")
    const stmt = { analyze: `ANALYZE public."${table}"`, vacuum: `VACUUM (ANALYZE) public."${table}"`, reindex: `REINDEX TABLE CONCURRENTLY public."${table}"` }[op]
    return runJob("maintenance", `${op.toUpperCase()} ${table}`, actor, async (job) => {
      const r = await asPg("psql", ["-X", "-At", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", "SET lock_timeout='15s'", "-c", stmt], { timeout: 2 * 3600_000 })
      jlog(job, (r.stdout + r.stderr).trim() || "tamam")
      if (r.code !== 0) throw new Error(r.stderr.slice(0, 300) || "başarısız")
      return `${op.toUpperCase()} ${table} tamamlandı`
    })
  } },

  export_company: { min: "operator", run: async (p, actor) => {
    const id = String(p.companyId ?? "")
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw new UserError("Geçersiz şirket kimliği")
    const ex = await asPg("psql", ["-X", "-At", "-d", DB, "-v", `i=${id}`, "-f", "-"], { input: "select slug from companies where id = :'i';" })
    const slug = ex.stdout.trim().replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 40)
    if (!slug) throw new UserError("Şirket bulunamadı")
    return runJob("export", `Şirket dışa aktarma: ${slug}`, actor, async (job) => {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
      const dir = path.join(EXPORT_TMP, `ops-${slug}-${stamp}`)
      fs.mkdirSync(EXPORT_TMP, { recursive: true, mode: 0o700 })
      const exp = await sh("node", [path.join(path.dirname(new URL(import.meta.url).pathname), "company-backup.mjs"), "export", id, "--out", dir, "--db", DB], { timeout: 3600_000 })
      jlog(job, exp.stdout.split("\n").slice(-6).join(" | "))
      if (exp.code !== 0) throw new Error("Dışa aktarma başarısız: " + exp.stderr.slice(0, 300))
      const pass = crypto.randomBytes(18).toString("base64url")
      const outFile = path.join(DL_DIR, `${slug}-${stamp}.tar.enc`)
      fs.mkdirSync(DL_DIR, { recursive: true })
      // tar | openssl aes-256-cbc (PBKDF2, 600k tur) — parola ortam değişkeniyle (argv'de görünmez)
      await new Promise((resolve, reject) => {
        const tar = spawn("tar", ["-C", path.dirname(dir), "-cf", "-", path.basename(dir)])
        const enc = spawn("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-salt", "-pass", "env:OPS_EXPORT_PASS", "-out", outFile], { env: { ...process.env, OPS_EXPORT_PASS: pass } })
        tar.stdout.pipe(enc.stdin)
        let err = ""
        enc.stderr.on("data", (d) => (err += d))
        enc.on("close", (c) => (c === 0 ? resolve() : reject(new Error("şifreleme başarısız " + err.slice(0, 200)))))
        tar.on("error", reject)
      })
      await sh("chown", [`root:${WEB_USER}`, outFile])
      fs.chmodSync(outFile, 0o640)
      await sh("rm", ["-rf", "--", dir]) // açık (şifresiz) kopya diskte kalmasın
      const size = fs.statSync(outFile).size
      job.secret = pass
      return { file: path.basename(outFile), size, expiresInHours: 24 }
    })
  } },

  cleanup_downloads: { min: "operator", run: async () => {
    let n = 0
    for (const f of fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR) : []) {
      const full = path.join(DL_DIR, f)
      if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600_000) { fs.rmSync(full); n++ }
    }
    return { removed: n }
  } },
}


// ── Faz 3: servis işlemleri, yapılandırma düzenleme, geri yükleme provası, ayar özeti ───────────
const CONFIG_BACKUP_DIR = "/var/backups/addinvoice-ops-config"
const CONFIGS = {
  nginx_main:    { path: "/etc/nginx/nginx.conf", label: "nginx — ana yapılandırma", kind: "nginx" },
  nginx_site:    { path: "/etc/nginx/sites-enabled/addinvoice", label: "nginx — addinvoice.dk sitesi", kind: "nginx" },
  nginx_ops:     { path: "/etc/nginx/sites-available/addinvoice-ops", label: "nginx — ops.addinvoice.dk sitesi", kind: "nginx" },
  pgbouncer:     { path: "/etc/pgbouncer/pgbouncer.ini", label: "pgBouncer", kind: "pgbouncer" },
  pg_tuning:     { path: "/etc/postgresql/16/main/conf.d/addinvoice-tuning.conf", label: "PostgreSQL ayarları (addinvoice-tuning.conf)", kind: "postgres" },
}
const SERVICES = {
  nginx:      { label: "nginx", reload: ["systemctl", ["reload", "nginx"]], restart: ["systemctl", ["restart", "nginx"]], unit: "nginx" },
  pgbouncer:  { label: "pgBouncer", reload: ["systemctl", ["reload", "pgbouncer"]], restart: ["systemctl", ["restart", "pgbouncer"]], unit: "pgbouncer" },
  postgresql: { label: "PostgreSQL", reload: ["systemctl", ["reload", "postgresql@16-main"]], restart: ["systemctl", ["restart", "postgresql@16-main"]], unit: "postgresql@16-main" },
  app:        { label: "AddInvoice uygulaması (pm2)", reload: ["pm2", ["reload", "addinvoice"]], restart: ["pm2", ["restart", "addinvoice"]], unit: "pm2-root" },
}
const ts14 = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
const backupsOf = (key) => {
  const d = path.join(CONFIG_BACKUP_DIR, key)
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d{14}$/.test(f)).sort().reverse().slice(0, 30) : []
}
function writeAtomic(target, content, like) {
  const real = fs.realpathSync(target)
  const tmp = path.join(path.dirname(real) === "/etc/nginx/sites-enabled" ? "/etc/nginx" : path.dirname(real), `.ops-tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, content)
  fs.chmodSync(tmp, like.mode & 0o7777) // UMask=0077 (unit) dosya iznini daraltmasın → orijinal izni açıkça uygula
  fs.chownSync(tmp, like.uid, like.gid)
  fs.renameSync(tmp, real)
}
async function validateConfig(kind) {
  if (kind === "nginx") {
    const r = await sh("nginx", ["-t"])
    return { ok: r.code === 0, msg: (r.stderr + r.stdout).trim().slice(-600) }
  }
  if (kind === "postgres") {
    const r = await asPg("/usr/lib/postgresql/16/bin/postgres", ["-C", "shared_buffers", "-D", "/var/lib/postgresql/16/main", "--config-file=/etc/postgresql/16/main/postgresql.conf"])
    return { ok: r.code === 0, msg: (r.stderr + r.stdout).trim().slice(-600) }
  }
  return { ok: true, msg: "" } // pgBouncer'ın 'yapılandırma testi' modu yok → uygulama sonrası sağlık kontrolü
}
async function healthAfter(kind) {
  if (kind === "nginx") {
    const a = await sh("systemctl", ["is-active", "nginx"])
    const c = await sh("curl", ["-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code}", "-H", "Host: addinvoice.dk", "http://127.0.0.1:80/"])
    // HTTPS üzerinden gerçek bir istek: proxy/upstream ayarı bozulduysa (502/504) burada yakalanır.
    const h = await sh("curl", ["-sk", "-o", "/dev/null", "-m", "15", "-w", "%{http_code}", "--resolve", "addinvoice.dk:443:127.0.0.1", "https://addinvoice.dk/login"])
    return a.stdout.trim() === "active" && /^[23]\d\d$/.test(c.stdout.trim()) && /^[234]\d\d$/.test(h.stdout.trim())
  }
  if (kind === "pgbouncer") {
    await new Promise((r) => setTimeout(r, 1500))
    const a = await sh("systemctl", ["is-active", "pgbouncer"])
    const l = await sh("ss", ["-ltn", "sport = :6432"])
    return a.stdout.trim() === "active" && l.stdout.includes("6432")
  }
  if (kind === "postgres") {
    const r = await psql("select 1")
    return r.code === 0
  }
  return true
}
const reloadFor = { nginx: ["systemctl", ["reload", "nginx"]], pgbouncer: ["systemctl", ["reload", "pgbouncer"]], postgres: ["systemctl", ["reload", "postgresql@16-main"]] }

Object.assign(actions, {
  config_list: { min: "operator", run: async () => Object.entries(CONFIGS).map(([key, c]) => {
    const st = fs.existsSync(c.path) ? fs.statSync(c.path) : null
    return { key, label: c.label, path: c.path, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0, backups: backupsOf(key) }
  }) },

  config_read: { min: "operator", run: async (p) => {
    const c = CONFIGS[p.key]
    if (!c) throw new UserError("Bilinmeyen yapılandırma")
    if (p.backup) {
      if (!/^\d{14}$/.test(String(p.backup))) throw new UserError("Geçersiz yedek")
      return { content: fs.readFileSync(path.join(CONFIG_BACKUP_DIR, p.key, String(p.backup)), "utf8"), path: c.path }
    }
    return { content: fs.readFileSync(c.path, "utf8"), path: c.path }
  } },

  // Doğrula (dryRun) veya uygula: yedek al → yaz → doğrula → (hata varsa geri al) → reload → sağlık kontrolü (hata varsa geri al + tekrar reload)
  config_apply: { min: "admin", run: async (p, actor) => {
    const c = CONFIGS[p.key]
    if (!c) throw new UserError("Bilinmeyen yapılandırma")
    let content = String(p.content ?? "")
    if (!content.trim() || content.length > 200_000 || content.includes("\0")) throw new UserError("Geçersiz içerik")
    if (!content.endsWith("\n")) content += "\n"
    if (busy) throw new UserError(`Başka bir iş çalışıyor: ${busy.label}`)
    const real = fs.realpathSync(c.path)
    const like = fs.statSync(real)
    const original = fs.readFileSync(real, "utf8")
    if (original === content) throw new UserError("Değişiklik yok")
    const dir = path.join(CONFIG_BACKUP_DIR, p.key)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    let stamp = ts14()
    for (let n = 1; fs.existsSync(path.join(dir, stamp)); n++) stamp = new Date(Date.now() + n * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14) // aynı saniyede iki işlem: yedek ezilmesin
    fs.writeFileSync(path.join(dir, stamp), original, { mode: 0o600 })
    for (const old of backupsOf(p.key).slice(30)) fs.rmSync(path.join(dir, old), { force: true })
    const revert = () => writeAtomic(c.path, original, like)

    writeAtomic(c.path, content, like)
    const v = await validateConfig(c.kind)
    if (!v.ok) { revert(); fs.rmSync(path.join(dir, stamp), { force: true }); throw new UserError("Doğrulama BAŞARISIZ, değişiklik geri alındı: " + v.msg) }
    if (p.dryRun) { revert(); fs.rmSync(path.join(dir, stamp), { force: true }); return { applied: false, message: "Doğrulama başarılı (dosya değiştirilmedi).", detail: v.msg } }

    const [cmd, args] = reloadFor[c.kind]
    const rl = await sh(cmd, args)
    const healthy = rl.code === 0 && (await healthAfter(c.kind))
    if (!healthy) {
      revert()
      await sh(cmd, args)
      throw new UserError("Uygulama sonrası sağlık kontrolü BAŞARISIZ → eski yapılandırma geri yüklendi ve servis yeniden yüklendi. " + (rl.stderr || "").slice(0, 300))
    }
    let pending = []
    if (c.kind === "postgres") {
      const r = await psql("select name from pg_settings where pending_restart")
      pending = r.stdout.trim().split("\n").filter(Boolean)
    }
    auditLine({ kind: "config-applied", key: p.key, backup: stamp, actor: actor.email })
    return { applied: true, backup: stamp, restartNeeded: pending, message: pending.length ? `Uygulandı. Bu ayarlar için PostgreSQL YENİDEN BAŞLATILMALI: ${pending.join(", ")}` : "Uygulandı ve servis yeniden yüklendi." }
  } },

  config_rollback: { min: "admin", run: async (p, actor) => {
    const c = CONFIGS[p.key]
    if (!c || !/^\d{14}$/.test(String(p.backup))) throw new UserError("Geçersiz istek")
    const old = fs.readFileSync(path.join(CONFIG_BACKUP_DIR, p.key, String(p.backup)), "utf8")
    return actions.config_apply.run({ key: p.key, content: old }, actor)
  } },

  service_action: { min: "operator", run: async (p, actor) => {
    const svc = SERVICES[p.service]
    if (!svc || !["reload", "restart"].includes(p.op)) throw new UserError("Geçersiz servis/işlem")
    if (p.op === "restart" && RANK[actor.role] < RANK.admin) throw new UserError("Yeniden başlatma (restart) için yönetici rolü gerekir")
    if (busy) throw new UserError(`Başka bir iş çalışıyor: ${busy.label}. Bitmesini bekle.`)
    if (p.service === "nginx") {
      const t = await sh("nginx", ["-t"])
      if (t.code !== 0) throw new UserError("nginx yapılandırması hatalı, işlem yapılmadı: " + t.stderr.slice(-300))
    }
    const [cmd, args] = svc[p.op]
    const r = await sh(cmd, args, { timeout: 120_000 })
    if (r.code !== 0) throw new UserError(`${svc.label} ${p.op} başarısız: ` + (r.stderr || r.stdout).slice(0, 300))
    await new Promise((res) => setTimeout(res, 1500))
    const a = p.service === "app" ? { stdout: "active" } : await sh("systemctl", ["is-active", svc.unit])
    return { service: p.service, op: p.op, active: a.stdout.trim() }
  } },

  // Yedekten geçici bir kopyaya geri yükle → ayrı portta aç → say → sil. Canlıya DOKUNMAZ.
  restore_drill: { min: "operator", run: async (_p, actor) => {
    return runJob("drill", "Geri yükleme provası (geçici kopya)", actor, async (job) => {
      const dir = "/var/tmp/ops-restore-drill"
      await sh("rm", ["-rf", "--", dir])
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      await sh("chown", ["postgres:postgres", dir])
      try {
        const rs = await asPg("pgbackrest", [`--stanza=${STANZA}`, `--pg1-path=${dir}`, "--type=default", "restore"], { timeout: 3600_000 })
        jlog(job, "restore: " + (rs.stderr || rs.stdout).trim().split("\n").slice(-2).join(" | "))
        if (rs.code !== 0) throw new Error("pgbackrest restore başarısız")
        const opts = ["-c", "port=5499", "-c", "archive_mode=off", "-c", "listen_addresses=", "-c", "unix_socket_directories=" + dir, "-c", "config_file=/etc/postgresql/16/main/postgresql.conf", "-c", "hba_file=/etc/postgresql/16/main/pg_hba.conf", "-c", "ident_file=/etc/postgresql/16/main/pg_ident.conf", "-c", "external_pid_file=", "-c", "data_directory=" + dir, "-c", "shared_buffers=128MB"]
        const st = await asPg("/usr/lib/postgresql/16/bin/pg_ctl", ["-D", dir, "-w", "-t", "600", "-o", opts.join(" "), "-l", dir + "/drill.log", "start"], { timeout: 700_000 })
        if (st.code !== 0) throw new Error("geçici sunucu açılamadı: " + (st.stderr + st.stdout).slice(-300))
        const q = await asPg("psql", ["-X", "-At", "-h", dir, "-p", "5499", "-d", DB, "-c", "select (select count(*) from companies)||' şirket, '||(select count(*) from users)||' kullanıcı, '||(select count(*) from transactions)||' transaction'"])
        await asPg("/usr/lib/postgresql/16/bin/pg_ctl", ["-D", dir, "-m", "fast", "stop"])
        if (q.code !== 0) throw new Error("kopyada sorgu başarısız: " + q.stderr.slice(0, 200))
        return "Yedek geri yüklenebiliyor ✔ — kopyada: " + q.stdout.trim()
      } finally {
        await asPg("/usr/lib/postgresql/16/bin/pg_ctl", ["-D", dir, "-m", "immediate", "stop"]).catch(() => {})
        await sh("rm", ["-rf", "--", dir])
      }
    })
  } },

  tuning_snapshot: { min: "viewer", run: async () => {
    const kv = (file, re) => {
      const out = {}
      try { for (const l of fs.readFileSync(file, "utf8").split("\n")) { const m = l.match(re); if (m) out[m[1]] = m[2].trim() } } catch {}
      return out
    }
    const pgb = kv("/etc/pgbouncer/pgbouncer.ini", /^\s*([a-z_]+)\s*=\s*(.+?)\s*(?:;.*)?$/)
    delete pgb.auth_file
    const nginxT = (await sh("nginx", ["-T"])).stdout
    const nx = {}
    for (const d of ["worker_processes", "worker_connections", "worker_rlimit_nofile", "keepalive_timeout", "keepalive_requests", "gzip", "gzip_comp_level", "gzip_min_length", "gzip_proxied", "gzip_types", "sendfile", "tcp_nopush", "tcp_nodelay", "server_tokens", "ssl_session_cache", "open_file_cache", "client_max_body_size"]) {
      const m = nginxT.match(new RegExp("^\\s*" + d + "\\s+([^;]+);", "m"))
      if (m) nx[d] = m[1].trim()
    }
    nx.upstream_keepalive = /^\s*keepalive\s+\d+;/m.test(nginxT) ? (nginxT.match(/^\s*keepalive\s+(\d+);/m)[1]) : "yok"
    const pm2 = await sh("pm2", ["jlist"])
    let app = []
    try { app = JSON.parse(pm2.stdout.slice(pm2.stdout.indexOf("["))).map((x) => ({ name: x.name, mode: x.pm2_env.exec_mode, id: x.pm_id, status: x.pm2_env.status, restarts: x.pm2_env.restart_time, memory: x.monit.memory, cpu: x.monit.cpu, uptime: Date.now() - x.pm2_env.pm_uptime })) } catch {}
    const sysctl = {}
    for (const k of ["net/core/somaxconn", "net/ipv4/tcp_max_syn_backlog", "net/ipv4/tcp_tw_reuse", "net/ipv4/ip_local_port_range", "vm/swappiness", "vm/dirty_background_ratio", "vm/dirty_ratio", "vm/overcommit_memory", "fs/file-max"]) {
      try { sysctl[k.replaceAll("/", ".")] = fs.readFileSync("/proc/sys/" + k, "utf8").trim().replace(/\s+/g, " ") } catch {}
    }
    let thp = ""; try { thp = fs.readFileSync("/sys/kernel/mm/transparent_hugepage/enabled", "utf8").trim() } catch {}
    return { pgbouncer: pgb, nginx: nx, app, sysctl, thp }
  } },
})


// ── Yedekleme (borg; 20 Kas 2026) — işin tamamı backup-engine.mjs'te; ajan yalnız doğrulama + rol + denetim ──
const tgtOf = (cfg, id) => { const t = cfg.targets.find((x) => x.id === String(id)); if (!t) throw new UserError("Hedef bulunamadı"); return t }
function configDiff(oldC, newC) {
  const out = []
  const idx = (c, k) => Object.fromEntries(c[k].map((x) => [x.id, JSON.stringify({ ...x, createdAt: undefined })]))
  for (const k of ["targets", "jobs"]) {
    const a = idx(oldC, k), b = idx(newC, k)
    for (const id of Object.keys(b)) if (!(id in a)) out.push(`${k}+${id}`); else if (a[id] !== b[id]) out.push(`${k}~${id}`)
    for (const id of Object.keys(a)) if (!(id in b)) out.push(`${k}-${id}`)
  }
  return out
}
Object.assign(actions, {
  backup_overview: { min: "viewer", run: async () => BE.overview() },
  backup_config_get: { min: "viewer", run: async () => { const c = BE.loadConfig(); return { targets: c.targets.map((t) => ({ ...t, location: BE.targetLocation(t) })), jobs: c.jobs.map((j) => ({ ...j, sources: BE.describeSources(j), schedule: { ...j.schedule } })), typeNames: BE.JOB_TYPES, allowedRoots: BE.ALLOWED_ROOTS } } },
  backup_config_save: { min: "admin", run: async (p, actor) => {
    const before = BE.loadConfig()
    const saved = BE.saveConfig(p.config, actor.email)
    auditLine({ kind: "backup_config", actor: actor.email, changes: configDiff(before, saved) })
    return BE.overview()
  } },
  backup_schedule_preview: { min: "viewer", run: async (p) => {
    const s = BE.normalizeSchedule(p.schedule)
    const n = Math.min(Math.max(Number(p.count) || 5, 1), 10)
    return { next: BE.nextRuns(s, new Date(), n).map((d) => d.toISOString()), perDay: s.hours.length * s.minutes.length }
  } },
  backup_run_now: { min: "operator", run: async (p, actor) => {
    const cfg = BE.loadConfig()
    const job = cfg.jobs.find((j) => j.id === String(p.job))
    if (!job) throw new UserError("Görev bulunamadı")
    if (p.target) tgtOf(cfg, p.target)
    BE.spawnJob(job.id, p.target ? String(p.target) : undefined)
    return "Görev başlatıldı; sonuç birkaç dakika içinde durumda görünür"
  } },
  backup_target_test: { min: "operator", run: async (p) => BE.targetTest(tgtOf(BE.loadConfig(), p.target)) },
  backup_target_create: { min: "admin", run: async (p, actor) => {
    const cfg = BE.loadConfig()
    if (cfg.targets.some((t) => t.id === p.target?.id)) throw new UserError("Bu kimlikte bir hedef zaten var")
    const { password: _drop, ...tIn } = p.target ?? {}
    const next = BE.validateConfig({ targets: [...cfg.targets, { ...tIn, enabled: false }], jobs: cfg.jobs })
    const t = next.targets.find((x) => x.id === p.target.id)
    // Kayıt başarısız olursa az önce ürettiğimiz anahtar/parola klasörünü sil: yoksa aynı kimlikle yeniden denemede
    // parola "zaten var" sayılır ve kullanıcıya hiç gösterilmez.
    const credExisted = fs.existsSync(t.credDir)
    let creds
    try {
      creds = await BE.targetCreateCreds(t, typeof p.password === "string" ? p.password : undefined)
      BE.saveConfig(next, actor.email)
    } catch (e) {
      if (!credExisted && t.credDir.startsWith(BE.KEY_ROOT + "/targets/")) fs.rmSync(t.credDir, { recursive: true, force: true })
      throw e
    }
    auditLine({ kind: "backup_target_create", actor: actor.email, target: t.id, type: t.type })
    return { target: t, publicKey: creds.publicKey, fingerprint: creds.fingerprint, passphrase: creds.passphrase, setup: creds.setup }
  } },
  backup_target_password: { min: "admin", run: async (p, actor) => {
    const t = tgtOf(BE.loadConfig(), p.target)
    BE.setTargetPassword(t, typeof p.password === "string" ? p.password : "")
    auditLine({ kind: "backup_target_password", actor: actor.email, target: t.id })
    return "SSH parolası güncellendi. 'Bağlantıyı sına' ile doğrula."
  } },
  backup_setup_text: { min: "admin", run: async (p) => {
    const t = tgtOf(BE.loadConfig(), p.target)
    const pubFile = `${t.credDir}/id_ed25519.pub`
    const pub = fs.existsSync(pubFile) ? fs.readFileSync(pubFile, "utf8").trim() : null
    let fp = null; try { fp = (await sh("ssh-keygen", ["-lf", `${t.credDir}/known_hosts`])).stdout.trim() } catch {}
    return { publicKey: pub, fingerprint: fp, setup: BE.setupInstructions(t, pub) }
  } },
  backup_target_init: { min: "admin", run: async (p, actor) => {
    const cfg = BE.loadConfig()
    const t = tgtOf(cfg, p.target)
    const msg = await BE.targetInit(t)
    BE.saveConfig({ targets: cfg.targets.map((x) => (x.id === t.id ? { ...x, enabled: true } : x)), jobs: cfg.jobs }, actor.email)
    auditLine({ kind: "backup_target_init", actor: actor.email, target: t.id })
    return msg + " ve hedef etkinleştirildi"
  } },
  backup_target_delete: { min: "admin", run: async (p, actor) => {
    const cfg = BE.loadConfig()
    const t = tgtOf(cfg, p.target)
    const used = cfg.jobs.filter((j) => j.targets.includes(t.id)).map((j) => j.id)
    if (used.length) throw new UserError("Hedefi kullanan görevler var: " + used.join(", "))
    BE.saveConfig({ targets: cfg.targets.filter((x) => x.id !== t.id), jobs: cfg.jobs }, actor.email)
    return "Hedef silindi (kimlik bilgileri ve uzaktaki yedekler SİLİNMEDİ)"
  } },
  backup_archives: { min: "viewer", run: async (p) => BE.listArchives(tgtOf(BE.loadConfig(), p.target), p.job ? String(p.job) : undefined, Math.min(Number(p.limit) || 15, 100)) },
  backup_history: { min: "viewer", run: async (p) => {
    let lines = []
    try { lines = fs.readFileSync(`${BE.STATE}/history.jsonl`, "utf8").split("\n").filter(Boolean) } catch {}
    let rows = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (p.job) rows = rows.filter((r) => r.job === String(p.job))
    return rows.slice(-Math.min(Number(p.limit) || 60, 300)).reverse()
  } },
  backup_tables: { min: "viewer", run: async () => BE.listTables() },
  backup_browse: { min: "admin", run: async (p) => BE.browse(p.dir ?? "/") },
  backup_log: { min: "operator", run: async (p) => {
    const id = String(p.job ?? "")
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(id)) throw new UserError("Geçersiz görev kimliği")
    try { return fs.readFileSync(`${BE.LOG_DIR}/${id}.log`, "utf8").split("\n").slice(-200).join("\n") } catch { return "(günlük yok)" }
  } },
})


// ── Geri yükleme sihirbazı (Aşama 1: yalnız GÜVENLİ KOPYA; canlıya yazmaz) ───────────────────────────────
/** Dizini tar | openssl ile şifreleyip indirme klasörüne koyar (parola işe sır olarak eklenir, bir kez gösterilir). */
async function encryptDirToDownload(dir, nameBase, job) {
  const pass = crypto.randomBytes(18).toString("base64url")
  const outFile = path.join(DL_DIR, `${nameBase}.tar.enc`)
  fs.mkdirSync(DL_DIR, { recursive: true })
  await new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-C", path.dirname(dir), "-cf", "-", path.basename(dir)])
    const enc = spawn("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-salt", "-pass", "env:OPS_EXPORT_PASS", "-out", outFile], { env: { ...process.env, OPS_EXPORT_PASS: pass } })
    tar.stdout.pipe(enc.stdin)
    let err = ""
    enc.stderr.on("data", (d) => (err += d))
    enc.on("close", (c) => (c === 0 ? resolve() : reject(new Error("şifreleme başarısız " + err.slice(0, 200)))))
    tar.on("error", reject)
  })
  await sh("chown", [`root:${WEB_USER}`, outFile])
  fs.chmodSync(outFile, 0o640)
  job.secret = pass
  return { file: path.basename(outFile), size: fs.statSync(outFile).size, expiresInHours: 24 }
}
const AGENT_DIR = path.dirname(new URL(import.meta.url).pathname)
Object.assign(actions, {
  restore_browse: { min: "admin", run: async (p) => RE.browse(p) },
  restore_list: { min: "admin", run: async () => RE.listWorkspaces() },
  restore_db_summary: { min: "admin", run: async (p) => RE.summary(p.id) },
  restore_db_preview: { min: "admin", run: async (p) => RE.dbPreview(p) },
  restore_cleanup: { min: "admin", run: async (p) => RE.destroy(p.id) },
  // — Aşama 2: canlıya uygulama (yazarak onay + plan + geri-al) —
  restore_files_stage: { min: "admin", run: async (p, actor) => {
    const id = RE.newId()
    return runJob("restore", `Geri yükleme planı (dosyalar): ${String(p.archive).slice(0, 60)}`, actor, async (job) => {
      try {
        const r = await RE.extractFiles(p, id, actor.email)
        jlog(job, `${r.files} dosya açıldı; canlıyla karşılaştırılıyor`)
        return RE.filesPlan(id)
      } catch (e) { await RE.destroy(id).catch(() => {}); throw e }
    })
  } },
  restore_files_apply: { min: "admin", run: async (p, actor) => {
    if (p.confirm !== "CANLIYA UYGULA") throw new UserError("Onay metni eksik: CANLIYA UYGULA yazmalısın")
    return runJob("restore", `CANLIYA geri yükleme (dosyalar): ${String(p.id)}`, actor, async (job) => {
      const r = RE.filesApply({ id: p.id, mode: p.mode }, actor.email)
      jlog(job, `${r.added} eklendi, ${r.replaced} değiştirildi`)
      auditLine({ kind: "restore-apply", scope: "files", id: p.id, mode: p.mode, actor: actor.email, result: r })
      await RE.destroy(p.id).catch(() => {})
      return r
    })
  } },
  restore_db_apply: { min: "admin", run: async (p, actor) => {
    if (!p.dry && p.confirm !== "CANLIYA UYGULA") throw new UserError("Onay metni eksik: CANLIYA UYGULA yazmalısın")
    return runJob("restore", `${p.dry ? "Geri yükleme planı" : "CANLIYA geri yükleme"} (veritabanı): ${String(p.id)}`, actor, async (job) => {
      const r = await RE.dbApply({ id: p.id, tables: p.tables, companyId: p.companyId || undefined, mode: p.mode, dry: !!p.dry }, actor.email)
      jlog(job, r.results.map((x) => `${x.table}: +${x.inserted} ~${x.updated}`).join(" | "))
      auditLine({ kind: "restore-apply", scope: "db", id: p.id, mode: p.mode, dry: !!p.dry, actor: actor.email, tables: p.tables, results: r.results, restorePoint: r.restorePoint })
      return r
    })
  } },
  restore_extract: { min: "admin", run: async (p, actor) => {
    const id = RE.newId()
    return runJob("restore", `Geri yükleme (dosyalar): ${String(p.archive).slice(0, 60)}`, actor, async (job) => {
      const r = await RE.extractFiles(p, id, actor.email)
      jlog(job, `${r.files} dosya açıldı (${Math.round(r.bytes / 1024)} KB)`)
      const enc = await encryptDirToDownload(r.dir, `restore-${id}-dosyalar`, job)
      await RE.destroy(id) // açık (şifresiz) kopya diskte kalmasın; indirilebilir paket 24 saat saklanır
      return { ...enc, files: r.files, bytes: r.bytes }
    })
  } },
  restore_db_prepare: { min: "admin", run: async (p, actor) => {
    const id = RE.newId()
    const prefix = String(p.archive ?? "").replace(/-\d{4}-\d\d-\d\d_\d{4}$/, "")
    const jobType = BE.loadConfig().jobs.find((j) => j.id === prefix)?.type ?? (prefix === "db" || prefix === "tables" ? prefix : "other")
    return runJob("restore", `Geri yükleme (veritabanı): ${String(p.archive).slice(0, 60)}`, actor, async (job) => {
      try { return await RE.dbPrepare({ target: p.target, archive: p.archive, jobType }, id, actor.email, (m) => jlog(job, m)) }
      catch (e) { await RE.destroy(id).catch(() => {}); throw e }
    })
  } },
  restore_db_export: { min: "admin", run: async (p, actor) => {
    return runJob("restore", `Geri yükleme (veri paketi): ${String(p.id).slice(0, 12)}`, actor, async (job) => {
      const r = await RE.dbExport(p, AGENT_DIR)
      jlog(job, `${r.files} dosya hazırlandı`)
      try { return { ...(await encryptDirToDownload(r.dir, `restore-${p.id}-veri-${RE.newId()}`, job)), files: r.files } }
      finally { if (r.removeAfter) fs.rmSync(r.dir, { recursive: true, force: true }) }
    })
  } },
})
RE.cleanupExpired().catch(() => {})
setInterval(() => RE.cleanupExpired().catch(() => {}), 3600_000).unref()

// ── HTTP (unix soket) ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)) }
  if (req.method !== "POST" || req.url !== "/run") return send(404, { ok: false, error: "yok" })
  let body = ""
  req.setEncoding("utf8")
  req.on("data", (c) => { body += c; if (body.length > 80_000) req.destroy() })
  req.on("end", async () => {
    try {
      const ts = String(req.headers["x-ops-ts"] ?? "")
      const sig = String(req.headers["x-ops-sig"] ?? "")
      const expect = crypto.createHmac("sha256", "agent:" + SECRET).update(ts + "." + body).digest("hex")
      const ok = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))
      if (!ok || Math.abs(Date.now() - Number(ts)) > 60_000) { auditLine({ kind: "reject", reason: "imza/zaman" }); return send(403, { ok: false, error: "Yetkisiz" }) }

      const { action, params = {}, actor } = JSON.parse(body)
      const def = Object.hasOwn(actions, action) ? actions[action] : null
      if (!def || !actor || !RANK[actor.role] || typeof actor.email !== "string") { auditLine({ kind: "reject", reason: "eylem/aktör", action }); return send(400, { ok: false, error: "Geçersiz istek" }) }
      if (RANK[actor.role] < RANK[def.min]) { auditLine({ kind: "reject", reason: "rol", action, actor: actor.email, role: actor.role }); return send(403, { ok: false, error: "Rol yetersiz" }) }

      const mutating = !["services", "backup_info", "health_report", "watchdog_status", "agent_audit", "jobs", "logs", "log_sources", "tuning_snapshot", "config_list", "config_read", "backup_overview", "backup_config_get", "backup_schedule_preview", "backup_archives", "backup_history", "backup_tables", "backup_setup_text", "backup_browse", "restore_browse", "restore_list", "restore_db_summary"].includes(action)
      if (mutating || action === "logs" || action === "config_read") auditLine({ kind: "run", action, params: action === "logs" ? { source: params.source } : action === "backup_config_save" ? { bytes: JSON.stringify(params.config ?? {}).length } : action === "backup_target_create" ? { target: params.target, password: params.password ? "***" : undefined } : action === "backup_target_password" ? { target: params.target } : action.startsWith("config_") ? { key: params.key, backup: params.backup, dryRun: params.dryRun, bytes: params.content ? String(params.content).length : undefined } : params, actor: actor.email, role: actor.role })
      const data = await def.run(params, actor)
      send(200, { ok: true, data })
    } catch (e) {
      if (e instanceof UserError) return send(200, { ok: false, error: e.message })
      console.error(e)
      send(500, { ok: false, error: "Ajan hatası" })
    }
  })
})

fs.mkdirSync(path.dirname(SOCKET), { recursive: true })
try { fs.unlinkSync(SOCKET) } catch {}
server.listen(SOCKET, async () => {
  await sh("chgrp", [WEB_USER, SOCKET])
  fs.chmodSync(SOCKET, 0o660)
  console.log("ops agent dinliyor:", SOCKET)
})
// Her saat: 24 saati geçen şifreli dışa aktarmaları sil
setInterval(() => actions.cleanup_downloads.run().catch(() => {}), 3600_000).unref()
