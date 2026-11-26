// Zamanlanmış görevler (agent/cron-engine.mjs) ile ortak tipler.
import type { Schedule, ScheduleInput } from "./backup-types"

export type RunRec = { ts: string; job: string; trigger: "schedule" | "manual"; slot: string | null; outcome: "ok" | "fail" | "skipped"; status?: number; ms?: number; reason?: string; message?: string }
export type WorkerInfo = { name: string; method: "GET" | "POST"; auth: "header" | "key"; description: string; curated?: boolean }
export type CronJob = {
  id: string; name: string; target: string; method: string; auth: string; enabled: boolean; schedule: Schedule; timeoutSec: number; note: string; createdAt: string; importedFrom?: string
  next: string[]; lastSlot: string | null
  state: { lastRun: RunRec | null; lastOkAt: string | null; consecutiveFailures: number; running: boolean }
  stats24h: { ok: number; fail: number; skipped: number }
  frequent: boolean
  description: string
}
export type CronOverview = { enabled: boolean; tickInstalled: boolean; heartbeat: string | null; jobs: CronJob[]; workers: WorkerInfo[]; unscheduled: WorkerInfo[]; legacyLines: number; savedAt: string | null; savedBy: string | null }
export type SystemCron = { id: string; source: string; user: string; expr: string; label: string; info: string | null; command: string; schedule: Schedule | null; unparsed: string | null; ours: boolean; next: string[] }
export type CronPreview = { next: string[]; perDay: number; frequent: boolean; collisions: { at: string; with: string[] }[] }
export type SlotSuggestion = { hour: number; minute: number; score: number; load: number }
export type DayGridData = { date: string; cells: number[]; at: Record<string, string[]>; collisions: { minute: string; names: string[] }[]; frequent: { name: string; kind: string; perDay: number }[]; total: number }
export type MigrateItem = { lineNo: number; expr: string; name?: string; command?: string; method?: string; auth?: string; status: "migrate" | "duplicate" | "keep"; reason: string | null; perDay?: number }
export type MigratePlan = { items: MigrateItem[]; migratable: number; keep: number; problems: string[]; enabled: boolean; backups: string[] }
export type CronJobInput = { id?: string; name: string; target: string; schedule: ScheduleInput; enabled: boolean; timeoutSec: number; note: string }
