export function bytes(n: number | string | null | undefined): string {
  const v = Number(n ?? 0)
  if (!isFinite(v) || v <= 0) return "0 B"
  const u = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1)
  const x = v / 1024 ** i
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`
}
export const num = (n: number | string | null | undefined) => new Intl.NumberFormat("da-DK").format(Number(n ?? 0))
export function dt(v: string | number | Date | null | undefined): string {
  if (!v) return "—"
  return new Intl.DateTimeFormat("da-DK", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Copenhagen" }).format(new Date(v))
}
export function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 90) return `${s} sn önce`
  if (s < 5400) return `${Math.round(s / 60)} dk önce`
  if (s < 129600) return `${Math.round(s / 3600)} sa önce`
  return `${Math.round(s / 86400)} gün önce`
}
