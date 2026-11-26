"use server"

import { revalidatePath } from "next/cache"
import { agentCall } from "@/lib/agent-client"
import { audit } from "@/lib/audit"
import { assertRole, clientInfo } from "@/lib/auth"
import { rateLimit } from "@/lib/ratelimit"
import type { Role } from "@/lib/store"
import type { ScheduleInput } from "@/lib/backup-types"
import type { CronJobInput, CronPreview, DayGridData, MigratePlan, RunRec, SlotSuggestion } from "@/lib/cron-types"

export type R<T = undefined> = { ok: true; data: T; message?: string } | { ok: false; message: string }

async function ctx(min: Role) {
  const a = await assertRole(min)
  const { ip } = await clientInfo()
  return { user: a.user, ip, actor: { email: a.user.email, role: a.user.role } }
}
const fail = (message: string): R<never> => ({ ok: false, message })

/** Görevi ekle/güncelle (yönetici). Ajan her şeyi (worker izin listesi, zamanlama, süre) KENDİ doğrular. */
export async function saveCronJob(job: CronJobInput): Promise<R<{ id: string; created: boolean }>> {
  const { user, ip, actor } = await ctx("admin")
  if (!rateLimit(`cr:${user.id}`, 60, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<{ id: string; created: boolean }>("cron_job_save", { job }, actor, 30_000)
  await audit({ actor: user.email, role: user.role, action: job.id ? "cron.job.update" : "cron.job.create", target: job.id || job.target, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: r.data, message: r.data.created ? "Görev eklendi." : "Kaydedildi." }
}

export async function deleteCronJob(id: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("cron_job_delete", { id }, actor)
  await audit({ actor: user.email, role: user.role, action: "cron.job.delete", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: undefined, message: r.data }
}

export async function toggleCronJob(id: string, enabled: boolean): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("cron_job_toggle", { id, enabled }, actor)
  await audit({ actor: user.email, role: user.role, action: enabled ? "cron.job.enable" : "cron.job.disable", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: undefined, message: r.data }
}

/** Şimdi çalıştır: faturalama gibi görevler gerçek işlem yapar, bu yüzden yönetici ve onaylı. */
export async function runCronJob(id: string): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  if (!rateLimit(`crrun:${user.id}`, 20, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<string>("cron_job_run", { id }, actor)
  await audit({ actor: user.email, role: user.role, action: "cron.job.run", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: undefined, message: r.data }
}

export async function setCronScheduler(enabled: boolean): Promise<R> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<string>("cron_scheduler", { enabled }, actor, 30_000)
  await audit({ actor: user.email, role: user.role, action: enabled ? "cron.scheduler.enable" : "cron.scheduler.disable", ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: undefined, message: r.data }
}

export async function loadCronHistory(job: string, limit = 50): Promise<R<RunRec[]>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<RunRec[]>("cron_history", { job, limit }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function cronPreview(schedule: ScheduleInput, excludeId?: string): Promise<R<CronPreview>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<CronPreview>("cron_preview", { schedule, excludeId }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function cronSuggest(hour: number | null, excludeId?: string): Promise<R<SlotSuggestion[]>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<SlotSuggestion[]>("cron_suggest", { hour, excludeId }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function loadCronGrid(date: string): Promise<R<DayGridData>> {
  const { actor } = await ctx("viewer")
  const r = await agentCall<DayGridData>("cron_grid", { date }, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function loadMigratePlan(): Promise<R<MigratePlan>> {
  const { actor } = await ctx("admin")
  const r = await agentCall<MigratePlan>("cron_migrate_plan", {}, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

/** Eski crontab'dan taşıma: yazarak onay (TAŞI). Ajan crontab'ı yedekler, satırları çıkarır, tick satırını kurar. */
export async function applyMigration(confirm: string): Promise<R<{ migrated: number; duplicates: number; backupFile: string }>> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<{ migrated: number; duplicates: number; backupFile: string }>("cron_migrate_apply", { confirm }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "cron.migrate.apply", ip, ok: r.ok, detail: r.ok ? `${r.data.migrated} görev; yedek ${r.data.backupFile}` : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: r.data, message: `${r.data.migrated} görev taşındı. Eski crontab yedeği: ${r.data.backupFile}` }
}

export async function rollbackMigration(): Promise<R<{ restored: string }>> {
  const { user, ip, actor } = await ctx("admin")
  const r = await agentCall<{ restored: string }>("cron_migrate_rollback", {}, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "cron.migrate.rollback", ip, ok: r.ok, detail: r.ok ? r.data.restored : r.error })
  if (!r.ok) return fail(r.error)
  revalidatePath("/cron")
  return { ok: true, data: r.data, message: `Eski crontab geri konuldu (${r.data.restored}); zamanlayıcı kapatıldı.` }
}
