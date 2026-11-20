import { NextResponse } from "next/server"
import { agentCall } from "@/lib/agent-client"
import { getSession } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function GET() {
  const a = await getSession("ok")
  if (!a) return NextResponse.json({ ok: false }, { status: 401 })
  const r = await agentCall("jobs", {}, { email: a.user.email, role: a.user.role })
  return NextResponse.json(r)
}
