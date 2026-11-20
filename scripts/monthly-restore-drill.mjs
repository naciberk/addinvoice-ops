#!/usr/bin/env node
// Aylık otomatik geri yükleme provası (26 Ekim 2026): ops ajanına `restore_drill` işini verir, bitmesini bekler ve sonucu
// /var/log/addinvoice-ops/restore-drill.json dosyasına yazar. Ana uygulamanın db-health-alert-worker'ı bu dosyayı okur:
// prova başarısızsa veya 45 günden eskiyse admin'e e-posta gider. Canlı veritabanına DOKUNMAZ (geçici kopya, ayrı port).
//   cron: /etc/cron.d/addinvoice-restore-drill  (her ayın 1'i 04:00, root)
import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"

for (const l of fs.readFileSync("/etc/addinvoice-ops/env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const RESULT = "/var/log/addinvoice-ops/restore-drill.json"
const actor = { email: "cron@system", role: "operator" }

function call(action, params = {}) {
  const body = JSON.stringify({ action, params, actor })
  const ts = String(Date.now())
  const sig = crypto.createHmac("sha256", "agent:" + process.env.OPS_SESSION_SECRET).update(ts + "." + body).digest("hex")
  return new Promise((resolve) => {
    const req = http.request({ socketPath: process.env.OPS_AGENT_SOCKET, path: "/run", method: "POST", timeout: 30_000, headers: { "x-ops-ts": ts, "x-ops-sig": sig, "content-length": Buffer.byteLength(body) } }, (res) => {
      let b = ""
      res.on("data", (c) => (b += c))
      res.on("end", () => { try { resolve(JSON.parse(b)) } catch { resolve({ ok: false, error: "yanıt okunamadı" }) } })
    })
    req.on("error", (e) => resolve({ ok: false, error: "ajana ulaşılamadı: " + e.code }))
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "zaman aşımı" }) })
    req.end(body)
  })
}

const write = (o) => fs.writeFileSync(RESULT, JSON.stringify({ at: new Date().toISOString(), ...o }, null, 2), { mode: 0o640 })

const start = await call("restore_drill")
if (!start.ok) { write({ ok: false, message: "Başlatılamadı: " + start.error }); console.log("başlatılamadı", start.error); process.exit(1) }
const jobId = start.data.jobId
const deadline = Date.now() + 30 * 60_000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000))
  const j = await call("jobs")
  const job = j.ok ? j.data.find((x) => x.id === jobId) : null
  if (job && job.state !== "running") {
    const ok = job.state === "done"
    write({ ok, message: String(job.result ?? "") })
    console.log(new Date().toISOString(), ok ? "OK" : "BAŞARISIZ", job.result)
    process.exit(ok ? 0 : 1)
  }
}
write({ ok: false, message: "30 dakikada tamamlanmadı" })
console.log("zaman aşımı")
process.exit(1)
