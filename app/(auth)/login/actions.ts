"use server"

import { redirect } from "next/navigation"
import { audit } from "@/lib/audit"
import { clientInfo, endSession, getSession, startSession } from "@/lib/auth"
import { dummyVerify, hashRecovery, unseal, verifyPassword, verifyTotp } from "@/lib/crypto"
import { rateLimit } from "@/lib/ratelimit"
import { snapshot, tx } from "@/lib/store"

export type LoginState = { error?: string; stage?: "pwd" | "totp" }

const LOCK_AFTER = 5
const LOCK_MS = 15 * 60_000

export async function passwordStep(_: LoginState, form: FormData): Promise<LoginState> {
  const { ip } = await clientInfo()
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 200)
  const password = String(form.get("password") ?? "").slice(0, 300)

  const rl = rateLimit(`login-ip:${ip}`, 10, 10 * 60_000)
  const rl2 = rateLimit(`login-em:${email}`, 8, 10 * 60_000)
  if (!rl.ok || !rl2.ok) {
    await audit({ actor: email || "-", action: "login.ratelimited", ip, ok: false })
    return { error: "Çok fazla deneme. Biraz sonra tekrar dene." }
  }

  const user = snapshot().users.find((u) => u.email === email)
  if (!user || user.disabled) {
    await dummyVerify()
    await audit({ actor: email || "-", action: "login.fail", detail: "kullanıcı yok/devre dışı", ip, ok: false })
    return { error: "E-posta veya parola hatalı." }
  }
  if (user.lockedUntil > Date.now()) {
    await audit({ actor: email, role: user.role, action: "login.locked", ip, ok: false })
    return { error: "Hesap geçici olarak kilitli. 15 dakika sonra tekrar dene." }
  }

  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    await tx((db) => {
      const u = db.users.find((x) => x.id === user.id)!
      u.failedLogins += 1
      if (u.failedLogins >= LOCK_AFTER) {
        u.lockedUntil = Date.now() + LOCK_MS
        u.failedLogins = 0
      }
    })
    await audit({ actor: email, role: user.role, action: "login.fail", detail: "parola", ip, ok: false })
    return { error: "E-posta veya parola hatalı." }
  }

  if (!user.totpSecretSealed) {
    await audit({ actor: email, role: user.role, action: "login.fail", detail: "2FA kurulmamış", ip, ok: false })
    return { error: "Bu hesapta 2FA henüz kurulmamış. Sana verilen kurulum bağlantısını aç (yoksa yöneticiden iste)." }
  }
  await startSession(user.id, "pwd")
  return { stage: "totp" }
}

export async function totpStep(_: LoginState, form: FormData): Promise<LoginState> {
  const { ip } = await clientInfo()
  const a = await getSession("pwd")
  if (!a) return { error: "Oturum süresi doldu. Parolayı yeniden gir.", stage: "pwd" }
  const { user } = a
  const code = String(form.get("code") ?? "").trim().slice(0, 20)

  const rl = rateLimit(`totp:${user.id}`, 8, 10 * 60_000)
  if (!rl.ok) {
    await audit({ actor: user.email, role: user.role, action: "login.ratelimited", detail: "totp", ip, ok: false })
    return { error: "Çok fazla deneme. Biraz sonra tekrar dene." }
  }

  let good = false
  let detail = "totp"
  // 1) TOTP
  const step = verifyTotp(unseal(user.totpSecretSealed), code, user.totpLastStep)
  if (step !== null) {
    good = true
    await tx((db) => void (db.users.find((x) => x.id === user.id)!.totpLastStep = step))
  } else {
    // 2) Kurtarma kodu (tek kullanımlık)
    const h = hashRecovery(code)
    if (/[a-f0-9]{5}-?[a-f0-9]{5}/i.test(code) && user.recoveryHashes.includes(h)) {
      good = true
      detail = "kurtarma kodu"
      await tx((db) => {
        const u = db.users.find((x) => x.id === user.id)!
        u.recoveryHashes = u.recoveryHashes.filter((x) => x !== h)
      })
    }
  }

  if (!good) {
    await tx((db) => {
      const u = db.users.find((x) => x.id === user.id)!
      u.failedLogins += 1
      if (u.failedLogins >= LOCK_AFTER) {
        u.lockedUntil = Date.now() + LOCK_MS
        u.failedLogins = 0
        db.sessions = db.sessions.filter((s) => s.userId !== u.id)
      }
    })
    await audit({ actor: user.email, role: user.role, action: "login.fail", detail: "2FA kodu", ip, ok: false })
    return { error: "Kod hatalı.", stage: "totp" }
  }

  // Parola-aşaması oturumunu at, tam oturum aç
  await endSession()
  await tx((db) => {
    const u = db.users.find((x) => x.id === user.id)!
    u.failedLogins = 0
    u.lockedUntil = 0
    u.lastLoginAt = Date.now()
  })
  await startSession(user.id, "ok")
  await audit({ actor: user.email, role: user.role, action: "login.ok", detail, ip })
  if (detail === "kurtarma kodu") {
    const left = snapshot().users.find((x) => x.id === user.id)!.recoveryHashes.length
    await audit({ actor: user.email, role: user.role, action: "login.recovery_used", detail: `${left} kod kaldı`, ip })
  }
  redirect("/")
}

export async function cancelLogin() {
  await endSession()
  redirect("/login")
}

export async function logout() {
  const a = await getSession("ok")
  const { ip } = await clientInfo()
  if (a) await audit({ actor: a.user.email, role: a.user.role, action: "logout", ip })
  await endSession()
  redirect("/login")
}
