/**
 * Yedek bildirimleri (24 Kas 2026) — bağımsız izleyiciden (watchdog.mjs, cron, 15 dakikada bir) çağrılır; ops uygulaması çökse de çalışır.
 *
 * Üç tür e-posta (ayarlar /etc/addinvoice-backup/notify.json, Ops → Yedekleme → Bildirimler):
 *   • HATA UYARISI: bir görev bir hedefte art arda N kez başarısız olur ya da planlı yedek hiç alınmazsa → tek e-posta (aynı turdaki
 *     tüm yeni sorunlar birleşir); düzelince "düzeldi" e-postası. Aynı sorun için tekrar tekrar e-posta GİTMEZ (günlük özet hatırlatır).
 *   • GÜNLÜK ÖZET: seçilen saatte, son 24 saatin tablosu. "Yalnız sorun varsa" seçilebilir.
 *   • HAFTALIK ÖZET: seçilen gün+saatte, son 7 gün.
 * Durum: /var/lib/addinvoice-backup/notify-state.json. E-posta gönderilemezse işaretlenmez → sonraki turda yeniden denenir.
 */
import fs from "node:fs"
import path from "node:path"
import * as BE from "./backup-engine.mjs"

const STATE_FILE = `${BE.STATE}/notify-state.json`
const HISTORY_FILE = `${BE.STATE}/history.jsonl`
const TZ = "Europe/Copenhagen"
const HOUR = 3600_000

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return d } }
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o750 })
  const tmp = f + ".tmp-" + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o640 })
  fs.renameSync(tmp, f)
}
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function localParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] }
}
const fmtTime = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: TZ }).slice(5, 16)
const fmtBytes = (n) => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`)
const fmtDur = (s) => (s == null ? "—" : s < 90 ? `${s} sn` : `${Math.round(s / 60)} dk`)

function readHistory(sinceMs) {
  let lines = []
  try { lines = fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean) } catch {}
  const rows = []
  for (const l of lines) {
    try { const r = JSON.parse(l); if (Date.parse(r.ts) >= sinceMs) rows.push(r) } catch {}
  }
  return rows
}

/** Etkin görev × etkin hedef çiftleri + her birinin geçmişi ve motor sağlığı. */
function snapshot(now, sinceMs) {
  const cfg = BE.loadConfig()
  const health = new Map(BE.health(new Date(now)).map((h) => [h.key, h]))
  const history = readHistory(sinceMs)
  const pairs = []
  for (const job of cfg.jobs) {
    if (job.enabled === false) continue
    for (const target of cfg.targets) if (job.targets.includes(target.id) && target.enabled) pairs.push({ job, target, key: `${job.id}:${target.id}`, h: health.get(`backup:${job.id}:${target.id}`) })
  }
  return { pairs, history }
}
const rowsOf = (snap, p) => snap.history.filter((r) => r.job === p.job.id && r.target === p.target.id)

// ── Hata uyarısı ─────────────────────────────────────────────────────────────
function evalPairs(snap, n) {
  return snap.pairs.map((p) => {
    const rs = rowsOf(snap, p)
    let f = 0
    for (let i = rs.length - 1; i >= 0 && !rs[i].ok; i--) f++
    const lastFail = f ? rs[rs.length - 1] : null
    // Hiç çalışmamış (yeni eklenen) hedef için "planlı yedek alınmadı" bir arıza değil: ilk çalışma beklenir
    const overdue = f === 0 && p.h && !p.h.ok && rs.length > 0
    const failing = f >= n.alert.afterFailures || overdue
    return {
      key: p.key, label: `${p.job.name} → ${p.target.name}`, secondary: n.secondary.includes(p.target.id), failing,
      detail: f >= n.alert.afterFailures ? `${f} kez art arda başarısız: ${String(lastFail?.message ?? "").slice(0, 200)}` : (p.h?.detail ?? ""),
      since: f ? Date.parse(rs[rs.length - f].ts) : null,
    }
  })
}
const sev = (i) => (i.secondary ? "uyarı (ikincil hedef)" : "KRİTİK")

function mail(title, introLines, tableRows, footer) {
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:760px;color:#111"><h2 style="margin:0 0 12px">${esc(title)}</h2>${introLines.map((l) => `<p style="margin:6px 0">${esc(l)}</p>`).join("")}${tableRows ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:10px">${tableRows}</table>` : ""}<hr style="margin-top:18px"><p style="color:#888;font-size:12px">${esc(footer)}</p></div>`
  return html
}
const th = (c) => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #ddd;background:#f6f6f6;font-weight:600">${esc(c)}</th>`
const td = (c, color) => `<td style="padding:6px 8px;border-bottom:1px solid #eee;${color ? `color:${color};font-weight:600;` : ""}">${esc(c)}</td>`
const FOOT = "AddInvoice yedek bildirimi (sunucuda bağımsız izleyici). Ayarlar: ops.addinvoice.dk → Yedekleme → Bildirimler"

function alertMail(fresh) {
  const crit = fresh.some((i) => !i.secondary)
  const subject = `Yedek sorunu: ${fresh.length} görev${crit ? " (kritik)" : " (ikincil hedef)"}`
  const text = ["Aşağıdaki yedekler başarısız oldu veya alınmadı:", ...fresh.map((i) => `• [${sev(i)}] ${i.label}: ${i.detail}${i.since ? ` (${fmtTime(i.since)}'den beri)` : ""}`), "", "Ayrıntı: Ops → Yedekleme → Görevler (görev günlüğü)."]
  const rows = `<tr>${th("Önem")}${th("Görev → Hedef")}${th("Sorun")}</tr>` + fresh.map((i) => `<tr>${td(sev(i), i.secondary ? "#b45309" : "#b91c1c")}${td(i.label)}${td(i.detail + (i.since ? ` (${fmtTime(i.since)}'den beri)` : ""))}</tr>`).join("")
  return { subject, text, html: mail(subject, ["Aşağıdaki yedekler başarısız oldu veya planlı zamanda alınmadı."], rows, FOOT) }
}
function recoveryMail(list) {
  const subject = `Yedek düzeldi: ${list.length} görev`
  const text = ["Önceden bildirilen sorunlar giderildi:", ...list.map((l) => `• ${l}`)]
  return { subject, text, html: mail(subject, ["Önceden bildirilen sorunlar giderildi (son yedekler başarılı):", ...list.map((l) => "• " + l)], null, FOOT) }
}

// ── Özet raporu ──────────────────────────────────────────────────────────────
function buildReport(snap, n, hours, now, title) {
  const since = now - hours * HOUR
  const rows = snap.pairs.map((p) => {
    const rs = rowsOf(snap, p).filter((r) => Date.parse(r.ts) >= since)
    const okRs = rs.filter((r) => r.ok), failRs = rs.filter((r) => !r.ok)
    const lastOk = okRs[okRs.length - 1]
    const everRan = rowsOf(snap, p).length > 0
    const current = p.h && !p.h.ok && everRan ? "SORUN" : null
    const status = current ? "SORUN" : failRs.length ? "düzeldi" : rs.length ? "tamam" : everRan ? "çalışmadı" : "bekliyor"
    return {
      label: p.job.name, target: p.target.name, secondary: n.secondary.includes(p.target.id), status,
      runs: rs.length, fail: failRs.length, lastOk, newBytes: okRs.reduce((a, r) => a + (r.sizes?.deduplicated ?? 0), 0),
      detail: current ? (p.h?.detail ?? "") : failRs.length ? String(failRs[failRs.length - 1].message ?? "").slice(0, 160) : "",
    }
  })
  const problems = rows.filter((r) => r.status === "SORUN" || r.fail > 0)
  const order = { SORUN: 0, düzeldi: 1, çalışmadı: 2, bekliyor: 3, tamam: 4 }
  rows.sort((a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label))
  const lp = localParts(new Date(now))
  const current = rows.filter((r) => r.status === "SORUN")
  const subject = `${title}: ${current.length ? `${current.length} sorun var` : problems.length ? "sorunlar düzeldi" : "tüm yedekler sağlam"} (${lp.date})`
  const colorOf = { SORUN: "#b91c1c", düzeldi: "#b45309", çalışmadı: "#6b7280", bekliyor: "#6b7280", tamam: "#15803d" }
  const head = `<tr>${th("Görev")}${th("Hedef")}${th("Durum")}${th("Çalışma")}${th("Son başarılı arşiv")}${th("Yeni veri")}${th("Süre")}</tr>`
  const body = rows.map((r) => `<tr>${td(r.label)}${td(r.target + (r.secondary ? " (ikincil)" : ""))}${td(r.status === "tamam" ? "✓ tamam" : r.status, colorOf[r.status])}${td(`${r.runs - r.fail} ✓ / ${r.fail} ✗`)}${td(r.lastOk?.archive ?? "—")}${td(fmtBytes(r.newBytes))}${td(fmtDur(r.lastOk?.durationSec))}</tr>${r.detail ? `<tr><td colspan="7" style="padding:2px 8px 8px;color:#b91c1c;font-size:12px">↳ ${esc(r.detail)}</td></tr>` : ""}`).join("")
  const perTarget = new Map()
  for (const r of rows) { const o = perTarget.get(r.target) ?? { runs: 0, fail: 0, bytes: 0 }; o.runs += r.runs; o.fail += r.fail; o.bytes += r.newBytes; perTarget.set(r.target, o) }
  const sum = [...perTarget].map(([t, o]) => `${t}: ${o.runs} çalışma, ${o.fail} hata, ${fmtBytes(o.bytes)} yeni veri`)
  const intro = [`${hours === 24 ? "Son 24 saat" : "Son 7 gün"} · ${lp.date} ${String(lp.hour).padStart(2, "0")}:${String(lp.minute).padStart(2, "0")}`, ...sum]
  const text = [...intro, "", ...rows.map((r) => `${r.status === "tamam" ? "✓" : r.status === "SORUN" ? "✗" : "~"} ${r.label} → ${r.target}${r.secondary ? " (ikincil)" : ""}: ${r.status}; ${r.runs - r.fail} ✓ / ${r.fail} ✗; ${r.lastOk?.archive ?? "—"}${r.detail ? " — " + r.detail : ""}`)]
  return { subject, text, html: mail(subject, intro, head + body, FOOT), problems, current }
}

// ── Zamanlanmış çalışma (watchdog'dan) ───────────────────────────────────────
export async function tick({ sendEmail, now = new Date() }) {
  const n = BE.loadNotify()
  if (!n.configured) return { log: null }
  const nowMs = now.getTime()
  const lp = localParts(now)
  const state = readJson(STATE_FILE, {}) ?? {}
  state.alerted ??= {}
  const log = []
  const minutes = lp.hour * 60 + lp.minute
  const send = async (m) => { await sendEmail(n.recipients, m.subject, m.text, m.html) }

  const snap = snapshot(nowMs, nowMs - 8 * 24 * HOUR)

  // 1) Hata uyarısı + düzeldi
  if (!n.alert.enabled) state.alerted = {}
  else if (n.recipients.length) {
    const items = evalPairs(snap, n)
    const failing = items.filter((i) => i.failing)
    const fresh = failing.filter((i) => !state.alerted[i.key])
    if (fresh.length) {
      try { await send(alertMail(fresh)); for (const i of fresh) state.alerted[i.key] = { sentAt: nowMs, label: i.label, since: i.since }; log.push(`uyarı:${fresh.length}`) } catch (e) { log.push("uyarı HATA: " + String(e.message).slice(0, 80)) }
    }
    const recovered = Object.keys(state.alerted).filter((k) => !failing.some((i) => i.key === k))
    if (recovered.length) {
      try {
        if (n.alert.recovery) await send(recoveryMail(recovered.map((k) => state.alerted[k].label ?? k)))
        for (const k of recovered) delete state.alerted[k]
        log.push(`düzeldi:${recovered.length}`)
      } catch (e) { log.push("düzeldi HATA: " + String(e.message).slice(0, 80)) }
    }
  }

  // 2) Günlük özet — ayar değişince (veya ilk kez) bugünün saati geçmişse bugünü atla: kullanıcıya anlık, beklenmedik özet gitmesin
  const dsig = JSON.stringify(n.daily)
  if (state.dailySig !== dsig) { state.dailySig = dsig; if (minutes >= n.daily.hour * 60 + n.daily.minute) state.lastDaily = lp.date }
  if (n.daily.enabled && n.recipients.length && lp.date !== state.lastDaily && minutes >= n.daily.hour * 60 + n.daily.minute) {
    try {
      const rep = buildReport(snap, n, 24, nowMs, "Yedek özeti")
      if (!n.daily.onlyOnProblems || rep.problems.length) { await send(rep); log.push("günlük:gönderildi") }
      state.lastDaily = lp.date
    } catch (e) { log.push("günlük HATA: " + String(e.message).slice(0, 80)) }
  }

  // 3) Haftalık özet
  const wsig = JSON.stringify(n.weekly)
  const wDue = (d) => d.weekday === n.weekly.weekday && d.hour * 60 + d.minute >= n.weekly.hour * 60 + n.weekly.minute
  if (state.weeklySig !== wsig) { state.weeklySig = wsig; if (wDue(lp)) state.lastWeekly = lp.date }
  if (n.weekly.enabled && n.recipients.length && lp.date !== state.lastWeekly && wDue(lp)) {
    try { await send(buildReport(snap, n, 168, nowMs, "Haftalık yedek özeti")); state.lastWeekly = lp.date; log.push("haftalık:gönderildi") } catch (e) { log.push("haftalık HATA: " + String(e.message).slice(0, 80)) }
  }

  state.updatedAt = nowMs
  writeJson(STATE_FILE, state)
  return { log: log.length ? "yedek-bildirim " + log.join(" ") : null }
}

// ── Elle gönderim (Ops → Bildirimler → deneme düğmeleri); durumu DEĞİŞTİRMEZ ─────
export async function sendNow({ sendEmail, mode, now = new Date() }) {
  const n = BE.loadNotify()
  if (!n.recipients.length) throw new Error("Önce en az bir e-posta adresi kaydet")
  if (mode === "test") {
    const lines = ["Bu bir deneme mesajıdır. Yedek bildirimleri bu adrese gelecek.", `Alıcılar: ${n.recipients.join(", ")}`, `Zaman: ${now.toLocaleString("sv-SE", { timeZone: TZ })}`]
    await sendEmail(n.recipients, "TEST — yedek bildirimi", lines, mail("TEST — yedek bildirimi", lines, null, FOOT))
    return { sentTo: n.recipients, what: "deneme maili" }
  }
  const snap = snapshot(now.getTime(), now.getTime() - 8 * 24 * HOUR)
  const rep = buildReport(snap, n, 24, now.getTime(), "ÖRNEK yedek özeti")
  await sendEmail(n.recipients, rep.subject, rep.text, rep.html)
  return { sentTo: n.recipients, what: "örnek özet (son 24 saat)", problems: rep.current.length }
}
