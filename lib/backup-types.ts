// Yedekleme motoru (agent/backup-engine.mjs) ile ortak tipler ve zamanlama metni. Yalnız tip + saf fonksiyon (istemci ve sunucuda kullanılır).
export type ScheduleInput =
  | { kind: "every"; n: number; unit: "minutes" | "hours" | "days"; minute?: number; hour?: number }
  | { kind: "cron"; expr: string }
  | { kind: "manual"; minutes: number[] | "*"; hours: number[] | "*"; months: number[] | "*"; years: number[] | "*" | null; dom: { mode: "all" | "days" | "last"; days?: number[] }; dow: { mode: "all" | "days" | "nth"; days?: number[]; n?: number; day?: number } }

export type Schedule = {
  minutes: number[]; hours: number[]; months: number[]; years: number[] | null
  dom: null | { days?: number[]; last?: boolean }
  dow: null | { days?: number[]; nth?: { n: number; day: number } }
  source: ScheduleInput
}
export type JobType = "uploads" | "code" | "db" | "tables" | "server" | "custom" | "verify"
export type Job = {
  id: string; name: string; type: JobType; enabled: boolean; targets: string[]; schedule: Schedule
  options: { paths?: string[]; excludes?: string[]; tables?: string[]; includePgbackrest?: boolean; checkJobId?: string }
  graceMin: number; createdAt: string
}
export type Target = { id: string; name: string; type: "ssh" | "path"; enabled: boolean; host?: string; port?: number; user?: string; auth?: "key" | "password"; remotePath?: string; repoPath: string; mountCheck?: string; credDir: string; note?: string }
export type JobStatus = { target: string; running?: boolean; ok?: boolean; rc?: number; startedAt?: number; finishedAt?: number; lastOkAt?: number; durationSec?: number; archive?: string | null; message?: string; sizes?: { original: number; compressed: number; deduplicated: number; files: number } | null }
export type OverviewJob = Job & { sources?: string[]; next: string[]; last: string | null; status: JobStatus[] }
export type Overview = { targets: (Target & { location?: string })[]; jobs: OverviewJob[]; typeNames: Record<string, string>; allowedRoots: string[]; savedAt: string | null; savedBy: string | null }
export type Config = { targets: Target[]; jobs: Job[]; typeNames: Record<string, string>; allowedRoots: string[] }
export type HistoryRow = { ts: string; job: string; target: string; ok: boolean; rc?: number; durationSec?: number; archive?: string | null; sizes?: JobStatus["sizes"]; message?: string }

const DOW = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]
const MON = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
const p2 = (n: number) => String(n).padStart(2, "0")

/** Zamanlamanın insan diline çevrilmiş kısa metni. */
export function describeSchedule(s: Schedule): string {
  const src = s.source
  if (src?.kind === "every") {
    if (src.unit === "minutes") return `Her ${src.n} dakikada bir`
    if (src.unit === "hours") return `Her ${src.n} saatte bir (dakika :${p2(src.minute ?? 0)})`
    return `Her gün ${p2(src.hour ?? 0)}:${p2(src.minute ?? 0)}`
  }
  const times: string[] = []
  if (s.hours.length * s.minutes.length <= 8) for (const h of s.hours) for (const m of s.minutes) times.push(`${p2(h)}:${p2(m)}`)
  const t = times.length ? times.join(", ") : `${s.hours.length === 24 ? "her saat" : "saat " + s.hours.join(",")} · ${s.minutes.length === 60 ? "her dakika" : "dakika " + s.minutes.join(",")}`
  const parts: string[] = []
  if (s.dom?.last) parts.push("ayın son günü")
  else if (s.dom?.days) parts.push(`ayın ${s.dom.days.join(", ")}. günü`)
  if (s.dow?.days) parts.push(s.dow.days.map((d) => DOW[d]).join(", "))
  if (s.dow?.nth) parts.push(`ayın ${s.dow.nth.n === -1 ? "son" : s.dow.nth.n + "."} ${DOW[s.dow.nth.day]} günü`)
  if (s.months.length < 12) parts.push(s.months.map((m) => MON[m - 1]).join(", "))
  if (s.years) parts.push(s.years.join(", "))
  return `${parts.length ? parts.join(" · ") + " · " : "Her gün · "}${t}`
}
export function emptyJob(): Job {
  return { id: "", name: "", type: "custom", enabled: true, targets: [], graceMin: 45, createdAt: new Date().toISOString(), options: { paths: [] }, schedule: { minutes: [0], hours: [3], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], years: null, dom: null, dow: null, source: { kind: "every", n: 1, unit: "days", hour: 3, minute: 0 } } }
}

export type NotifySettings = {
  recipients: string[]
  alert: { enabled: boolean; afterFailures: number; recovery: boolean }
  daily: { enabled: boolean; hour: number; minute: number; onlyOnProblems: boolean }
  weekly: { enabled: boolean; weekday: number; hour: number; minute: number }
  secondary: string[]
  configured?: boolean
  savedAt?: string | null
  savedBy?: string | null
}
