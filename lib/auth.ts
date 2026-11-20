import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { randomToken, sha256 } from "./crypto"
import { tx, snapshot, type Role, type Session, type User } from "./store"
import { can } from "./roles"

export const COOKIE = "ops_session"
const IDLE_MS = 30 * 60_000 // 30 dk hareketsizlik
const ABS_MS = 12 * 3_600_000 // en fazla 12 saat
const PENDING_MS = 5 * 60_000 // parola geçti → TOTP için 5 dk

export async function clientInfo() {
  const h = await headers()
  const ip = (h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0] || "?").trim()
  return { ip, ua: (h.get("user-agent") || "").slice(0, 200) }
}

export async function startSession(userId: string, stage: Session["stage"]): Promise<void> {
  const { ip, ua } = await clientInfo()
  const token = randomToken(32)
  const now = Date.now()
  await tx((db) => {
    db.sessions = db.sessions.filter((s) => s.expiresAt > now)
    db.sessions.push({
      idHash: sha256(token),
      userId,
      stage,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + (stage === "pwd" ? PENDING_MS : ABS_MS),
      ip,
      ua,
    })
  })
  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: stage === "pwd" ? PENDING_MS / 1000 : ABS_MS / 1000,
  })
}

export async function endSession(): Promise<void> {
  const jar = await cookies()
  const t = jar.get(COOKIE)?.value
  if (t) await tx((db) => void (db.sessions = db.sessions.filter((s) => s.idHash !== sha256(t))))
  jar.delete(COOKIE)
}

export type Authed = { user: User; session: Session }

/** Oturumu çözer. stage="ok" ister; "pwd" aşamasını `getPendingSession` ile ayrıca okuyun. */
export async function getSession(stage: Session["stage"] = "ok"): Promise<Authed | null> {
  const jar = await cookies()
  const t = jar.get(COOKIE)?.value
  if (!t) return null
  const idHash = sha256(t)
  const now = Date.now()
  const snap = snapshot()
  const s = snap.sessions.find((x) => x.idHash === idHash)
  if (!s || s.stage !== stage || s.expiresAt <= now || (stage === "ok" && now - s.lastSeen > IDLE_MS)) return null
  const user = snap.users.find((u) => u.id === s.userId)
  if (!user || user.disabled) return null
  // lastSeen'i en çok dakikada bir yaz (her istekte disk yazımı olmasın)
  if (now - s.lastSeen > 60_000) await tx((db) => void (db.sessions.find((x) => x.idHash === idHash)!.lastSeen = now))
  return { user, session: s }
}

export async function requireSession(): Promise<Authed> {
  const a = await getSession("ok")
  if (!a) redirect("/login")
  return a
}

export async function requireRole(min: Role): Promise<Authed> {
  const a = await requireSession()
  if (!can(a.user.role, min)) redirect("/forbidden")
  return a
}

/** Server action içinde kullanım: yetki yoksa fırlatır (redirect yerine). */
export async function assertRole(min: Role): Promise<Authed> {
  const a = await getSession("ok")
  if (!a) throw new Error("Oturum yok")
  if (!can(a.user.role, min)) throw new Error("Bu işlem için yetkin yok")
  return a
}

/** Kullanıcının diğer tüm oturumlarını kapatır (parola/rol değişimi, devre dışı bırakma). */
export async function revokeUserSessions(userId: string, exceptIdHash?: string) {
  await tx((db) => void (db.sessions = db.sessions.filter((s) => s.userId !== userId || s.idHash === exceptIdHash)))
}
