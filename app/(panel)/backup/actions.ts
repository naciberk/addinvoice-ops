"use server"

import { revalidatePath } from "next/cache"
import { agentCall } from "@/lib/agent-client"
import { audit } from "@/lib/audit"
import { assertRole, clientInfo } from "@/lib/auth"
import { rateLimit } from "@/lib/ratelimit"
import type { Role } from "@/lib/store"
import type { Config, HistoryRow, Job, Overview, Schedule, ScheduleInput, Target } from "@/lib/backup-types"

export type R<T = undefined> = { ok: true; data: T; message?: string } | { ok: false; message: string }

async function ctx(min: Role) {
  const a = await assertRole(min)
  const { ip } = await clientInfo()
  return { user: a.user, ip, actor: { email: a.user.email, role: a.user.role } }
}
const fail = (message: string): R<never> => ({ ok: false, message })

async function loadConfig(actor: { email: string; role: string }): Promise<Config | string> {
  const r = await agentCall<Config>("backup_config_get", {}, actor)
  return r.ok ? r.data : r.error
}
async function saveConfig(actor: { email: string; role: string }, cfg: { targets: Target[]; jobs: Job[] }) {
  // Ajan yalnız kaynak zamanlamayı (source) kullanır; yine de tam nesneyi geri gönderiyoruz.
  return agentCall<Overview>("backup_config_save", { config: cfg }, actor, 60_000)
}

/** Görevi ekle/güncelle (yönetici). Tür yalnızca yeni görevde belirlenir. */
export async function saveJob(job: Job, isNew: boolean): Promise<R<Overview>> {
  const { user, ip, actor } = await ctx("admin")
  if (!rateLimit(`bk:${user.id}`, 60, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const cfg = await loadConfig(actor)
  if (typeof cfg === "string") return fail(cfg)
  const exists = cfg.jobs.some((j) => j.id === job.id)
  if (isNew && exists) return fail("Bu kimlikte bir görev zaten var.")
  if (!isNew && !exists) return fail("Görev bulunamadı.")
  const jobs = isNew ? [...cfg.jobs, job] : cfg.jobs.map((j) => (j.id === job.id ? { ...job, type: j.type, createdAt: j.createdAt } : j))
  const r = await saveConfig(actor, { targets: cfg.targets, jobs })
  await audit({ actor: user.email, role: user.role, action: isNew ? "backup.job.create" : "backup.job.update", target: job.id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup")
  return { ok: true, data: r.data, message: "Kaydedildi." }
}

export async function deleteJob(id: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const cfg = await loadConfig(actor)
  if (typeof cfg === "string") return fail(cfg)
  const r = await saveConfig(actor, { targets: cfg.targets, jobs: cfg.jobs.filter((j) => j.id !== id) })
  await audit({ actor: user.email, role: user.role, action: "backup.job.delete", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup")
  return { ok: true, data: undefined, message: "Görev silindi (uzaktaki arşivler SİLİNMEZ)." }
}

export async function toggleJob(id: string, enabled: boolean): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const cfg = await loadConfig(actor)
  if (typeof cfg === "string") return fail(cfg)
  const r = await saveConfig(actor, { targets: cfg.targets, jobs: cfg.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)) })
  await audit({ actor: user.email, role: user.role, action: enabled ? "backup.job.enable" : "backup.job.disable", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup")
  return { ok: true, data: undefined, message: enabled ? "Görev etkin." : "Görev durduruldu." }
}

export async function runJobNow(job: string, target?: string): Promise<R> {
  const { user, ip, actor } = await ctx("operator")
  if (!rateLimit(`bkrun:${user.id}`, 20, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<string>("backup_run_now", { job, target }, actor)
  await audit({ actor: user.email, role: user.role, action: "backup.run", target: job + (target ? ` → ${target}` : ""), ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup")
  return { ok: true, data: undefined, message: r.data }
}

export async function previewSchedule(schedule: ScheduleInput): Promise<R<{ next: string[]; perDay: number }>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<{ next: string[]; perDay: number }>("backup_schedule_preview", { schedule, count: 6 }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function testTarget(target: string): Promise<R<{ name: string; ok: boolean; detail: string }[]>> {
  const { user, ip, actor } = await ctx("operator")
  const r = await agentCall<{ name: string; ok: boolean; detail: string }[]>("backup_target_test", { target }, actor, 90_000)
  await audit({ actor: user.email, role: user.role, action: "backup.target.test", target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export type NewTargetResult = { target: Target; publicKey: string | null; fingerprint: string | null; passphrase: string | null; setup: string }
export async function createTarget(t: { id: string; name: string; type: "ssh" | "path"; host?: string; port?: number; user?: string; auth?: "key" | "password"; repoPath: string; mountCheck?: string }, sshPassword?: string): Promise<R<NewTargetResult>> {
  const { user, ip, actor } = await ctx("admin")
  // SSH parolası yalnız ajana (unix soketi) gider; denetim kaydına YAZILMAZ.
  const r = await agentCall<NewTargetResult>("backup_target_create", { target: t, password: t.auth === "password" ? sshPassword : undefined }, actor, 60_000)
  // Parola yanıtı yalnız çağırana döner; denetim kaydına YAZILMAZ.
  await audit({ actor: user.email, role: user.role, action: "backup.target.create", target: t.id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup/targets")
  return { ok: true, data: r.data }
}

export async function changeTargetPassword(target: string, password: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("backup_target_password", { target, password }, actor)
  await audit({ actor: user.email, role: user.role, action: "backup.target.password", target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  return { ok: true, data: undefined, message: r.data }
}

export async function setupText(target: string): Promise<R<{ publicKey: string | null; fingerprint: string | null; setup: string }>> {
  const { actor } = await ctx("admin")
  const r = await agentCall<{ publicKey: string | null; fingerprint: string | null; setup: string }>("backup_setup_text", { target }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function initTarget(target: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("backup_target_init", { target }, actor, 150_000)
  await audit({ actor: user.email, role: user.role, action: "backup.target.init", target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup")
  revalidatePath("/backup/targets")
  return { ok: true, data: undefined, message: r.data }
}

export async function deleteTarget(target: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("backup_target_delete", { target }, actor)
  await audit({ actor: user.email, role: user.role, action: "backup.target.delete", target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup/targets")
  return { ok: true, data: undefined, message: r.data }
}

export async function toggleTarget(target: string, enabled: boolean): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const cfg = await loadConfig(actor)
  if (typeof cfg === "string") return fail(cfg)
  const r = await saveConfig(actor, { targets: cfg.targets.map((t) => (t.id === target ? { ...t, enabled } : t)), jobs: cfg.jobs })
  await audit({ actor: user.email, role: user.role, action: enabled ? "backup.target.enable" : "backup.target.disable", target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/backup/targets")
  return { ok: true, data: undefined, message: enabled ? "Hedef etkin." : "Hedef durduruldu." }
}

export async function loadArchives(target: string, job?: string): Promise<R<{ archives: { name: string; time: string }[]; totalOriginal: number | null; totalUniqueCompressed: number | null }>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<{ archives: { name: string; time: string }[]; totalOriginal: number | null; totalUniqueCompressed: number | null }>("backup_archives", { target, job, limit: 30 }, actor, 150_000)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function loadLog(job: string): Promise<R<string>> {
  const { actor } = await ctx("operator")
  const r = await agentCall<string>("backup_log", { job }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function loadHistory(job?: string): Promise<R<HistoryRow[]>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<HistoryRow[]>("backup_history", { job, limit: 80 }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function browseDir(dir: string): Promise<R<{ name: string; path: string; dir: boolean }[]>> {
  const { actor } = await ctx("admin")
  const r = await agentCall<{ name: string; path: string; dir: boolean }[]>("backup_browse", { dir }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function loadTables(): Promise<R<string[]>> {
  const { actor } = await ctx("admin")
  const r = await agentCall<string[]>("backup_tables", {}, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export type { Schedule }
