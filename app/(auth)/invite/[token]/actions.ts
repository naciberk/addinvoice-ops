"use server"

import { audit } from "@/lib/audit"
import { clientInfo } from "@/lib/auth"
import { checkPasswordStrength, hashPassword, newRecoveryCodes, randomToken, seal, sha256, unseal, verifyTotp } from "@/lib/crypto"
import { rateLimit } from "@/lib/ratelimit"
import { snapshot, tx, type User } from "@/lib/store"

export type InviteState = { error?: string; recoveryCodes?: string[]; done?: boolean }

export async function acceptInvite(token: string, _: InviteState, form: FormData): Promise<InviteState> {
  const { ip } = await clientInfo()
  if (!rateLimit(`invite:${ip}`, 10, 10 * 60_000).ok) return { error: "Çok fazla deneme. Biraz sonra tekrar dene." }

  const tokenHash = sha256(token)
  const inv = snapshot().invites.find((i) => i.tokenHash === tokenHash)
  if (!inv || inv.usedAt || inv.expiresAt < Date.now() || !inv.enrolSecretSealed) {
    return { error: "Davet geçersiz veya süresi dolmuş." }
  }

  const password = String(form.get("password") ?? "")
  const password2 = String(form.get("password2") ?? "")
  const code = String(form.get("code") ?? "")
  const name = String(form.get("name") ?? "").trim().slice(0, 80)

  if (inv.kind === "new" && name.length < 2) return { error: "Adını yaz." }
  // "enrol": parola zaten var (ana uygulamadan kopyalandı) → yalnız 2FA kurulur.
  if (inv.kind !== "enrol") {
    if (password !== password2) return { error: "Parolalar aynı değil." }
    const weak = checkPasswordStrength(password)
    if (weak) return { error: weak }
  }

  const secret = unseal(inv.enrolSecretSealed)
  const step = verifyTotp(secret, code)
  if (step === null) return { error: "2FA kodu hatalı. Uygulamadaki güncel kodu gir." }

  const passwordHash = inv.kind === "enrol" ? "" : await hashPassword(password)
  const rc = newRecoveryCodes()

  const res = await tx((db) => {
    const i = db.invites.find((x) => x.tokenHash === tokenHash)
    if (!i || i.usedAt || i.expiresAt < Date.now()) return "invalid" as const
    if (i.kind === "new") {
      if (db.users.some((u) => u.email === i.email)) return "exists" as const
      const u: User = {
        id: randomToken(12),
        email: i.email,
        name,
        role: i.role,
        passwordHash,
        totpSecretSealed: seal(secret),
        totpLastStep: step,
        recoveryHashes: rc.hashes,
        failedLogins: 0,
        lockedUntil: 0,
        disabled: false,
        createdAt: Date.now(),
        lastLoginAt: null,
        invitedBy: i.createdBy,
      }
      db.users.push(u)
    } else if (i.kind === "enrol") {
      const u = db.users.find((x) => x.id === i.userId)
      if (!u || u.totpSecretSealed) return "invalid" as const // yalnız 2FA'sı henüz kurulmamış hesap
      u.totpSecretSealed = seal(secret)
      u.totpLastStep = step
      u.recoveryHashes = rc.hashes
      u.failedLogins = 0
      u.lockedUntil = 0
    } else {
      const u = db.users.find((x) => x.id === i.userId)
      if (!u) return "invalid" as const
      u.passwordHash = passwordHash
      u.totpSecretSealed = seal(secret)
      u.totpLastStep = step
      u.recoveryHashes = rc.hashes
      u.failedLogins = 0
      u.lockedUntil = 0
      db.sessions = db.sessions.filter((s) => s.userId !== u.id)
    }
    i.usedAt = Date.now()
    delete i.enrolSecretSealed
    return "ok" as const
  })

  if (res === "exists") return { error: "Bu e-posta ile zaten bir kullanıcı var." }
  if (res !== "ok") return { error: "Davet geçersiz veya süresi dolmuş." }

  await audit({ actor: inv.email, role: inv.role, action: inv.kind === "new" ? "invite.accepted" : inv.kind === "enrol" ? "invite.2fa_enrolled" : "invite.reset_done", detail: `davet eden: ${inv.createdBy}`, ip })
  return { done: true, recoveryCodes: rc.plain }
}
