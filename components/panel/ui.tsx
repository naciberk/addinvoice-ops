import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {sub && <p className="text-sm text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

export function Section({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
        </div>
        {right}
      </CardHeader>
      <CardContent className="overflow-x-auto">{children}</CardContent>
    </Card>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn("text-xl font-semibold mt-1", tone === "bad" && "text-red-600", tone === "warn" && "text-amber-600", tone === "ok" && "text-emerald-600")}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  )
}

export function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) {
  const c = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500", off: "bg-gray-400" }[tone]
  return <span className={cn("inline-block w-2 h-2 rounded-full mr-2", c)} />
}

export function ErrorNote({ msg }: { msg: string }) {
  return <p className="text-sm text-destructive">Veri alınamadı: {msg}</p>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

export const th = "text-left font-medium text-muted-foreground text-xs px-2 py-2 whitespace-nowrap"
export const td = "px-2 py-2 text-sm align-top"
