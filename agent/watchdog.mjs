#!/usr/bin/env node
/**
 * AddInvoice Ops — bağımsız izleyici (14 Kas 2026).
 *
 * NEDEN: 14 Kas 2026'da otomatik güncelleme (unattended-upgrade) PostgreSQL/pgBouncer/pm2'yi yeniden başlattı; pgBouncer ayar dosyasındaki
 * satır-içi yorum yüzünden kalkmadı, uygulama ~5 saat kapalı kaldı ve KİMSEYE haber gitmedi (Genel bakış uyarısı yalnız sayfa açılınca görünür).
 *
 * NASIL: cron her 15 dakikada çalıştırır. Ana uygulamadan BAĞIMSIZDIR (uygulama düşünce de uyarı gider):
 *   • kendi kontrollerini yapar (servisler, pgBouncer ayarı, DB, uygulama HTTP, pm2 çökme döngüsü, build, site, genel HTTPS, disk),
 *   • bir kontrol başarısız olursa 60 sn sonra yalnız o kontrol BİR KEZ daha denenir; ikisi de başarısızsa "teyit edilmiş" sayılır (anlık dalgalanmada alarm yok; en kötü durumda haber ≈16 dk),
 *   • yeni sorun → e-posta (+ KRİTİK ise SMS), sürerse 6 saatte bir e-posta hatırlatması (SMS 3 saatte bir), düzelince "normale döndü",
 *   • sonucu /var/lib/addinvoice-ops/watchdog-state.json'a yazar (ops konsolu Genel bakış'ta gösterir).
 * Posta/SMS ayarları ana uygulamanın System Settings tablosundan (doğrudan 5432) okunur ve yerel önbelleğe yazılır; veritabanı düşse de
 * önbellekten gönderilir. Alıcılar: /etc/addinvoice-ops/watchdog.json (smsTo, emailTo) — yoksa varsayılanlar.
 *
 * Kullanım:  node watchdog.mjs            normal çalışma (cron)
 *            node watchdog.mjs --test     TEST e-postası + SMS gönderir (kanalları doğrulamak için), durum değiştirmez
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { createRequire } from "node:module"

const MAIN = "/var/www/addinvoice"
const STATE_FILE = process.env.WATCHDOG_STATE || "/var/lib/addinvoice-ops/watchdog-state.json"
const CFG_CACHE = "/var/lib/addinvoice-ops/watchdog-config.json"
const USER_CFG = "/etc/addinvoice-ops/watchdog.json"
const PGB_INI = process.env.WATCHDOG_PGB_INI || "/etc/pgbouncer/pgbouncer.ini"
const EMAIL_REPEAT_MS = 6 * 3_600_000
const SMS_REPEAT_MS = 3 * 3_600_000
const MIN_MAIL_GAP_MS = 10 * 60_000
const SMS_PENDING_MAX_MIN = 20
const CONFIRM_RUNS = 1 // teyit çalışma İÇİNDE yapılır (aşağıda recheck): kontrol 15 dakikada bir koşar, art arda 2 çalışma beklemek 30 dk gecikme demek olurdu
const RECHECK_WAIT_MS = 60_000
const CRASH_RESTARTS_PER_RUN = 20 // 15 dk penceresi: deploy reload'u en çok ~6 yeniden başlatma yapar, çökme döngüsü yüzlercesini

const requireMain = createRequire(MAIN + "/package.json")
const requireOps = createRequire("/var/www/addinvoice-ops/package.json")

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
function writeJson(f, obj, mode = 0o600) {
  const tmp = f + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode })
  fs.renameSync(tmp, f)
}
function parseEnv(file) {
  const out = {}
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1")
    }
  } catch {}
  return out
}
const MAIN_ENV = parseEnv(MAIN + "/.env")
const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, env: { ...process.env, PM2_HOME: "/root/.pm2" }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }))
})

// ── Kontroller ───────────────────────────────────────────────────────────────
// severity: "critical" = kullanıcıya hizmet verilemiyor (SMS gider) · "warn" = yakında/gizli sorun (yalnız e-posta)
async function httpCheck(url, timeoutMs) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "addinvoice-ops-watchdog" } })
    await r.arrayBuffer().catch(() => {})
    return { ok: r.status >= 200 && r.status < 400, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: e?.name === "TimeoutError" ? "zaman aşımı" : (e?.cause?.code || e?.message || "hata") }
  }
}
const fmtHttp = (label, r) => r.ok ? `${label} ${r.status} (${r.ms} ms)` : `${label} ${r.status || "yanıt yok"}${r.err ? " – " + r.err : ""}`

async function checkAll(prevState, v = {}) {
  const out = []
  const add = (key, label, ok, detail, severity) => out.push({ key, label, ok, detail, severity })

  // 1) systemd servisleri
  for (const [unit, sev] of [["postgresql@16-main", "critical"], ["pgbouncer", "critical"], ["nginx", "critical"], ["pm2-root", "critical"], ["addinvoice-ops-agent", "warn"]]) {
    const r = await run("systemctl", ["is-active", unit])
    const st = r.stdout.trim() || "bilinmiyor"
    add(`unit:${unit}`, `Servis: ${unit}`, st === "active", st === "active" ? "active" : `${st} — systemctl status ${unit}`, sev)
  }

  // 2) pgBouncer ayar dosyası: satır-içi yorum → şu an çalışsa bile bir sonraki yeniden başlatmada AÇILMAZ
  try {
    const bad = []
    fs.readFileSync(PGB_INI, "utf8").split("\n").forEach((l, i) => {
      if (/^\s*[;#\[]/.test(l) || !l.includes("=")) return
      if (/=.*\s;/.test(l)) bad.push(`satır ${i + 1}: ${l.trim().slice(0, 40)}…`)
    })
    add("pgbouncer_config", "pgBouncer ayar dosyası", bad.length === 0, bad.length ? `Değerin yanında ';' yorum var (${bad.join("; ")}). pgBouncer bunu desteklemez: yeniden başlayınca AÇILMAZ. Yorumu ayrı satıra taşı.` : "geçerli", "warn")
  } catch (e) { add("pgbouncer_config", "pgBouncer ayar dosyası", false, "okunamadı: " + e.message, "warn") }

  // 3) Uygulamanın kullandığı yol: pgBouncer (6432) üzerinden gerçek sorgu
  try {
    const { Client } = requireOps("pg")
    const url = (MAIN_ENV.DATABASE_URL || "").replace(/\?.*$/, "")
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    await c.connect(); await c.query("select 1"); await c.end()
    add("db_pooled", "Veritabanı (pgBouncer üzerinden)", true, "select 1 başarılı", "critical")
  } catch (e) { add("db_pooled", "Veritabanı (pgBouncer üzerinden)", false, "bağlanamadı/sorgu yok: " + String(e.message).slice(0, 120), "critical") }

  // 4) Uygulama HTTP (yerel) + build + pm2
  const appLocal = await httpCheck("http://127.0.0.1:7331/", 12_000)
  add("app_http", "Uygulama (yerel :7331)", appLocal.ok, fmtHttp("HTTP", appLocal), "critical")

  try {
    const active = fs.readFileSync(MAIN + "/.active-dist", "utf8").trim()
    const okNext = fs.existsSync(MAIN + "/.next/BUILD_ID")
    const okActive = fs.existsSync(`${MAIN}/${active}/BUILD_ID`)
    add("app_build", "Uygulama build klasörü", okNext && okActive, okNext && okActive ? `.next → ${active}` : `.next/BUILD_ID ${okNext ? "var" : "YOK"}, ${active}/BUILD_ID ${okActive ? "var" : "YOK"} — pm2 NEXT_DIST_DIR olmadan açılırsa çöker (symlink: ln -sfn ${active} .next)`, "warn")
  } catch (e) { add("app_build", "Uygulama build klasörü", false, "okunamadı: " + e.message, "warn") }

  let restartSum = null
  try {
    const r = await run("pm2", ["jlist"], 15_000)
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))
    const apps = list.filter((p) => p.name === "addinvoice")
    const online = apps.filter((p) => p.pm2_env.status === "online").length
    restartSum = apps.reduce((s, p) => s + (p.pm2_env.restart_time || 0), 0)
    const prev = prevState?.restartSum
    const delta = prev != null && restartSum >= prev ? restartSum - prev : 0
    const crash = delta >= CRASH_RESTARTS_PER_RUN
    add("app_instances", "Uygulama işçileri (pm2)", apps.length > 0 && online === apps.length && !crash,
      apps.length === 0 ? "pm2'de 'addinvoice' yok" : crash ? `ÇÖKME DÖNGÜSÜ: son çalışmadan beri ${delta} yeniden başlatma (${online}/${apps.length} online) — pm2 logs addinvoice --err` : `${online}/${apps.length} online`, "critical")
  } catch (e) { add("app_instances", "Uygulama işçileri (pm2)", false, "pm2 okunamadı: " + String(e.message).slice(0, 100), "critical") }

  // 5) Tanıtım sitesi (yerel)
  const siteLocal = await httpCheck("http://127.0.0.1:7332/da", 12_000)
  add("site_http", "Tanıtım sitesi (yerel :7332)", siteLocal.ok, fmtHttp("HTTP", siteLocal), "critical")

  // 6) Dışarıdan görünen adresler (Cloudflare/nginx dahil) — 524/5xx burada yakalanır
  const pubApp = await httpCheck("https://app.addinvoice.dk/", 20_000)
  add("public_app", "app.addinvoice.dk (genel)", pubApp.ok, fmtHttp("HTTP", pubApp), "critical")
  const pubSite = await httpCheck("https://addinvoice.dk/da", 20_000)
  add("public_site", "addinvoice.dk (genel)", pubSite.ok, fmtHttp("HTTP", pubSite), "critical")

  // 7) SMS ağ geçidi: telefon uyku modunda (Android Doze) mesajı birkaç dk gecikmeyle teslim eder (14 Kas ölçümü: ~5 dk). Cihazın 'lastSeen'
  //    alanı GÜVENİLİR DEĞİL (2 saat eski görünürken mesaj 5 dk'da teslim edildi). Gerçek kanıt: uzun süredir 'Pending' bekleyen mesaj var mı?
  if (v.SMS_GATEWAY_USERNAME && v.SMS_GATEWAY_PASSWORD) {
    try {
      const base = v.SMS_GATEWAY_BASE_URL || "https://api.sms-gate.app"
      const basic = Buffer.from(`${v.SMS_GATEWAY_USERNAME}:${v.SMS_GATEWAY_PASSWORD}`).toString("base64")
      const t = await fetch(`${base}/3rdparty/v1/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` }, body: JSON.stringify({ ttl: 120, scopes: ["messages:list"] }), signal: AbortSignal.timeout(15_000) })
      if (!t.ok) throw new Error("token " + t.status)
      const { access_token } = await t.json()
      const d = await fetch(`${base}/3rdparty/v1/messages?limit=20`, { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(15_000) })
      if (!d.ok) throw new Error("messages " + d.status)
      const msgs = await d.json()
      const stuck = msgs.filter((m) => m.state === "Pending" && Date.now() - new Date(m.createdAt).getTime() > SMS_PENDING_MAX_MIN * 60_000)
      const oldest = stuck.length ? Math.round((Date.now() - Math.min(...stuck.map((m) => new Date(m.createdAt).getTime()))) / 60_000) : 0
      add("sms_gateway", "SMS ağ geçidi (telefon)", stuck.length === 0, stuck.length === 0 ? "bekleyen/takılı mesaj yok" : `${stuck.length} SMS ${oldest} dk'dır teslim edilmedi (telefon çevrimdışı olabilir) — SMS uyarıları ULAŞMAZ. Telefonda SMS Gateway uygulamasını aç; internet ve pil tasarrufu istisnasını kontrol et.`, "warn")
    } catch (e) { add("sms_gateway", "SMS ağ geçidi (telefon)", false, "denetlenemedi: " + String(e.message).slice(0, 100), "warn") }
  }

  // 8) Disk
  for (const p of ["/", "/var/lib/postgresql"]) {
    try {
      const s = fs.statfsSync(p)
      const pct = Math.round((1 - s.bavail / s.blocks) * 100)
      add(`disk:${p}`, `Disk ${p}`, pct < 90, `%${pct} dolu`, "warn")
    } catch {}
  }
  // 9) Yedekleme (borg, 20 Kas 2026): görev/hedef yapılandırması /etc/addinvoice-backup/config.json; sağlık hesabı backup-engine.mjs'te
  //    (hata → uyarı; en son planlı zamandan beri başarılı yedek yoksa → uyarı; her görevin kendi takvimi/toleransı vardır).
  // Bildirim ayarı kaydedildiyse yedek uyarılarını artık backup-notify.mjs yönetir (alıcı/sıklık ayarlı) → burada çift e-posta üretme.
  if (fs.existsSync("/etc/addinvoice-backup/config.json") && !fs.existsSync("/etc/addinvoice-backup/notify.json")) {
    try {
      const eng = await import("./backup-engine.mjs")
      for (const h of eng.health()) add(h.key, h.label, h.ok, h.detail, h.severity)
      const tickLog = "/var/lib/addinvoice-backup/ticks"
      const newest = fs.existsSync(tickLog) ? Math.max(0, ...fs.readdirSync(tickLog).map((f) => fs.statSync(`${tickLog}/${f}`).mtimeMs)) : 0
      void newest
    } catch (e) { add("backup:engine", "Yedek motoru", false, "okunamadı: " + String(e.message).slice(0, 120), "warn") }
  }
  return { checks: out, restartSum }
}

// ── Ayarlar (posta + SMS) ────────────────────────────────────────────────────
function decryptSecret(enc) {
  const [iv, tag, data] = enc.split(".")
  const key = Buffer.from(MAIN_ENV.SECRET_ENCRYPTION_KEY || "", "base64")
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
  d.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8")
}
const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_ENCRYPTION", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL", "SMTP_FROM_NAME", "ADMIN_EMAIL", "EMAIL_USE_RESEND", "RESEND_API_KEY", "SMS_GATEWAY_BASE_URL", "SMS_GATEWAY_USERNAME", "SMS_GATEWAY_PASSWORD", "SMS_GATEWAY_DEVICE_ID"]
async function loadSettings() {
  const vals = {}
  for (const k of KEYS) if (MAIN_ENV[k] !== undefined) vals[k] = MAIN_ENV[k]
  try {
    const { Client } = requireOps("pg")
    const url = (MAIN_ENV.DATABASE_URL || "").replace(":6432", ":5432").replace(/\?.*$/, "") // doğrudan PostgreSQL: pgBouncer düşse de çalışır
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 4000, query_timeout: 4000 })
    await c.connect()
    const r = await c.query("select key, value, test_value, is_secret, enabled, active_mode from system_settings where key = any($1)", [KEYS])
    await c.end()
    for (const row of r.rows) {
      if (!row.enabled) continue
      const raw = row.active_mode === "TEST" ? row.test_value : row.value
      if (!raw) continue
      try { vals[row.key] = row.is_secret ? decryptSecret(raw) : raw } catch {}
    }
    writeJson(CFG_CACHE, vals) // veritabanı sonradan düşerse buradan gönderilir
    return { vals, source: "db" }
  } catch (e) {
    const cached = readJson(CFG_CACHE)
    return { vals: cached ?? vals, source: cached ? "önbellek" : ".env", err: String(e.message).slice(0, 80) }
  }
}

// ── Gönderim ─────────────────────────────────────────────────────────────────
const toE164 = (p) => { const d = String(p).replace(/[\s-]/g, ""); return d.startsWith("+") ? d : /^\d{8}$/.test(d) ? "+45" + d : d }
const DRY = process.env.WATCHDOG_DRYRUN === "1"
async function sendEmail(v, to, subject, lines, customHtml) {
  if (Array.isArray(to)) to = to.join(", ")
  if (DRY) { console.log("[DRY e-posta]", to, "|", subject, "|", lines.join(" / ")); return }
  const nodemailer = requireMain("nodemailer")
  const useResend = v.EMAIL_USE_RESEND === "true" && v.RESEND_API_KEY
  const name = "addinvoice.dk"
  const transport = useResend
    ? nodemailer.createTransport({ host: "smtp.resend.com", port: 465, secure: true, auth: { user: "resend", pass: v.RESEND_API_KEY }, name })
    : nodemailer.createTransport({ host: v.SMTP_HOST, port: Number(v.SMTP_PORT) || 587, secure: (v.SMTP_ENCRYPTION || "starttls") === "ssl", auth: v.SMTP_USERNAME ? { user: v.SMTP_USERNAME, pass: v.SMTP_PASSWORD || "" } : undefined, tls: { rejectUnauthorized: false }, name, connectionTimeout: 15_000, socketTimeout: 20_000 })
  const from = v.SMTP_FROM_NAME && v.SMTP_FROM_EMAIL ? `${v.SMTP_FROM_NAME} <${v.SMTP_FROM_EMAIL}>` : (v.SMTP_FROM_EMAIL || v.SMTP_USERNAME || "noreply@addinvoice.dk")
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  await transport.sendMail({
    from, to, subject: `[AddInvoice] ${subject}`,
    text: lines.join("\n"),
    html: customHtml ?? `<div style="font-family:sans-serif;max-width:640px"><h2>${esc(subject)}</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<hr><p style="color:#999;font-size:12px">AddInvoice Ops izleyicisi (sunucu üzerinde, uygulamadan bağımsız). Ayrıntı: ops.addinvoice.dk → Genel bakış</p></div>`,
  })
}
async function sendSms(v, to, text) {
  if (DRY) { console.log("[DRY SMS]", toE164(to), "|", text, `(${text.length} karakter)`); return }
  if (!v.SMS_GATEWAY_USERNAME || !v.SMS_GATEWAY_PASSWORD) throw new Error("SMS ağ geçidi ayarlı değil")
  const base = v.SMS_GATEWAY_BASE_URL || "https://api.sms-gate.app"
  const basic = Buffer.from(`${v.SMS_GATEWAY_USERNAME}:${v.SMS_GATEWAY_PASSWORD}`).toString("base64")
  const tok = await fetch(`${base}/3rdparty/v1/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` }, body: JSON.stringify({ ttl: 300, scopes: ["messages:send"] }), signal: AbortSignal.timeout(15_000) })
  if (!tok.ok) throw new Error(`SMS auth ${tok.status}`)
  const { access_token } = await tok.json()
  const r = await fetch(`${base}/3rdparty/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` }, body: JSON.stringify({ textMessage: { text }, phoneNumbers: [toE164(to)], ...(v.SMS_GATEWAY_DEVICE_ID ? { deviceId: v.SMS_GATEWAY_DEVICE_ID } : {}) }), signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`SMS gönderim ${r.status}`)
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" })
const dur = (ms) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m} dk` }

// ── "Ne yapmalı?" ────────────────────────────────────────────────────────────
// Her kontrol için: sms = telefonda okunacak kısa, ASCII, tek satır komut · mail = adım adım. Komutlar SSH ile sunucuda çalıştırılır.
// Not: pm2 reload/restart yalnız işçi çöküyorsa; yeni build gerekiyorsa /root/deploy-app.sh main kullanılır (elle npm run build YAPMA).
const LINK = "ln -sfn $(cat /var/www/addinvoice/.active-dist) /var/www/addinvoice/.next"
const FIX = {
  "unit:postgresql@16-main": { sms: "systemctl restart postgresql@16-main ; sonra journalctl -u postgresql@16-main -n 30", mail: ["systemctl status postgresql@16-main", "journalctl -u postgresql@16-main -n 50 --no-pager", "systemctl restart postgresql@16-main", "Disk doluysa (Disk kontrolu da basarisizsa) once yer ac."] },
  "unit:pgbouncer": { sms: "systemctl restart pgbouncer ; calismazsa journalctl -u pgbouncer -n 30 (pgbouncer.ini'de ; yorum yasak)", mail: ["journalctl -u pgbouncer -n 50 --no-pager", "Hata 'invalid value' ise /etc/pgbouncer/pgbouncer.ini'de degerin yanindaki ';' yorumlarini ayri satira tasi (yedek: /root/pgbouncer.ini.bak-20261114).", "systemctl restart pgbouncer", "'/run/pgbouncer' yoksa: systemctl cat pgbouncer | grep RuntimeDirectory"] },
  "unit:nginx": { sms: "nginx -t ; systemctl restart nginx", mail: ["nginx -t   (yapilandirma hatasini gosterir)", "systemctl restart nginx", "journalctl -u nginx -n 50 --no-pager"] },
  "unit:pm2-root": { sms: "systemctl restart pm2-root ; pm2 status", mail: ["systemctl status pm2-root", "systemctl restart pm2-root", "pm2 status   (addinvoice + addinvoice-site online olmali)"] },
  "unit:addinvoice-ops-agent": { sms: null, mail: ["systemctl restart addinvoice-ops-agent", "journalctl -u addinvoice-ops-agent -n 30 --no-pager"] },
  db_pooled: { sms: "systemctl status pgbouncer postgresql@16-main ; ikisi de active degilse restart", mail: ["systemctl status pgbouncer postgresql@16-main", "journalctl -u pgbouncer -n 30 --no-pager", "Postgres dogrudan (5432) calisiyor ama 6432 yoksa sorun pgBouncer'da: systemctl restart pgbouncer"] },
  app_http: { sms: "pm2 status ; pm2 logs addinvoice --err --lines 30 ; ls -l /var/www/addinvoice/.next", mail: ["pm2 status", "pm2 logs addinvoice --err --lines 50 --nostream", "ls -l /var/www/addinvoice/.next   (aktif build'e symlink olmali)", "Symlink yoksa: " + LINK, "Sonra: pm2 reload addinvoice", "DB baglanti hatasi gorursen once veritabani/pgBouncer kontrolune bak."] },
  app_instances: { sms: "pm2 logs addinvoice --err --lines 30 ; ls -l /var/www/addinvoice/.next ; sonra pm2 reload addinvoice", mail: ["pm2 logs addinvoice --err --lines 50 --nostream", "'.next' bulunamadi hatasi: " + LINK + "  sonra pm2 reload addinvoice", "DB hatasi: systemctl status pgbouncer postgresql@16-main", "Kod hatasi sonrasi deploy ise: /root/deploy-app.sh main (otomatik geri alma vardir)"] },
  app_build: { sms: null, mail: [LINK, "Elle 'npm run build' YAPMA; yeni build icin /root/deploy-app.sh main."] },
  site_http: { sms: "pm2 status ; pm2 logs addinvoice-site --err --lines 30 ; pm2 reload addinvoice-site", mail: ["pm2 status", "pm2 logs addinvoice-site --err --lines 50 --nostream", "pm2 reload addinvoice-site"] },
  public_app: { sms: "yerel app (:7331) calisiyorsa nginx/Cloudflare: nginx -t ; systemctl restart nginx ; Cloudflare durumuna bak", mail: ["Yerel uygulama kontrolu de basarisizsa once onu coz (pm2 status).", "Yerel tamam ama genel adres 5xx/524 ise: nginx -t ; systemctl restart nginx ; journalctl -u nginx -n 50", "Cloudflare tarafi: cloudflarestatus.com ve DNS/SSL ayarlari"] },
  public_site: { sms: "yerel site (:7332) calisiyorsa nginx/Cloudflare: nginx -t ; systemctl restart nginx", mail: ["Yerel site kontrolu de basarisizsa once onu coz (pm2 status).", "Yerel tamam ama genel adres 5xx/524 ise: nginx -t ; systemctl restart nginx ; journalctl -u nginx -n 50"] },
  sms_gateway: { sms: null, mail: ["Telefonda SMS Gateway uygulamasini ac; internet ve pil tasarrufu istisnasini kontrol et."] },
  pgbouncer_config: { sms: null, mail: ["/etc/pgbouncer/pgbouncer.ini: degerin yanindaki ';' yorumlarini ayri satira tasi, sonra: systemctl reload pgbouncer"] },
}
const fixFor = (key) => FIX[key] ?? (key.startsWith("disk:") ? { sms: null, mail: ["Yer ac: du -xh / --max-depth=2 2>/dev/null | sort -h | tail -20", "Buyuk loglar: journalctl --vacuum-size=200M ; pm2 flush", "Eski build'ler: /var/www/addinvoice/.next-a veya .next-b'den AKTIF OLMAYAN (cat .active-dist) silinebilir", "Eski yedek/arsivler (/root/*.tar.gz, *.bak-*) elden gecirilmeli"] } : null)
// Zincirleme arızada asıl nedeni öne çıkar (ör. pgBouncer düşünce db + app + genel adres hepsi kırılır): ilk sıradaki = kök neden
const ROOT_ORDER = ["unit:postgresql@16-main", "unit:pgbouncer", "db_pooled", "unit:pm2-root", "app_instances", "app_build", "app_http", "unit:nginx", "site_http", "public_app", "public_site"]
const rootRank = (k) => { const i = ROOT_ORDER.indexOf(k); return i === -1 ? 99 : i }
// SMS: en olası kök neden + çözüm komutu (+ başka kaç kritik kontrol da bozuk). Kısa tut: ~2-3 SMS parçası.
function smsWithFix(prefix, crit) {
  const sorted = [...crit].sort((a, b) => rootRank(a.key) - rootRank(b.key))
  const top = sorted[0]
  if (!top) return null
  const f = fixFor(top.key)
  const name = top.label.replace(/\s*\(.*\)/, "")
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} kritik daha, muhtemelen ayni neden)` : ""
  return `${prefix}: ${name}${more}. Ne yap (SSH): ${f?.sms ?? "e-postadaki adimlara bak"}. Detay: e-posta`
}
// E-posta: her bozuk kontrolün altına adımlar (kök neden sırasıyla)
const describeWithFix = (list) => {
  const sorted = [...list].sort((a, b) => rootRank(a.key) - rootRank(b.key))
  const out = []
  for (const c of sorted) {
    out.push(`• ${c.label}: ${c.detail}${c.since ? ` (${hhmm(c.since)}'den beri)` : ""}`)
    const f = fixFor(c.key)
    if (f?.mail?.length) out.push("   Ne yapmalı (SSH ile sunucuda): " + f.mail.join("  →  "))
  }
  return out
}
// SMS yalnız ASCII: GSM-7'de kalsın (tek SMS), telefonlarda Türkçe/özel karakter bozulmasın
const ascii = (s) => s.replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g").replace(/[ıİ]/g, "i").replace(/[öÖ]/g, "o").replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u").replace(/[^\x20-\x7e]/g, "")

// ── Ana akış ─────────────────────────────────────────────────────────────────
const cfg = { smsTo: "+4531323462", emailTo: null, ...(readJson(USER_CFG) ?? {}) }
const TEST = process.argv.includes("--test")

async function main() {
  const now = Date.now()
  const prev = readJson(STATE_FILE) ?? {}
  const settings = await loadSettings()
  const v = settings.vals
  const emailTo = cfg.emailTo || v.ADMIN_EMAIL || "alert@addinvoice.dk"

  const BN = (process.argv.find((a) => a.startsWith("--backup-notify=")) ?? "").split("=")[1]
  if (BN) { // ops arayüzündeki deneme düğmeleri: "test" | "report" — durumu değiştirmez
    try {
      const bn = await import("./backup-notify.mjs")
      const r = await bn.sendNow({ sendEmail: (to, subject, lines, html) => sendEmail(v, to, subject, lines, html), mode: BN })
      console.log(JSON.stringify({ ok: true, ...r }))
    } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 300) })) }
    return
  }

  if (TEST) {
    const res = {}
    try { await sendEmail(v, emailTo, "TEST — izleyici uyarı kanalı", ["Bu bir deneme mesajıdır; sistemde sorun yok.", `Kaynak ayarlar: ${settings.source}`, `Zaman: ${new Date(now).toISOString()}`]); res.email = "gönderildi → " + emailTo } catch (e) { res.email = "HATA: " + e.message }
    try { await sendSms(v, cfg.smsTo, "AddInvoice TEST: izleyici SMS kanali calisiyor. Sistemde sorun yok."); res.sms = "gönderildi → " + cfg.smsTo } catch (e) { res.sms = "HATA: " + e.message }
    console.log(JSON.stringify(res)); return
  }

  let { checks, restartSum } = await checkAll(prev, v)
  const FORCE = (process.env.WATCHDOG_FORCE_FAIL || "").split(",").filter(Boolean) // yalnız test: bu anahtarlar başarısız sayılır
  const forceFail = (list) => list.map((c) => FORCE.includes(c.key) ? { ...c, ok: false, detail: "TEST: zorla başarısız" } : c)
  checks = forceFail(checks)
  if (checks.some((c) => !c.ok)) {
    await new Promise((r) => setTimeout(r, RECHECK_WAIT_MS))
    const second = await checkAll(prev, v)
    second.checks = forceFail(second.checks)
    // Yalnız İKİNCİ denemede de başarısız olanlar başarısız sayılır; ilkinde düşüp ikincide düzelen = anlık dalgalanma
    checks = second.checks.map((c) => {
      const first = checks.find((x) => x.key === c.key)
      return !c.ok && first && !first.ok ? c : { ...c, ok: true }
    })
    restartSum = second.restartSum
  }
  const prevChecks = prev.checks ?? {}
  const state = { updatedAt: now, restartSum, checks: {}, alerted: prev.alerted ?? {}, incidentStart: prev.incidentStart ?? null, lastMailAt: prev.lastMailAt ?? 0, lastSmsAt: prev.lastSmsAt ?? 0, lastError: null, settingsSource: settings.source }
  for (const c of checks) {
    const p = prevChecks[c.key]
    state.checks[c.key] = { ...c, failCount: c.ok ? 0 : (p?.failCount ?? 0) + 1, since: c.ok ? null : (p?.since ?? now) }
  }
  const all = Object.values(state.checks)
  const confirmed = all.filter((c) => !c.ok && c.failCount >= CONFIRM_RUNS)
  const alertedKeys = Object.keys(state.alerted)

  const channels = async (subject, lines, smsText) => {
    const errs = []
    let any = false
    try { await sendEmail(v, emailTo, subject, lines); any = true; state.lastMailAt = now } catch (e) { errs.push("e-posta: " + String(e.message).slice(0, 100)) }
    if (smsText) { try { await sendSms(v, cfg.smsTo, ascii(smsText)); any = true; state.lastSmsAt = now } catch (e) { errs.push("SMS: " + String(e.message).slice(0, 100)) } }
    if (errs.length) state.lastError = errs.join(" | ")
    return any
  }
  const describe = (list) => list.map((c) => `• ${c.label}: ${c.detail}${c.since ? ` (${hhmm(c.since)}'den beri)` : ""}`)

  if (confirmed.length) {
    const fresh = confirmed.filter((c) => !state.alerted[c.key])
    const crit = confirmed.filter((c) => c.severity === "critical")
    const freshCrit = fresh.filter((c) => c.severity === "critical")
    const mailGapOk = now - state.lastMailAt >= MIN_MAIL_GAP_MS
    if (fresh.length && mailGapOk) {
      if (!state.incidentStart) state.incidentStart = Math.min(...confirmed.map((c) => c.since ?? now))
      const smsText = freshCrit.length ? smsWithFix(`AddInvoice SORUN ${hhmm(now)}`, crit) : null
      const sent = await channels(`SORUN: ${confirmed.length} kontrol başarısız${crit.length ? " (kritik)" : ""}`, ["Aşağıdaki kontroller iki denemede (60 sn arayla) başarısız oldu. Zincirleme arızada ilk sıradaki muhtemel kök nedendir:", ...describeWithFix(confirmed), "", `Arıza başlangıcı (tahmini): ${hhmm(state.incidentStart)}`], smsText)
      if (sent) for (const c of confirmed) state.alerted[c.key] = { sentAt: now, severity: c.severity }
    } else if (!fresh.length) {
      if (now - state.lastMailAt >= EMAIL_REPEAT_MS) {
        const smsText = crit.length && now - state.lastSmsAt >= SMS_REPEAT_MS ? smsWithFix(`AddInvoice HALA SORUNLU ${hhmm(now)} (${dur(now - (state.incidentStart ?? now))})`, crit) : null
        await channels(`HÂLÂ SORUNLU: ${confirmed.length} kontrol (${dur(now - (state.incidentStart ?? now))})`, ["Sorun sürüyor:", ...describeWithFix(confirmed)], smsText)
      } else if (crit.length && now - state.lastSmsAt >= SMS_REPEAT_MS) {
        try { await sendSms(v, cfg.smsTo, ascii(smsWithFix(`AddInvoice HALA SORUNLU ${hhmm(now)} (${dur(now - (state.incidentStart ?? now))})`, crit))); state.lastSmsAt = now } catch (e) { state.lastError = "SMS: " + String(e.message).slice(0, 100) }
      }
    }
    // artık sorunlu olmayan anahtarları temizle
    for (const k of Object.keys(state.alerted)) if (!confirmed.find((c) => c.key === k)) delete state.alerted[k]
  } else if (alertedKeys.length) {
    const hadCritical = Object.values(state.alerted).some((a) => a.severity === "critical")
    const total = now - (state.incidentStart ?? now)
    const sent = await channels("Normale döndü", ["Tüm kontroller yeniden başarılı.", `Sorun süresi (tahmini): ${dur(total)}`, "Önceden bildirilenler: " + alertedKeys.map((k) => prevChecks[k]?.label ?? k).join(", ")], hadCritical ? `AddInvoice normale dondu ${hhmm(now)} (kesinti ~${dur(total)}).` : null)
    if (sent) { state.alerted = {}; state.incidentStart = null }
  } else {
    state.incidentStart = null
  }

  writeJson(STATE_FILE, state, 0o600)
  try { // yedek bildirimleri (hata uyarısı + günlük/haftalık özet); hata verse bile izleyicinin geri kalanını bozmaz
    const bn = await import("./backup-notify.mjs")
    const r = await bn.tick({ sendEmail: (to, subject, lines, html) => sendEmail(v, to, subject, lines, html), now: new Date(now) })
    if (r.log) console.log(r.log)
  } catch (e) { console.error("backup-notify hata:", String(e.message).slice(0, 200)) }
  const bad = all.filter((c) => !c.ok)
  console.log(`${new Date(now).toISOString()} ok=${all.length - bad.length}/${all.length}${bad.length ? " FAIL: " + bad.map((c) => `${c.key}(${c.failCount})`).join(",") : ""}${state.lastError ? " ERR: " + state.lastError : ""}`)
}
main().catch((e) => { console.error("watchdog hata:", e); process.exit(1) })
