"use server"

import { agentCall } from "@/lib/agent-client"
import { audit } from "@/lib/audit"
import { assertRole, clientInfo } from "@/lib/auth"
import { rateLimit } from "@/lib/ratelimit"
import type { R } from "@/app/(panel)/backup/actions"

async function ctx() {
  const a = await assertRole("admin")
  const { ip } = await clientInfo()
  return { user: a.user, ip, actor: { email: a.user.email, role: a.user.role } }
}
const fail = (message: string): R<never> => ({ ok: false, message })

export type Child = { name: string; path: string; dir: boolean; files: number; size: number; mtime: string }
export type Browse = { dir: string; children: Child[]; truncated: boolean; totalEntries: number }
export type DbSummary = { id: string; db: string; archive: string; tables: { name: string; rows: number }[]; companyTables: string[]; companies: { id: string; name: string }[] }
export type Workspace = { id: string; created: number; type: string; archive: string; target: string; actor: string; db: string | null }
export type JobView = { id: string; state: "running" | "done" | "failed"; label: string; log: string[]; result: unknown; secret: string | null }

export async function restoreBrowse(target: string, archive: string, dir: string, auto = false): Promise<R<Browse>> {
  const { actor } = await ctx()
  const r = await agentCall<Browse>("restore_browse", { target, archive, dir, auto }, actor, 120_000)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function startExtract(target: string, archive: string, paths: string[]): Promise<R<{ jobId: string }>> {
  const { user, ip, actor } = await ctx()
  if (!rateLimit(`rs:${user.id}`, 20, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<{ jobId: string }>("restore_extract", { target, archive, paths }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "restore.files", target: `${archive} (${paths.length} yol)`, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function startDbPrepare(target: string, archive: string): Promise<R<{ jobId: string }>> {
  const { user, ip, actor } = await ctx()
  if (!rateLimit(`rs:${user.id}`, 20, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<{ jobId: string }>("restore_db_prepare", { target, archive }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "restore.db.prepare", target: archive, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function dbSummary(id: string): Promise<R<DbSummary>> {
  const { actor } = await ctx()
  const r = await agentCall<DbSummary>("restore_db_summary", { id }, actor, 120_000)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function dbPreview(id: string, table: string, companyId?: string): Promise<R<{ table: string; total: number; shown: number; rows: Record<string, unknown>[] }>> {
  const { user, ip, actor } = await ctx()
  const r = await agentCall<{ table: string; total: number; shown: number; rows: Record<string, unknown>[] }>("restore_db_preview", { id, table, companyId: companyId || undefined }, actor, 120_000)
  await audit({ actor: user.email, role: user.role, action: "restore.db.preview", target: `${table}${companyId ? " (şirket süzgeci)" : ""}`, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function startDbExport(id: string, opts: { tables?: string[]; companyId?: string; companyPackage?: boolean }): Promise<R<{ jobId: string }>> {
  const { user, ip, actor } = await ctx()
  if (!rateLimit(`rs:${user.id}`, 20, 10 * 60_000).ok) return fail("Çok sık işlem.")
  const r = await agentCall<{ jobId: string }>("restore_db_export", { id, ...opts }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: opts.companyPackage ? "restore.db.company-package" : "restore.db.csv", target: `${id}${opts.tables ? " (" + opts.tables.length + " tablo)" : ""}`, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

export async function cleanupWorkspace(id: string): Promise<R> {
  const { user, ip, actor } = await ctx()
  const r = await agentCall<string>("restore_cleanup", { id }, actor, 60_000)
  await audit({ actor: user.email, role: user.role, action: "restore.cleanup", target: id, ip, ok: r.ok, detail: r.ok ? undefined : r.error })
  return r.ok ? { ok: true, data: undefined, message: r.data } : fail(r.error)
}

export async function listWorkspaces(): Promise<R<Workspace[]>> {
  const { actor } = await ctx()
  const r = await agentCall<Workspace[]>("restore_list", {}, actor)
  return r.ok ? { ok: true, data: r.data } : fail(r.error)
}

/** İşin durumu. Parola (sır) yalnız işi başlatan kişiye ve yalnız ilk okumada teslim edilir. */
export async function getJob(jobId: string): Promise<R<JobView | null>> {
  const { actor } = await ctx()
  const r = await agentCall<JobView[]>("jobs", {}, actor)
  if (!r.ok) return fail(r.error)
  return { ok: true, data: r.data.find((j) => j.id === jobId) ?? null }
}
