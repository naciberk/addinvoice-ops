#!/usr/bin/env node
/**
 * AddInvoice zamanlanmış görevler motoru (26 Kas 2026) — uygulamanın /api/internal/* worker'larını çağıran görevlerin tanımı, zamanlayıcısı,
 * çalıştırıcısı, kayıtları, çakışma analizi ve eski crontab'dan taşıma.
 *
 * Neden crontab'ı arayüzden düzenlemiyoruz: web arayüzünden root crontab'a komut yazmak, panel ele geçirilirse sunucuda root komut demektir.
 * Burada yalnız İZİN LİSTESİNDEKİ worker adresleri çağrılabilir (ana uygulamanın app/api/internal klasöründen keşfedilir); keyfi komut yok.
 * Gizli anahtar (INTERNAL_WORKER_SECRET / INTERNAL_CRON_SECRET) ana uygulamanın .env dosyasından ÇALIŞMA ANINDA okunur — arayüz görmez, config'e yazılmaz.
 *
 * Hem root ajanı (import) hem cron (CLI) kullanır. Bağımlılık yok. Yedek motorunun zamanlama fonksiyonlarını (every/cron/manual) yeniden kullanır.
 * CLI:  cron-engine.mjs tick                       → her dakika cron'dan (/etc/cron.d/addinvoice-cron-tick): zamanı gelen görevleri başlatır
 *       cron-engine.mjs run <id> [--manual]        → bir görevi şimdi çalıştırır (kilit + zaman aşımı + kayıt)
 *       cron-engine.mjs plan                       → eski crontab'dan taşıma planı (hiçbir şey değiştirmez)
 *       cron-engine.mjs migrate TAŞI               → taşımayı uygular (crontab yedeklenir, tek tick satırı kurulur)
 *       cron-engine.mjs rollback                   → eski crontab'ı geri koyar, zamanlayıcıyı kapatır
 *       cron-engine.mjs next <id> [n]              → sonraki n çalışma zamanı
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { UserError, normalizeSchedule, matchesNow, nextRuns, prevRun } from "./backup-engine.mjs"

export { UserError }

// (ACR_* ortam değişkenleri yalnız testler içindir)
export const CONFIG_FILE = process.env.ACR_CONFIG || "/etc/addinvoice-cron/config.json"
export const STATE = process.env.ACR_STATE || "/var/lib/addinvoice-cron"
export const LOG_DIR = process.env.ACR_LOG || "/var/log/addinvoice-cron"
const APP_DIR = process.env.ACR_APP || "/var/www/addinvoice"
const CROND_DIR = process.env.ACR_CROND || "/etc/cron.d"
const BACKUP_DIR = process.env.ACR_BACKUPS || "/var/backups/addinvoice-cron"
const CRONTAB_FILE = process.env.ACR_CRONTAB_FILE || "" // test: `crontab` komutu yerine bu dosya
const BASE_URL_OVERRIDE = process.env.ACR_BASE_URL || ""
const TICK_FILE = "addinvoice-cron-tick"
const SELF = fileURLToPath(import.meta.url)
const MAX_CONCURRENT = Number(process.env.ACR_MAX_CONCURRENT || 6)
const RETENTION_DAYS = 30
const MAX_RUN_LINES = 60_000
export const FREQUENT_PER_DAY = 24 // günde bu kadar veya daha çok çalışan görevler "sık görev" sayılır (saatte en az bir): her zaman bir şeyle çakışırlar, haritaya girmezler

const ensureDir = (d, mode = 0o750) => fs.mkdirSync(d, { recursive: true, mode })
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return d } }
function atomicWrite(file, content, mode = 0o600) {
  ensureDir(path.dirname(file))
  const tmp = file + ".tmp-" + process.pid
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}
const pad = (n) => String(n).padStart(2, "0")
const minuteKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

// ══ Ana uygulamanın ortamı ═══════════════════════════════════════════════════
export function readAppEnv() {
  const out = {}
  try {
    for (const line of fs.readFileSync(path.join(APP_DIR, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    }
  } catch {}
  return out
}
const baseUrl = () => BASE_URL_OVERRIDE || `http://127.0.0.1:${readAppEnv().PORT || 7331}`


// ══ Açıklamalar (hangi görev ne işe yarar) ═══════════════════════════════════
// Her worker'ın kendi kodundaki başlık yorumlarından okunup kısaltıldı (26 Kas 2026). Arayüzde görevin altında gösterilir; görevin kendi "not" alanı doluysa o öne geçer.
// Listede olmayan (yeni) worker için route dosyasındaki ilk yorum satırları otomatik gösterilir.
export const WORKER_INFO = {
  "abonnement-worker": "Tekrarlayan (abonnement) satış faturalarını zamanı gelince oluşturur; kaçırılan dönemleri (en çok 12) yakalar.",
  "accountant-auto-billing-worker": "Ayın 23'ü: muhasebecinin «Automatisk forsendelse» açtığı müşterilerini otomatik faturalar (ilk fatura katılım tarihinden ay sonuna oranlanır).",
  "accountant-billing-snapshot-worker": "Günlük: her muhasebecinin o günkü yönetilen müşteri sayısını kaydeder; fatura ayın en yüksek günlük sayısına göre kesilir (fatura öncesi müşteri çıkarıp ekleyerek düşürmeyi engeller).",
  "ai-usage-overage-worker": "Günlük: kendi Stripe aboneliği olan müşterilerin birikmiş AI (banka ekstresi okuma) maliyeti eşiği geçince bir sonraki aboneliklerine ek ücret ekler.",
  "audit-log-retention-worker": "Denetim kaydı saklama süresi: önemsiz kayıtlar 12 ay, güvenlik/hesap bütünlüğü kayıtları 24 ay sonra silinir (Datatilsynet rehberine göre).",
  "bank-psd2-sync": "PSD2 (Enable Banking) banka bağlantılarını periyodik senkronize eder. Şu an PSD2 rafta; zamanlanmaması normal.",
  "bank-worker": "Yüklenen banka ekstrelerini (PDF/OCR) işler, saldo kontrolü yapar ve sonucu bildirir. Aboneliği bitmiş şirketlerin işleri bekletilir.",
  "cvr-monitor-worker": "Ayda bir: CVR-registerini kontrol edip firma bilgilerini günceller, kapanmış (ophørt) firmaları tespit eder (Sundhedstjek uyarıları).",
  "cvr-supplier-worker": "Kuyruk: bilag'dan AI'ın okuduğu CVR numarasına göre tedarikçi kaydını (leverandør) otomatik oluşturur.",
  "db-health-alert-worker": "Veritabanı sağlık raporundaki (06:15 / pazartesi 07:00) uyarıları yönetici e-postasına gönderir; aynı uyarıyı en çok 20 saatte bir tekrarlar.",
  "document-vault-billing-worker": "Aylık: muhasebeci bağlantısı olmayan (kendi kayıtlı) müşterilerin aktif Digitalt Arkiv'i için Stripe'a tek seferlik ücret kalemi ekler.",
  "document-vault-worker": "Digitalt Arkiv, günlük: (1) süresi geçen belgeleri EXPIRED yapar, (2) süre dolum hatırlatması gönderir (90/30/7 gün, belge başına pencere başına bir kez), (3) Papirkurv'da 30 günü dolan belgeleri veritabanından VE diskten KALICI siler.",
  "egenkontrol-worker": "Her 15 dk: Egenkontrol (HACCP) günlük görevlerini oluşturur, geciken görevler için e-posta/push/SMS uyarıları ve eskalasyon yapar, modül ücretini işler, saklama süresini uygular.",
  "email-import": "E-posta ile gönderilen bilag'ları (merkezi posta kutusu) içe aktarır. Anahtar adreste; ajan anahtarı ana uygulamanın .env dosyasından okur.",
  "email-log-retention-worker": "Giden e-posta günlüğünde 3 aydan eski kayıtları siler (güvence; uygulama ayrıca fırsatçı temizlik yapar).",
  "employment-contract-reminder-worker": "Günlük: imzalanmamış iş sözleşmelerinde işçiye bir kez otomatik hatırlatma gönderir.",
  "extra-usage-worker": "Günlük: SMS ve ek kullanımı ücret kalemlerine çevirir, depolama sınırlarını günceller, ay başı ölçümleri yapar, kendi Stripe aboneliği olan müşterilerin faturalanmamış kullanımını Stripe'a ekler.",
  "fixed-asset-worker": "Anlæg (duran varlık): tamamlanmış yıllar için afskrivning (amortisman) kayıtlarını oluşturur.",
  "health-check-worker": "Gece sağlık kontrolü: her müşteriyi tek tek gezmeden bulunamayan 8 sessiz hatayı (ör. dengesiz postering) tarar.",
  "imap-import-worker": "Saatlik: kendi IMAP posta kutusunu açan müşterilerin kutularından bilag'ları çeker (anlık push değil, polling).",
  "invoice-bilag-backfill": "Tek seferlik/bakım işi: fatura PDF'ini eksik postering'lere ekler. Zamanlanmaz; gerektiğinde elle çalıştırılır.",
  "loen-reminder-worker": "Günlük: eIndkomst/A-skat/AM-bidrag ve ATP (Samlet Betaling) son tarih hatırlatmalarını firma yöneticilerine gönderir; önce dosya/ödeme otomasyonunu çalıştırır.",
  "managed-extra-billing-worker": "Günlük: zamanı gelen yeniden denemeleri yapar; ayın ilk günlerinde önceki ayın ekstra kullanımını managed müşterilerin kartından tek çekimle alır.",
  "message-cleanup-worker": "Günlük: 90 günden eski ve «silinmesin» işaretsiz Beskeder alıcı kopyalarını siler.",
  "nemhandel-enrollment-worker": "Günlük: itiraz gelmeden 4 haftalık süresi dolan firmaları Nemhandel'e otomatik kaydeder ve hatırlatmaları gönderir.",
  "peppol-incoming-worker": "Gelen Peppol/e-fatura belgelerini sağlayıcıdan çekip uzlaştırır.",
  "peppol-status-worker": "Gönderilen e-fatura belgelerinin teslim durumunu sorar (90 günden eski ve hâlâ yoldakiler bırakılır).",
  "peppol-usage-overage-worker": "Günlük: kendi Stripe aboneliği olan müşterilerin birikmiş e-fatura kullanımı eşiği geçince bir sonraki aboneliklerine ek ücret ekler.",
  "periodisering-worker": "Periodiseringer: zamanı gelen dönemlendirme kayıtlarını (aylık postering) oluşturur.",
  "personal-reminder-worker": "Her dakika: kullanıcıların Luca'dan istediği kişisel hatırlatmaları zamanı gelince SMS ve/veya e-posta ile gönderir.",
  "price-publish-worker": "Günlük: yayınlanan fiyat tablosunu Stripe + Ekstra priser'den yeniden üretir (Stripe'taki değişiklik web sitesinde de görünsün).",
  "rykker-worker": "Günlük: otomatik ödeme hatırlatması/rykker açan firmalarda geciken faturalar için rykker gönderir (rentelov §9b: en az 10 gün ara).",
  "scan-worker": "Her dakika: yüklenen/e-postayla gelen fişleri ve faturaları AI ile tarar ve otomatik işler (SCAN_FILE kuyruğu).",
  "shift-reminder-worker": "Her 10 dk: Arbejdstider için vardiya öncesi SMS hatırlatması, çıkış yapmayı unutanlara SMS ve yöneticiye günlük uyarı özeti.",
  "trial-reminder-worker": "Günlük: deneme süresi bitmeden 3 gün önce, 1 gün önce ve bitiş gününde firma yöneticilerine hatırlatma gönderir.",
  "unsorted-reresolve-worker": "Bekleyen (otomatik işlenemeyen) bilag'ları AI kullanmadan yeniden çözmeyi dener (ör. eksik hesap numarası sonradan eklendiyse).",
  "weekly-summary-worker": "Haftalık: her müşteri firmanın üyelerine son 7 günün gelir/gider özeti ve önümüzdeki 7 günün ödemelerini e-postayla gönderir.",
}

/** Sistem cron satırları için açıklama (komut içindeki ipuçlarına göre). */
const SYSTEM_INFO = [
  [/backup-engine\.mjs\s+tick/, "Yedekleme zamanlayıcısı: her dakika yedek görevlerinden zamanı gelenleri başlatır (Yedekleme sayfası)."],
  [/cron-engine\.mjs\s+tick/, "Zamanlanmış görevler zamanlayıcısı: bu sayfadaki görevlerden zamanı gelenleri başlatır."],
  [/watchdog\.mjs/, "Bağımsız izleyici: panel çökse bile sunucu/veritabanı sorunlarını e-posta ve SMS ile bildirir (her 15 dk)."],
  [/pgbackrest.*--type=full/, "PostgreSQL tam yedeği (pgBackRest, pazar)."],
  [/pgbackrest.*--type=diff/, "PostgreSQL fark yedeği (pgBackRest, pazartesi-cumartesi)."],
  [/addinvoice-db-health\.sh/, "Veritabanı sağlık raporu üretir (STATUS dosyası); db-health-alert-worker uyarıları e-postaya yollar."],
  [/ops_partition_maintain/, "audit_logs tablosunun aylık bölümlerini hazırlar/temizler."],
  [/monthly-restore-drill/, "Aylık geri yükleme provası: son yedeği geçici kopyaya açıp sayar, canlıya dokunmaz."],
  [/certbot/, "Let's Encrypt sertifikalarını yeniler."],
  [/debian-sa1/, "sysstat: sistem performans istatistikleri toplar."],
  [/e2scrub/, "Dosya sistemi tutarlılık taraması (e2scrub)."],
  [/ip route replace/, "Açılışta statik rota ayarı."],
]
export const systemInfo = (cmd) => SYSTEM_INFO.find(([re]) => re.test(cmd))?.[1] ?? null

// ══ Worker keşfi (izin listesi) ══════════════════════════════════════════════
/** app/api/internal/<ad>/route.ts → {name, method, auth, description}. Yalnız kimlik doğrulaması olan route'lar çağrılabilir. */
export function discoverWorkers() {
  const root = path.join(APP_DIR, "app/api/internal")
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)) } catch { return out }
  for (const d of dirs) {
    let src = ""
    try { src = fs.readFileSync(path.join(root, d.name, "route.ts"), "utf8") } catch { continue }
    const methods = [...src.matchAll(/export\s+async\s+function\s+(GET|POST)\b/g)].map((m) => m[1])
    if (!methods.length) continue
    const auth = /x-worker-secret/i.test(src) ? "header" : /cronSecret|searchParams\.get\(["']key["']\)/.test(src) ? "key" : null
    if (!auth) continue
    const comment = src.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("//") && !/^\/\/\s*(eslint|@ts)/i.test(l)).slice(0, 2).map((l) => l.replace(/^\/\/+\s*/, "")).join(" ").slice(0, 220)
    out.push({ name: d.name, method: methods.includes("POST") ? "POST" : "GET", auth, description: WORKER_INFO[d.name] ?? comment, curated: d.name in WORKER_INFO })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ══ Yapılandırma ═════════════════════════════════════════════════════════════
export function loadConfig() {
  const c = readJson(CONFIG_FILE, null)
  return c && Array.isArray(c.jobs) ? c : { version: 1, enabled: false, jobs: [] }
}

export function validateJob(j, { workers = discoverWorkers(), existing = [] } = {}) {
  if (!j || typeof j !== "object") throw new UserError("Görev eksik")
  const target = String(j.target ?? "")
  const w = workers.find((x) => x.name === target)
  if (!w) throw new UserError(`Bilinmeyen worker: ${target.slice(0, 60)} (yalnız ana uygulamadaki /api/internal/* adresleri çağrılabilir)`)
  const name = String(j.name ?? "").trim().slice(0, 80) || target
  let id = String(j.id ?? "")
  if (!id) {
    const base = target.slice(0, 44)
    id = base
    for (let i = 2; existing.some((e) => e.id === id); i++) id = `${base}-${i}`
  }
  if (!ID_RE.test(id)) throw new UserError("Görev kimliği: küçük harf/rakam/-, en çok 48")
  const timeoutSec = j.timeoutSec == null ? 300 : Number(j.timeoutSec)
  if (!Number.isInteger(timeoutSec) || timeoutSec < 5 || timeoutSec > 1800) throw new UserError("Zaman aşımı 5-1800 saniye olmalı")
  const schedule = normalizeSchedule(j.schedule?.source ?? j.schedule)
  return {
    id, name, target, method: w.method, auth: w.auth, enabled: j.enabled !== false, schedule, timeoutSec,
    note: String(j.note ?? "").slice(0, 200),
    createdAt: j.createdAt && !isNaN(Date.parse(j.createdAt)) ? j.createdAt : nowIso(),
    ...(j.importedFrom ? { importedFrom: String(j.importedFrom).slice(0, 40) } : {}),
  }
}

export function saveConfig(cfg, actor = "?") {
  if (!cfg || !Array.isArray(cfg.jobs)) throw new UserError("Yapılandırma biçimi geçersiz")
  if (cfg.jobs.length > 100) throw new UserError("Çok fazla görev (en çok 100)")
  const workers = discoverWorkers()
  const seen = []
  const jobs = cfg.jobs.map((j) => { const v = validateJob(j, { workers, existing: seen }); if (seen.some((s) => s.id === v.id)) throw new UserError("Görev kimliği tekrarlanıyor: " + v.id); seen.push(v); return v })
  const out = { version: 1, enabled: cfg.enabled === true, jobs, savedAt: nowIso(), savedBy: actor }
  atomicWrite(CONFIG_FILE, JSON.stringify(out, null, 2))
  return out
}

export function upsertJob(input, actor) {
  const cfg = loadConfig()
  const isNew = !input.id || !cfg.jobs.some((j) => j.id === input.id)
  if (input.id && isNew && cfg.jobs.some((j) => j.id === input.id)) throw new UserError("Bu kimlikte görev var")
  const v = validateJob({ ...input, createdAt: isNew ? undefined : cfg.jobs.find((j) => j.id === input.id)?.createdAt }, { existing: cfg.jobs.filter((j) => j.id !== input.id) })
  const jobs = isNew ? [...cfg.jobs, v] : cfg.jobs.map((j) => (j.id === input.id ? v : j))
  return { job: v, config: saveConfig({ ...cfg, jobs }, actor), created: isNew }
}
export function deleteJob(id, actor) {
  const cfg = loadConfig()
  if (!cfg.jobs.some((j) => j.id === id)) throw new UserError("Görev bulunamadı")
  const out = saveConfig({ ...cfg, jobs: cfg.jobs.filter((j) => j.id !== id) }, actor)
  for (const f of [`${STATE}/state/${id}.json`, `${STATE}/ticks/${id}`]) try { fs.unlinkSync(f) } catch {}
  return out
}
export function setJobEnabled(id, enabled, actor) {
  const cfg = loadConfig()
  if (!cfg.jobs.some((j) => j.id === id)) throw new UserError("Görev bulunamadı")
  return saveConfig({ ...cfg, jobs: cfg.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)) }, actor)
}

// ══ Çalıştırıcı ══════════════════════════════════════════════════════════════
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }

/** Dosya tabanlı kilit (O_EXCL). Sahibi ölmüşse veya süresi dolmuşsa devralınır. Dönüş: bırakma fonksiyonu | null (meşgul). */
function takeLock(file, ttlMs) {
  ensureDir(path.dirname(file))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600)
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), until: Date.now() + ttlMs }))
      fs.closeSync(fd)
      return () => { try { fs.unlinkSync(file) } catch {} }
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      const cur = readJson(file, null)
      if (cur && alive(cur.pid) && Date.now() < cur.until) return null
      try { fs.unlinkSync(file) } catch {}
    }
  }
  return null
}
/** Aynı anda en çok MAX_CONCURRENT görev (hepsi aynı dakikada patlamasın). Bekler; süre dolarsa null. */
async function takeSlot(waitMs, ttlMs) {
  const until = Date.now() + waitMs
  for (;;) {
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      const rel = takeLock(`${STATE}/slots/${i}.lock`, ttlMs)
      if (rel) return rel
    }
    if (Date.now() >= until) return null
    await sleep(1500)
  }
}

function recordRun(job, rec) {
  ensureDir(`${STATE}/runs`)
  ensureDir(`${STATE}/state`)
  fs.appendFileSync(`${STATE}/runs/${job.id}.jsonl`, JSON.stringify(rec) + "\n", { mode: 0o600 })
  const prev = readJson(`${STATE}/state/${job.id}.json`, {})
  const st = {
    lastRun: rec,
    lastOkAt: rec.outcome === "ok" ? rec.ts : prev.lastOkAt ?? null,
    consecutiveFailures: rec.outcome === "fail" ? (prev.consecutiveFailures ?? 0) + 1 : rec.outcome === "ok" ? 0 : prev.consecutiveFailures ?? 0,
  }
  atomicWrite(`${STATE}/state/${job.id}.json`, JSON.stringify(st))
  return st
}

/** Bir görevi çalıştırır. Dönüş: kayıt (outcome: ok | fail | skipped). Aynı görev hâlâ çalışıyorsa İKİNCİSİ BAŞLAMAZ (skipped/overlap). */
export async function runJob(id, { manual = false, delayMs = 0, slot = null } = {}) {
  if (delayMs > 0) await sleep(delayMs)
  const job = loadConfig().jobs.find((j) => j.id === id)
  if (!job) throw new UserError("Görev bulunamadı: " + id)
  const base = { ts: nowIso(), job: id, trigger: manual ? "manual" : "schedule", slot: slot ?? null }
  const ttl = job.timeoutSec * 1000 + 60_000
  const rel = takeLock(`${STATE}/locks/${id}.lock`, ttl)
  if (!rel) { const rec = { ...base, outcome: "skipped", reason: "overlap", message: "Önceki çalışma hâlâ sürüyor — bu tur atlandı" }; recordRun(job, rec); return rec }
  let relSlot = null
  try {
    relSlot = await takeSlot(50_000, ttl)
    if (!relSlot) { const rec = { ...base, outcome: "skipped", reason: "busy", message: `Aynı anda çalışan görev sınırı (${MAX_CONCURRENT}) dolu — bu tur atlandı` }; recordRun(job, rec); return rec }
    const env = readAppEnv()
    const secret = job.auth === "key" ? env.INTERNAL_CRON_SECRET : env.INTERNAL_WORKER_SECRET
    if (!secret) { const rec = { ...base, outcome: "fail", ms: 0, message: `${job.auth === "key" ? "INTERNAL_CRON_SECRET" : "INTERNAL_WORKER_SECRET"} ana uygulamanın .env dosyasında bulunamadı` }; recordRun(job, rec); return rec }
    const url = `${baseUrl()}/api/internal/${job.target}${job.auth === "key" ? `?key=${encodeURIComponent(secret)}` : ""}`
    const t0 = Date.now()
    let rec
    try {
      const res = await fetch(url, { method: job.method, headers: job.auth === "header" ? { "x-worker-secret": secret } : {}, signal: AbortSignal.timeout(job.timeoutSec * 1000) })
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)
      rec = { ...base, outcome: res.ok ? "ok" : "fail", status: res.status, ms: Date.now() - t0, ...(body ? { message: body } : {}) }
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError"
      rec = { ...base, outcome: "fail", ms: Date.now() - t0, message: timeout ? `Zaman aşımı (${job.timeoutSec} sn)` : `Bağlantı hatası: ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 160)}` }
    }
    recordRun(job, rec)
    return rec
  } finally {
    relSlot?.()
    rel()
  }
}

export function spawnRun(id, { manual = false, delayMs = 0, slot = null } = {}) {
  ensureDir(LOG_DIR)
  const out = fs.openSync(`${LOG_DIR}/runs.log`, "a")
  const args = [SELF, "run", id, ...(manual ? ["--manual"] : []), ...(delayMs ? [`--delay=${delayMs}`] : []), ...(slot ? [`--slot=${slot}`] : [])]
  const p = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] })
  p.unref()
}

// ══ Zamanlayıcı (dakikada bir) ═══════════════════════════════════════════════
export const isFrequent = (s) => s.minutes.length * s.hours.length >= FREQUENT_PER_DAY

/** Zamanı gelen görevleri ayrı süreç olarak başlatır. Aynı dakikada birden çok görev varsa 1,5 sn arayla başlatılır (en çok 20 sn). */
export function tick(now = new Date(), { spawn: doSpawn = spawnRun } = {}) {
  ensureDir(STATE)
  atomicWrite(`${STATE}/heartbeat`, nowIso())
  const cfg = loadConfig()
  if (!cfg.enabled) return { started: [], disabled: true }
  const key = minuteKey(now)
  ensureDir(`${STATE}/ticks`)
  const started = []
  let i = 0
  for (const job of cfg.jobs) {
    if (!job.enabled || !matchesNow(job.schedule, now)) continue
    const mark = `${STATE}/ticks/${job.id}`
    if (fs.existsSync(mark) && fs.readFileSync(mark, "utf8") === key) continue
    fs.writeFileSync(mark, key)
    doSpawn(job.id, { delayMs: Math.min(i * 1500, 20_000), slot: key })
    started.push(job.id)
    i++
  }
  if (now.getHours() === 4 && now.getMinutes() === 17) { try { pruneRuns(now) } catch (e) { console.error("prune", e) } }
  return { started, disabled: false }
}

/** 30 günden eski çalışma kayıtlarını siler (ve her dosyayı en çok MAX_RUN_LINES satırla sınırlar). */
export function pruneRuns(now = new Date(), days = RETENTION_DAYS) {
  const dir = `${STATE}/runs`
  let n = 0
  if (!fs.existsSync(dir)) return 0
  const cutoff = now.getTime() - days * 86_400_000
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const file = path.join(dir, f)
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).ts) >= cutoff } catch { return false } }).slice(-MAX_RUN_LINES)
    if (keep.length !== lines.length) { atomicWrite(file, keep.length ? keep.join("\n") + "\n" : ""); n += lines.length - keep.length }
  }
  return n
}

export function history(id, limit = 50) {
  if (!ID_RE.test(String(id))) throw new UserError("Geçersiz kimlik")
  let lines = []
  try { lines = fs.readFileSync(`${STATE}/runs/${id}.jsonl`, "utf8").split("\n").filter(Boolean) } catch {}
  return lines.slice(-Math.min(Math.max(Number(limit) || 50, 1), 500)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
}

/** Son 24 saatteki başarılı/başarısız/atlanan sayısı. */
export function stats24h(id, now = new Date()) {
  const since = now.getTime() - 86_400_000
  const out = { ok: 0, fail: 0, skipped: 0 }
  let text = ""
  try { text = fs.readFileSync(`${STATE}/runs/${id}.jsonl`, "utf8") } catch { return out }
  for (const l of text.split("\n")) {
    if (!l) continue
    try { const r = JSON.parse(l); if (Date.parse(r.ts) >= since && r.outcome in out) out[r.outcome]++ } catch {}
  }
  return out
}

// ══ Sistem cron'ları (salt-okunur) ═══════════════════════════════════════════
const MACROS = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" }
export const maskSecrets = (s) => String(s).replace(/(x-worker-secret:\s*)[^\s'"]+/gi, "$1***").replace(/([?&](?:key|token|secret)=)[^\s'"&]+/gi, "$1***")

function labelOf(cmd) {
  const m = cmd.match(/\/api\/internal\/([a-z0-9-]+)/)
  if (m) return m[1]
  const toks = cmd.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""))
  const script = toks.find((t) => /^\/.*\.(mjs|js|sh|py|ts)$/.test(t))
  if (script) return path.basename(script)
  const bin = toks.find((t) => ["pgbackrest", "certbot", "psql", "debian-sa1", "e2scrub_all", "e2scrub_all_cron", "ip"].includes(path.basename(t)))
  if (bin) return path.basename(bin)
  const rest = toks.find((t) => t.startsWith("/") && !/\.(lock|log)$/.test(t) && !t.startsWith("/dev/") && !["flock", "node"].includes(path.basename(t)))
  return (rest ? path.basename(rest) : cmd).slice(0, 60)
}
function parseCronLine(line, { withUser }) {
  const t = line.trim()
  if (!t || t.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return null
  const f = t.split(/\s+/)
  let expr, rest
  if (f[0].startsWith("@")) { expr = MACROS[f[0]] ?? f[0]; rest = f.slice(1) } else { expr = f.slice(0, 5).join(" "); rest = f.slice(5) }
  if (!f[0].startsWith("@") && f.length < 6) return null
  const user = withUser ? rest.shift() : "root"
  const command = rest.join(" ")
  return { expr, user, command }
}
function scheduleOf(expr) {
  if (expr === "@reboot") return { schedule: null, why: "açılışta (@reboot)" }
  try { return { schedule: normalizeSchedule({ kind: "cron", expr }), why: null } } catch (e) { return { schedule: null, why: String(e.message).slice(0, 120) } }
}

export function readCrontab() {
  if (CRONTAB_FILE) { try { return fs.readFileSync(CRONTAB_FILE, "utf8") } catch { return "" } }
  try { return execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } catch { return "" }
}
export function writeCrontab(text) {
  if (CRONTAB_FILE) { fs.writeFileSync(CRONTAB_FILE, text); return }
  execFileSync("crontab", ["-"], { input: text, encoding: "utf8" })
}

/** /etc/cron.d/* ve (taşınmamış) root crontab satırları. */
export function systemCrons({ skipMigratable = false } = {}) {
  const out = []
  const push = (source, p, lineNo) => {
    const s = scheduleOf(p.expr)
    out.push({ id: `${source}:${lineNo}`, source, user: p.user, expr: p.expr, label: labelOf(p.command), info: systemInfo(p.command) ?? WORKER_INFO[labelOf(p.command)] ?? null, command: maskSecrets(p.command).slice(0, 300), schedule: s.schedule, unparsed: s.why, ours: source === `cron.d/${TICK_FILE}` })
  }
  let files = []
  try { files = fs.readdirSync(CROND_DIR).filter((f) => !f.startsWith(".") && !f.endsWith("~") && /^[A-Za-z0-9_-]+$/.test(f)).sort() } catch {}
  for (const f of files) {
    let text = ""
    try { text = fs.readFileSync(path.join(CROND_DIR, f), "utf8") } catch { continue }
    text.split("\n").forEach((line, i) => { const p = parseCronLine(line, { withUser: true }); if (p) push(`cron.d/${f}`, p, i + 1) })
  }
  readCrontab().split("\n").forEach((line, i) => {
    const p = parseCronLine(line, { withUser: false })
    if (!p) return
    if (skipMigratable && matchWorkerCommand(p.command)) return
    push("root crontab", p, i + 1)
  })
  return out
}

// ══ Çakışma analizi ══════════════════════════════════════════════════════════
function activeItems() {
  const cfg = loadConfig()
  const items = []
  if (cfg.enabled) for (const j of cfg.jobs) if (j.enabled) items.push({ key: `job:${j.id}`, name: j.name, kind: "managed", schedule: j.schedule })
  for (const c of systemCrons()) if (c.schedule && !c.ours) items.push({ key: `sys:${c.id}`, name: c.label, kind: "system", schedule: c.schedule })
  return items
}

/** Verilen günün her dakikası için, o dakikada çalışan (sık olmayan) görevler. */
export function dayGrid(dateStr, items = activeItems()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr))
  if (!m) throw new UserError("Tarih YYYY-AA-GG olmalı")
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const frequent = items.filter((i) => isFrequent(i.schedule))
  const regular = items.filter((i) => !isFrequent(i.schedule))
  const cells = new Array(1440).fill(0)
  const at = {}
  for (let h = 0; h < 24; h++) for (let mi = 0; mi < 60; mi++) {
    const when = new Date(y, mo, d, h, mi)
    const names = regular.filter((i) => matchesNow(i.schedule, when)).map((i) => i.name)
    if (names.length) { cells[h * 60 + mi] = names.length; at[h * 60 + mi] = names }
  }
  const collisions = Object.entries(at).filter(([, n]) => n.length >= 2).map(([k, n]) => ({ minute: `${pad(Math.floor(k / 60))}:${pad(k % 60)}`, names: n }))
  return { date: dateStr, cells, at, collisions, frequent: frequent.map((f) => ({ name: f.name, kind: f.kind, perDay: f.schedule.minutes.length * f.schedule.hours.length })), total: regular.length + frequent.length }
}

/** Yeni/değişen bir zamanlamanın önümüzdeki 7 gündeki çakışmaları (başka sık olmayan görevlerle aynı dakika). */
export function previewSchedule(input, { excludeId = null, count = 6 } = {}) {
  const s = normalizeSchedule(input)
  const next = nextRuns(s, new Date(), count).map((d) => d.toISOString())
  const perDay = s.minutes.length * s.hours.length
  const frequent = isFrequent(s)
  const collisions = []
  if (!frequent) {
    const others = activeItems().filter((i) => i.key !== `job:${excludeId}` && !isFrequent(i.schedule))
    const end = Date.now() + 7 * 86_400_000
    for (const t of nextRuns(s, new Date(), 400)) {
      if (t.getTime() > end || collisions.length >= 8) break
      const with_ = others.filter((i) => matchesNow(i.schedule, t)).map((i) => i.name)
      if (with_.length) collisions.push({ at: t.toISOString(), with: with_ })
    }
  }
  return { next, perDay, frequent, collisions }
}

/** "Günlük, şu saatte" için en boş dakikalar (önümüzdeki 7 günün toplam yüküne göre; :00/:15/:30/:45 ve 5'in katları hafif cezalı). */
export function suggestSlots({ hour = null, excludeId = null, count = 6 } = {}) {
  if (hour != null && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) throw new UserError("Saat 0-23")
  const items = activeItems().filter((i) => i.key !== `job:${excludeId}` && !isFrequent(i.schedule))
  const start = new Date()
  const load = new Map()
  for (let dd = 0; dd < 7; dd++) {
    const base = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dd)
    for (const h of hour == null ? Array.from({ length: 24 }, (_, i) => i) : [hour]) for (let mi = 0; mi < 60; mi++) {
      const when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi)
      const n = items.filter((i) => matchesNow(i.schedule, when)).length
      if (n) load.set(h * 60 + mi, (load.get(h * 60 + mi) ?? 0) + n)
    }
  }
  const slots = []
  for (const h of hour == null ? Array.from({ length: 24 }, (_, i) => i) : [hour]) for (let mi = 0; mi < 60; mi++) {
    const k = h * 60 + mi
    const score = (load.get(k) ?? 0) + 0.5 * ((load.get(k - 1) ?? 0) + (load.get(k + 1) ?? 0)) + (mi % 15 === 0 ? 0.6 : mi % 5 === 0 ? 0.3 : 0)
    slots.push({ hour: h, minute: mi, score, load: load.get(k) ?? 0 })
  }
  return slots.sort((a, b) => a.score - b.score || a.hour - b.hour || a.minute - b.minute).slice(0, count)
}

// ══ Eski crontab'dan taşıma ══════════════════════════════════════════════════
/** `curl -s [-X POST] http://localhost:PORT/api/internal/<ad>[?key=…] [-H 'x-worker-secret: …'] > /dev/null 2>&1` biçimini tanır; başka her şey taşınmaz. */
export function matchWorkerCommand(cmd) {
  const m = cmd.trim().match(/^curl\s+((?:-[sS]\s+|-X\s+(?:POST|GET)\s+)*)["']?https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/api\/internal\/([a-z0-9-]+)(\?key=[^\s"']+)?["']?((?:\s+-H\s+'x-worker-secret:\s*[^']*')?)\s*(?:>\s*\/dev\/null\s+2>&1)?\s*$/)
  if (!m) return null
  const flags = m[1].trim()
  const method = /-X\s+(POST|GET)/.exec(flags)?.[1] ?? (m[3] ? "GET" : "GET")
  return { name: m[2], method, hasKey: !!m[3], hasHeader: !!m[4] }
}

export function migratePlan() {
  const workers = discoverWorkers()
  const cfg = loadConfig()
  const lines = readCrontab().split("\n")
  const items = []
  lines.forEach((line, i) => {
    const p = parseCronLine(line, { withUser: false })
    if (!p) return
    const w = matchWorkerCommand(p.command)
    if (!w) { items.push({ lineNo: i + 1, expr: p.expr, command: maskSecrets(p.command).slice(0, 160), status: "keep", reason: "Worker çağrısı değil — olduğu gibi kalır (Sistem cron'ları sekmesinde görünür)" }); return }
    const found = workers.find((x) => x.name === w.name)
    if (!found) { items.push({ lineNo: i + 1, expr: p.expr, name: w.name, status: "keep", reason: "Ana uygulamada böyle bir worker adresi yok — dokunulmadı" }); return }
    if (found.method !== w.method && !(found.method === "POST" && w.method === "GET")) { items.push({ lineNo: i + 1, expr: p.expr, name: w.name, status: "keep", reason: `Yöntem uyuşmuyor (satır ${w.method}, route ${found.method})` }); return }
    let sched
    try { sched = normalizeSchedule({ kind: "cron", expr: p.expr }) } catch (e) { items.push({ lineNo: i + 1, expr: p.expr, name: w.name, status: "keep", reason: "Zamanlama çözülemedi: " + e.message }); return }
    const dup = cfg.jobs.find((j) => j.target === w.name && JSON.stringify(j.schedule.source) === JSON.stringify(sched.source))
    items.push({ lineNo: i + 1, expr: p.expr, name: w.name, method: found.method, auth: found.auth, status: dup ? "duplicate" : "migrate", reason: dup ? "Aynı görev zaten tanımlı" : null, perDay: sched.minutes.length * sched.hours.length })
  })
  const migratable = items.filter((x) => x.status === "migrate" || x.status === "duplicate")
  const secretOk = !!readAppEnv().INTERNAL_WORKER_SECRET
  const keyOk = !!readAppEnv().INTERNAL_CRON_SECRET
  const problems = []
  if (!secretOk) problems.push("INTERNAL_WORKER_SECRET ana uygulamanın .env dosyasında bulunamadı")
  if (migratable.some((x) => x.auth === "key") && !keyOk) problems.push("INTERNAL_CRON_SECRET (email-import) .env dosyasında bulunamadı")
  return { items, migratable: migratable.length, keep: items.filter((x) => x.status === "keep").length, problems, enabled: loadConfig().enabled, backups: listBackups() }
}
function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter((f) => /^crontab\.\d{8}-\d{6}$/.test(f)).sort().reverse().slice(0, 10) } catch { return [] }
}
const stampNow = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export function installTick() {
  const text = `# AddInvoice zamanlanmış görevler (ops konsolu → Zamanlanmış görevler). Elle düzenleme: görevler arayüzden yönetilir.\n# Kaldırmak için arayüzde «Zamanlayıcıyı durdur» (eski crontab için: «Geri al»).\n* * * * * root /usr/bin/flock -n /run/addinvoice-cron-tick.lock /usr/bin/node ${SELF} tick >> ${LOG_DIR}/tick.log 2>&1\n`
  ensureDir(LOG_DIR)
  ensureDir(CROND_DIR, 0o755)
  const file = path.join(CROND_DIR, TICK_FILE)
  atomicWrite(file, text, 0o644)
  fs.chmodSync(file, 0o644)
}
export function removeTick() { try { fs.unlinkSync(path.join(CROND_DIR, TICK_FILE)) } catch {} }
export const tickInstalled = () => fs.existsSync(path.join(CROND_DIR, TICK_FILE))

/** Zamanlayıcıyı açar/kapatır (taşımadan bağımsız). Açarken: aynı worker hâlâ eski crontab'da duruyorsa ÇİFT ÇALIŞMA olur — reddedilir. */
export function setSchedulerEnabled(enabled, actor) {
  const cfg = loadConfig()
  if (enabled) {
    const plan = migratePlan()
    const dups = plan.items.filter((x) => x.status === "duplicate").map((x) => x.name)
    if (dups.length) throw new UserError(`Şu görevler hem eski crontab'da hem burada tanımlı, açarsanız İKİ KEZ çalışır: ${[...new Set(dups)].join(", ")}. Önce «Eski crontab'dan taşı» ile taşıyın.`)
    installTick()
  } else removeTick()
  return saveConfig({ ...cfg, enabled }, actor)
}

/** Taşıma: görevleri içe aktarır, eski worker satırlarını crontab'dan çıkarır (diğer satırlara dokunmaz), tek tick satırını kurar. Güvenli pencere dışında reddeder. */
export function migrateApply(confirm, actor, now = new Date()) {
  if (confirm !== "TAŞI") throw new UserError("Onay için TAŞI yazın")
  const plan = migratePlan()
  if (plan.problems.length) throw new UserError(plan.problems.join("; "))
  const todo = plan.items.filter((x) => x.status === "migrate" || x.status === "duplicate")
  if (!todo.length) throw new UserError("Taşınacak worker satırı yok")
  // Güvenli pencere: eski satırlar kalkıp tick kurulurken bir görev dilimi kaçmasın / ikilenmesin.
  for (const x of todo) {
    if (x.perDay >= FREQUENT_PER_DAY) continue
    const s = normalizeSchedule({ kind: "cron", expr: x.expr })
    for (const off of [-1, 0, 1, 2]) if (matchesNow(s, new Date(now.getTime() + off * 60_000))) throw new UserError(`Şu an güvenli pencere değil: ${x.name} (${x.expr}) bir dakika içinde çalışacak. Birkaç dakika sonra tekrar deneyin.`)
  }
  const original = readCrontab()
  ensureDir(BACKUP_DIR, 0o700)
  const backupFile = path.join(BACKUP_DIR, `crontab.${stampNow(now)}`)
  atomicWrite(backupFile, original, 0o600)

  const cfg = loadConfig()
  const jobs = [...cfg.jobs]
  for (const x of todo) {
    if (x.status === "duplicate") continue
    const w = discoverWorkers().find((y) => y.name === x.name)
    jobs.push(validateJob({ target: x.name, name: x.name, schedule: { kind: "cron", expr: x.expr }, timeoutSec: 300, enabled: true, importedFrom: "crontab", note: w?.description ? "" : "" }, { existing: jobs }))
  }
  const dropLines = new Set(todo.map((x) => x.lineNo))
  const kept = original.split("\n").filter((_, i) => !dropLines.has(i + 1))
  const header = "# Worker görevleri ops konsolundan yönetiliyor (Zamanlanmış görevler). Eski satırların yedeği: " + backupFile
  const newCrontab = (kept.some((l) => l.startsWith("# Worker görevleri ops konsolundan")) ? kept : [header, ...kept]).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n")
  try {
    saveConfig({ ...cfg, jobs, enabled: false }, actor)
    writeCrontab(newCrontab)
    installTick()
    saveConfig({ ...cfg, jobs, enabled: true }, actor)
  } catch (e) {
    try { writeCrontab(original) } catch {}
    try { removeTick() } catch {}
    try { saveConfig({ ...cfg, enabled: false }, actor) } catch {}
    throw new UserError("Taşıma başarısız, eski crontab geri konuldu: " + String(e?.message ?? e).slice(0, 200))
  }
  return { migrated: todo.filter((x) => x.status === "migrate").length, duplicates: todo.filter((x) => x.status === "duplicate").length, backupFile }
}

export function migrateRollback(actor) {
  const b = listBackups()[0]
  if (!b) throw new UserError("Geri konacak crontab yedeği yok")
  const text = fs.readFileSync(path.join(BACKUP_DIR, b), "utf8")
  const cfg = loadConfig()
  saveConfig({ ...cfg, enabled: false }, actor) // önce zamanlayıcıyı kapat: çift çalışma olmasın
  removeTick()
  writeCrontab(text)
  return { restored: b }
}

// ══ Özet (arayüz için) ═══════════════════════════════════════════════════════
export function overview(now = new Date()) {
  const cfg = loadConfig()
  const heartbeat = (() => { try { return fs.readFileSync(`${STATE}/heartbeat`, "utf8").trim() } catch { return null } })()
  const workers = discoverWorkers()
  const jobs = cfg.jobs.map((j) => {
    const st = readJson(`${STATE}/state/${j.id}.json`, {})
    const lock = readJson(`${STATE}/locks/${j.id}.lock`, null)
    return {
      ...j,
      next: j.enabled && cfg.enabled ? nextRuns(j.schedule, now, 3).map((d) => d.toISOString()) : [],
      lastSlot: prevRun(j.schedule, now)?.toISOString() ?? null,
      state: { lastRun: st.lastRun ?? null, lastOkAt: st.lastOkAt ?? null, consecutiveFailures: st.consecutiveFailures ?? 0, running: !!(lock && alive(lock.pid) && Date.now() < lock.until) },
      stats24h: stats24h(j.id, now),
      frequent: isFrequent(j.schedule),
      description: j.note || workers.find((w) => w.name === j.target)?.description || "",
    }
  })
  const scheduled = new Set(cfg.jobs.map((j) => j.target))
  const legacy = systemCrons().filter((c) => matchWorkerCommand(c.command.replace(/\*\*\*/g, "x")) )
  const legacyTargets = new Set(legacy.map((c) => c.label))
  return {
    enabled: cfg.enabled, tickInstalled: tickInstalled(), heartbeat, jobs, workers,
    unscheduled: workers.filter((w) => !scheduled.has(w.name) && !legacyTargets.has(w.name)),
    legacyLines: legacy.length, savedAt: cfg.savedAt ?? null, savedBy: cfg.savedBy ?? null,
  }
}

/** Genel bakış için uyarılar: zamanlayıcı sustuysa, art arda başarısız / uzun süredir çalışmamış görev varsa. */
export function health(now = new Date()) {
  const cfg = loadConfig()
  const out = []
  if (!cfg.enabled) return out
  const hb = (() => { try { return Date.parse(fs.readFileSync(`${STATE}/heartbeat`, "utf8")) } catch { return NaN } })()
  if (!(hb > now.getTime() - 3 * 60_000)) out.push({ key: "cron:tick", severity: "bad", message: "Zamanlayıcı çalışmıyor: son nabız 3 dakikadan eski (cron: /etc/cron.d/addinvoice-cron-tick)" })
  for (const j of cfg.jobs) {
    if (!j.enabled) continue
    const st = readJson(`${STATE}/state/${j.id}.json`, {})
    if ((st.consecutiveFailures ?? 0) >= 3) out.push({ key: `cron:${j.id}`, severity: "bad", message: `Görev "${j.name}" art arda ${st.consecutiveFailures} kez başarısız: ${(st.lastRun?.message ?? "").slice(0, 100)}` })
    else if (st.consecutiveFailures === 1 || st.consecutiveFailures === 2) out.push({ key: `cron:${j.id}`, severity: "warn", message: `Görev "${j.name}" son çalışmada başarısız: ${(st.lastRun?.message ?? "").slice(0, 100)}` })
    const slot = prevRun(j.schedule, now)
    const last = st.lastRun ? Date.parse(st.lastRun.ts) : null
    if (slot && !isFrequent(j.schedule) && now.getTime() - slot.getTime() > 20 * 60_000 && (last == null || last < slot.getTime() - 60_000) && Date.parse(j.createdAt) < slot.getTime() - 60_000 && now.getTime() - (Date.parse(cfg.savedAt) || 0) > 20 * 60_000)
      out.push({ key: `cron:missed:${j.id}`, severity: "warn", message: `Görev "${j.name}" ${slot.toLocaleString("sv-SE")} diliminde çalışmamış görünüyor` })
  }
  return out
}

// ══ CLI ══════════════════════════════════════════════════════════════════════
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  const [cmd, a, b] = process.argv.slice(2)
  const flag = (n) => process.argv.find((x) => x.startsWith(`--${n}=`))?.split("=")[1]
  try {
    if (cmd === "tick") { const r = tick(); if (r.started.length) console.log(`[${new Date().toLocaleString("sv-SE")}] başlatıldı: ${r.started.join(", ")}`) }
    else if (cmd === "run") { const r = await runJob(a, { manual: process.argv.includes("--manual"), delayMs: Number(flag("delay")) || 0, slot: flag("slot") || null }); console.log(`[${new Date().toLocaleString("sv-SE")}] ${a}: ${r.outcome}${r.status ? " " + r.status : ""}${r.ms != null ? " " + r.ms + "ms" : ""}${r.message && r.outcome !== "ok" ? " — " + r.message : ""}`) }
    else if (cmd === "plan") console.log(JSON.stringify(migratePlan(), null, 2))
    else if (cmd === "migrate") console.log(JSON.stringify(migrateApply(a, "cli"), null, 2))
    else if (cmd === "rollback") console.log(JSON.stringify(migrateRollback("cli"), null, 2))
    else if (cmd === "next") console.log(nextRuns(loadConfig().jobs.find((j) => j.id === a).schedule, new Date(), Number(b) || 5).map((d) => d.toLocaleString("sv-SE")).join("\n"))
    else { console.error("Kullanım: tick | run <id> [--manual] | plan | migrate TAŞI | rollback | next <id> [n]"); process.exit(64) }
  } catch (e) { console.error(e instanceof UserError ? e.message : e); process.exit(1) }
}
