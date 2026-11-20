import http from "http"
import crypto from "crypto"

const SOCKET = process.env.OPS_AGENT_SOCKET || "/run/addinvoice-ops/agent.sock"

function sign(body: string, ts: string): string {
  return crypto.createHmac("sha256", "agent:" + (process.env.OPS_SESSION_SECRET ?? "")).update(ts + "." + body).digest("hex")
}

export type AgentResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

/** Root ajanına izin listesindeki bir eylemi gönderir. Ajan her şeyi (eylem adı, parametre biçimi) KENDİ doğrular. */
export function agentCall<T = unknown>(
  action: string,
  params: Record<string, unknown>,
  actor: { email: string; role: string },
  timeoutMs = 20_000
): Promise<AgentResult<T>> {
  const body = JSON.stringify({ action, params, actor })
  const ts = String(Date.now())
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: "/run",
        method: "POST",
        timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-ops-ts": ts, "x-ops-sig": sign(body, ts) },
      },
      (res) => {
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (buf += c))
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf) as AgentResult<T>)
          } catch {
            resolve({ ok: false, error: "Ajan yanıtı okunamadı" })
          }
        })
      }
    )
    req.on("timeout", () => {
      req.destroy()
      resolve({ ok: false, error: "Ajan zaman aşımı" })
    })
    req.on("error", (e) => resolve({ ok: false, error: "Ajana ulaşılamadı: " + (e as NodeJS.ErrnoException).code }))
    req.end(body)
  })
}
