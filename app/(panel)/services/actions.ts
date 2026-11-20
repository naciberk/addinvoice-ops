"use server"

import { agentCall } from "@/lib/agent-client"
import { audit } from "@/lib/audit"
import { assertRole, clientInfo } from "@/lib/auth"
import { rateLimit } from "@/lib/ratelimit"

export async function loadLog(source: string, lines: number): Promise<{ ok: boolean; text?: string; message?: string }> {
  const a = await assertRole("operator")
  if (!rateLimit(`log:${a.user.id}`, 30, 60_000).ok) return { ok: false, message: "Çok sık istek." }
  const { ip } = await clientInfo()
  const r = await agentCall<{ text: string }>("logs", { source, lines }, { email: a.user.email, role: a.user.role })
  await audit({ actor: a.user.email, role: a.user.role, action: "logs.view", target: source, ip, ok: r.ok })
  return r.ok ? { ok: true, text: r.data.text } : { ok: false, message: r.error }
}
