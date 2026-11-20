"use server"

import { revalidatePath } from "next/cache"
import { agentCall } from "@/lib/agent-client"
import { audit } from "@/lib/audit"
import { assertRole, clientInfo, revokeUserSessions } from "@/lib/auth"
import { randomToken, sha256 } from "@/lib/crypto"
import { rateLimit } from "@/lib/ratelimit"
import { snapshot, tx, type Role } from "@/lib/store"

export type ActionResult = { ok: boolean; message?: string; link?: string }

async function ctx(min: Role) {
  const a = await assertRole(min)
  const { ip } = await clientInfo()
  return { user: a.user, ip, actor: { email: a.user.email, role: a.user.role } }
}

// ── Ajan eylemleri ───────────────────────────────────────────────────────────
export async function runBackup(type: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("operator")
  if (!rateLimit(`mut:${user.id}`, 20, 10 * 60_000).ok) return { ok: false, message: "Çok sık işlem." }
  const r = await agentCall("backup_run", { type }, actor)
  await audit({ actor: user.email, role: user.role, action: "backup.run", target: type, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, message: "Yedek işi başlatıldı." } : { ok: false, message: r.error }
}

export async function createRestorePoint(name: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("operator")
  const r = await agentCall<{ name: string; lsn: string }>("restore_point", { name }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "restorepoint.create", target: name, ip, ok: r.ok, detail: r.ok ? r.data.lsn : r.error })
  return r.ok ? { ok: true, message: `Restore noktası '${r.data.name}' oluşturuldu (LSN ${r.data.lsn}).` } : { ok: false, message: r.error }
}

export async function runMaintenance(op: string, table: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx(op === "reindex" ? "admin" : "operator")
  const r = await agentCall("maintenance", { op, table }, actor)
  await audit({ actor: user.email, role: user.role, action: `db.${op}`, target: table, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, message: `${op.toUpperCase()} ${table} başlatıldı.` } : { ok: false, message: r.error }
}

export async function exportCompany(companyId: string, companyName: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("operator")
  const r = await agentCall("export_company", { companyId }, actor)
  await audit({ actor: user.email, role: user.role, action: "company.export", target: `${companyName} (${companyId})`, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, message: "Dışa aktarma başlatıldı. Bitince indirme bağlantısı ve parola aşağıdaki 'İşler' kutusunda görünür." } : { ok: false, message: r.error }
}

// ── Kullanıcı / davet yönetimi (yalnız admin) ────────────────────────────────
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES: Role[] = ["viewer", "operator", "admin"]

export async function createInvite(email: string, role: string): Promise<ActionResult> {
  const { user, ip } = await ctx("admin")
  email = email.trim().toLowerCase()
  if (!EMAIL.test(email) || email.length > 200) return { ok: false, message: "Geçerli bir e-posta gir." }
  if (!ROLES.includes(role as Role)) return { ok: false, message: "Geçersiz rol." }
  const token = randomToken(32)
  const err = await tx((db) => {
    if (db.users.some((u) => u.email === email)) return "Bu e-posta zaten kullanıcı."
    db.invites = db.invites.filter((i) => !(i.email === email && !i.usedAt && i.kind === "new")) // eski bekleyen daveti iptal et
    db.invites.push({ id: randomToken(8), tokenHash: sha256(token), kind: "new", email, role: role as Role, createdBy: user.email, createdAt: Date.now(), expiresAt: Date.now() + 48 * 3_600_000, usedAt: null })
    return null
  })
  if (err) return { ok: false, message: err }
  await audit({ actor: user.email, role: user.role, action: "invite.create", target: `${email} (${role})`, ip })
  revalidatePath("/users")
  return { ok: true, link: `${process.env.OPS_BASE_URL}/invite/${token}`, message: "Davet bağlantısı 48 saat geçerli, tek kullanımlık. Kişiye güvenli bir kanaldan ilet." }
}

export async function resetUserAccess(userId: string): Promise<ActionResult> {
  const { user, ip } = await ctx("admin")
  const target = snapshot().users.find((u) => u.id === userId)
  if (!target) return { ok: false, message: "Kullanıcı yok." }
  const token = randomToken(32)
  await tx((db) => {
    db.invites = db.invites.filter((i) => !(i.userId === userId && !i.usedAt))
    db.invites.push({ id: randomToken(8), tokenHash: sha256(token), kind: "reset", userId, email: target.email, role: target.role, createdBy: user.email, createdAt: Date.now(), expiresAt: Date.now() + 24 * 3_600_000, usedAt: null })
  })
  await audit({ actor: user.email, role: user.role, action: "user.reset_access", target: target.email, ip })
  revalidatePath("/users")
  return { ok: true, link: `${process.env.OPS_BASE_URL}/invite/${token}`, message: "Parola + 2FA sıfırlama bağlantısı 24 saat geçerli." }
}

export async function changeRole(userId: string, role: string): Promise<ActionResult> {
  const { user, ip } = await ctx("admin")
  if (!ROLES.includes(role as Role)) return { ok: false, message: "Geçersiz rol." }
  if (userId === user.id) return { ok: false, message: "Kendi rolünü değiştiremezsin." }
  const res = await tx((db) => {
    const u = db.users.find((x) => x.id === userId)
    if (!u) return null
    const old = u.role
    u.role = role as Role
    return { email: u.email, old }
  })
  if (!res) return { ok: false, message: "Kullanıcı yok." }
  await revokeUserSessions(userId)
  await audit({ actor: user.email, role: user.role, action: "user.role", target: res.email, detail: `${res.old} → ${role}`, ip })
  revalidatePath("/users")
  return { ok: true, message: "Rol güncellendi, kullanıcının oturumları kapatıldı." }
}

export async function setDisabled(userId: string, disabled: boolean): Promise<ActionResult> {
  const { user, ip } = await ctx("admin")
  if (userId === user.id) return { ok: false, message: "Kendini devre dışı bırakamazsın." }
  const res = await tx((db) => {
    const u = db.users.find((x) => x.id === userId)
    if (!u) return null
    if (disabled && u.role === "admin" && db.users.filter((x) => x.role === "admin" && !x.disabled).length <= 1) return "last"
    u.disabled = disabled
    return u.email
  })
  if (!res) return { ok: false, message: "Kullanıcı yok." }
  if (res === "last") return { ok: false, message: "Son yöneticiyi devre dışı bırakamazsın." }
  if (disabled) await revokeUserSessions(userId)
  await audit({ actor: user.email, role: user.role, action: disabled ? "user.disable" : "user.enable", target: res, ip })
  revalidatePath("/users")
  return { ok: true }
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  const { user, ip } = await ctx("admin")
  await tx((db) => void (db.invites = db.invites.filter((i) => i.id !== id)))
  await audit({ actor: user.email, role: user.role, action: "invite.revoke", target: id, ip })
  revalidatePath("/users")
  return { ok: true }
}

// ── Faz 3: servis işlemleri, yapılandırma düzenleme, geri yükleme provası ────────────────────────
export async function serviceAction(service: string, op: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx(op === "restart" ? "admin" : "operator")
  const r = await agentCall<{ service: string; op: string; active: string }>("service_action", { service, op }, actor, 150_000)
  await audit({ actor: user.email, role: user.role, action: `service.${op}`, target: service, ip, ok: r.ok, detail: r.ok ? r.data.active : r.error })
  return r.ok ? { ok: true, message: `${service} ${op === "restart" ? "yeniden başlatıldı" : "yeniden yüklendi"} (durum: ${r.data.active}).` } : { ok: false, message: r.error }
}

export async function restoreDrill(): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("operator")
  const r = await agentCall("restore_drill", {}, actor)
  await audit({ actor: user.email, role: user.role, action: "backup.restore_drill", ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, message: "Geri yükleme provası başlatıldı. Sonuç 'İşler' kutusunda (≈1 dk)." } : { ok: false, message: r.error }
}

export async function configRead(key: string, backup?: string): Promise<{ ok: boolean; content?: string; message?: string }> {
  const { user, ip, actor } = await ctx("operator")
  const r = await agentCall<{ content: string }>("config_read", { key, backup }, actor)
  await audit({ actor: user.email, role: user.role, action: "config.read", target: backup ? `${key}@${backup}` : key, ip, ok: r.ok })
  return r.ok ? { ok: true, content: r.data.content } : { ok: false, message: r.error }
}

export async function configApply(key: string, content: string, dryRun: boolean): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<{ applied: boolean; message: string; backup?: string; restartNeeded?: string[] }>("config_apply", { key, content, dryRun }, actor, 90_000)
  await audit({ actor: user.email, role: user.role, action: dryRun ? "config.validate" : "config.apply", target: key, ip, ok: r.ok, detail: r.ok ? (r.data.backup ? `yedek ${r.data.backup}` : undefined) : r.error })
  revalidatePath("/config")
  return r.ok ? { ok: true, message: r.data.message } : { ok: false, message: r.error }
}

export async function configRollback(key: string, backup: string): Promise<ActionResult> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<{ message: string }>("config_rollback", { key, backup }, actor, 90_000)
  await audit({ actor: user.email, role: user.role, action: "config.rollback", target: `${key}@${backup}`, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  revalidatePath("/config")
  return r.ok ? { ok: true, message: r.data.message } : { ok: false, message: r.error }
}
