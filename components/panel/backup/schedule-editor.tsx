"use client"

import { useEffect, useState } from "react"
import { previewSchedule } from "@/app/(panel)/backup/actions"
import type { ScheduleInput } from "@/lib/backup-types"
import { cn } from "@/lib/utils"

type Manual = Extract<ScheduleInput, { kind: "manual" }>
const MON = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]
const DOW = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const p2 = (n: number) => String(n).padStart(2, "0")

const DEFAULT_MANUAL: Manual = { kind: "manual", minutes: [0], hours: [3], months: "*", years: null, dom: { mode: "all" }, dow: { mode: "all" } }

/** Tıklanabilir sayı hücreleri (çoklu seçim). */
function Cells({ values, selected, onToggle, cols = 12, label }: { values: number[]; selected: number[]; onToggle: (v: number) => void; cols?: number; label?: (v: number) => string }) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {values.map((v) => {
        const on = selected.includes(v)
        return (
          <button key={v} type="button" onClick={() => onToggle(v)} className={cn("rounded border px-1 py-1 text-xs tabular-nums", on ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted")} aria-pressed={on}>
            {label ? label(v) : v}
          </button>
        )
      })}
    </div>
  )
}
const toggle = (arr: number[], v: number) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v].sort((a, b) => a - b))

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="text-xs font-semibold">{title}</div>
      {children}
    </div>
  )
}
function Radio({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} /> {children}
    </label>
  )
}

export function ScheduleEditor({ value, onChange }: { value: ScheduleInput; onChange: (v: ScheduleInput) => void }) {
  const [preview, setPreview] = useState<{ next: string[]; perDay: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState<Manual>(value.kind === "manual" ? value : DEFAULT_MANUAL)
  const [cron, setCron] = useState(value.kind === "cron" ? value.expr : "30 4 * * *")
  const [every, setEvery] = useState<Extract<ScheduleInput, { kind: "every" }>>(value.kind === "every" ? value : { kind: "every", n: 1, unit: "days", hour: 3, minute: 0 })

  // Seçim değiştikçe sunucudan doğrula + sonraki çalışma zamanlarını göster
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await previewSchedule(value).catch(() => null)
      if (!r) return
      if (r.ok) { setPreview(r.data); setErr(null) } else { setPreview(null); setErr(r.message) }
    }, 350)
    return () => clearTimeout(t)
  }, [value])

  const mode = value.kind
  const setManualAnd = (m: Manual) => { setManual(m); onChange(m) }
  const setEveryAnd = (e: typeof every) => { setEvery(e); onChange(e) }

  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <div className="text-sm font-semibold">Ne zaman çalışsın?</div>
      <div className="flex flex-col gap-3">
        <Radio checked={mode === "every"} onChange={() => onChange(every)}>
          <span className="font-medium">Her</span>
          <span className="inline-flex flex-wrap items-center gap-2 ml-2">
            <select className="rounded border bg-background px-2 py-1 text-sm" disabled={mode !== "every"} value={every.unit} onChange={(e) => {
              const unit = e.target.value as "minutes" | "hours" | "days"
              setEveryAnd({ kind: "every", unit, n: unit === "days" ? 1 : unit === "hours" ? 6 : 15, minute: every.minute ?? 0, hour: every.hour ?? 3 })
            }}>
              <option value="minutes">N dakikada bir</option><option value="hours">N saatte bir</option><option value="days">gün</option>
            </select>
            {every.unit !== "days" && (
              <select className="rounded border bg-background px-2 py-1 text-sm" disabled={mode !== "every"} value={every.n} onChange={(e) => setEveryAnd({ ...every, n: Number(e.target.value) })}>
                {(every.unit === "minutes" ? [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] : [1, 2, 3, 4, 6, 8, 12]).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
            {every.unit === "hours" && <span className="text-sm">saatin <input type="number" min={0} max={59} disabled={mode !== "every"} className="w-16 rounded border bg-background px-2 py-1 text-sm" value={every.minute ?? 0} onChange={(e) => setEveryAnd({ ...every, minute: Number(e.target.value) })} />. dakikasında</span>}
            {every.unit === "days" && <span className="text-sm">saat <input type="number" min={0} max={23} disabled={mode !== "every"} className="w-16 rounded border bg-background px-2 py-1 text-sm" value={every.hour ?? 0} onChange={(e) => setEveryAnd({ ...every, hour: Number(e.target.value) })} /> : <input type="number" min={0} max={59} disabled={mode !== "every"} className="w-16 rounded border bg-background px-2 py-1 text-sm" value={every.minute ?? 0} onChange={(e) => setEveryAnd({ ...every, minute: Number(e.target.value) })} /></span>}
          </span>
        </Radio>

        <Radio checked={mode === "cron"} onChange={() => onChange({ kind: "cron", expr: cron })}>
          <span className="font-medium">Cron ifadesi</span>
        </Radio>
        {mode === "cron" && (
          <div className="ml-6 flex flex-col gap-1">
            <input className="rounded border bg-background px-2 py-1.5 text-sm font-mono max-w-md" value={cron} onChange={(e) => { setCron(e.target.value); onChange({ kind: "cron", expr: e.target.value }) }} placeholder="dakika saat gün ay haftanın-günü" />
            <span className="text-xs text-muted-foreground">Örnekler: <code>30 4 * * *</code> her gün 04:30 · <code>0 */6 * * *</code> 6 saatte bir · <code>0 3 * * mon-fri</code> hafta içi 03:00. Gün ve haftanın gününü aynı anda kısıtlamak için “Elle seç”i kullan.</span>
          </div>
        )}

        <Radio checked={mode === "manual"} onChange={() => onChange(manual)}>
          <span className="font-medium">Elle seç</span>
        </Radio>
      </div>

      {mode === "manual" && (
        <div className="rounded-md bg-muted/40 p-3 grid gap-5 md:grid-cols-2">
          <Block title="Dakikalar">
            <div className="flex gap-4"><Radio checked={manual.minutes === "*"} onChange={() => setManualAnd({ ...manual, minutes: "*" })}>Hepsi</Radio><Radio checked={manual.minutes !== "*"} onChange={() => setManualAnd({ ...manual, minutes: [0] })}>Seçili</Radio></div>
            {manual.minutes !== "*" && <Cells values={range(0, 59)} selected={manual.minutes} cols={10} label={p2} onToggle={(v) => setManualAnd({ ...manual, minutes: toggle(manual.minutes as number[], v) })} />}
          </Block>
          <Block title="Saatler">
            <div className="flex gap-4"><Radio checked={manual.hours === "*"} onChange={() => setManualAnd({ ...manual, hours: "*" })}>Hepsi</Radio><Radio checked={manual.hours !== "*"} onChange={() => setManualAnd({ ...manual, hours: [3] })}>Seçili</Radio></div>
            {manual.hours !== "*" && <Cells values={range(0, 23)} selected={manual.hours} cols={8} label={p2} onToggle={(v) => setManualAnd({ ...manual, hours: toggle(manual.hours as number[], v) })} />}
          </Block>
          <Block title="Günler (ayın)">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Radio checked={manual.dom.mode === "all"} onChange={() => setManualAnd({ ...manual, dom: { mode: "all" } })}>Hepsi</Radio>
              <Radio checked={manual.dom.mode === "last"} onChange={() => setManualAnd({ ...manual, dom: { mode: "last" } })}>Ayın son günü</Radio>
              <Radio checked={manual.dom.mode === "days"} onChange={() => setManualAnd({ ...manual, dom: { mode: "days", days: [1] }, dow: manual.dow.mode === "all" ? manual.dow : { mode: "all" } })}>Seçili</Radio>
            </div>
            {manual.dom.mode === "days" && <Cells values={range(1, 31)} selected={manual.dom.days ?? []} cols={8} onToggle={(v) => setManualAnd({ ...manual, dom: { mode: "days", days: toggle(manual.dom.days ?? [], v) } })} />}
          </Block>
          <Block title="Aylar">
            <div className="flex gap-4"><Radio checked={manual.months === "*"} onChange={() => setManualAnd({ ...manual, months: "*" })}>Hepsi</Radio><Radio checked={manual.months !== "*"} onChange={() => setManualAnd({ ...manual, months: [1] })}>Seçili</Radio></div>
            {manual.months !== "*" && <Cells values={range(1, 12)} selected={manual.months} cols={6} label={(v) => MON[v - 1]} onToggle={(v) => setManualAnd({ ...manual, months: toggle(manual.months as number[], v) })} />}
          </Block>
          <Block title="Haftanın günleri">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Radio checked={manual.dow.mode === "all"} onChange={() => setManualAnd({ ...manual, dow: { mode: "all" } })}>Hepsi</Radio>
              <Radio checked={manual.dow.mode === "nth"} onChange={() => setManualAnd({ ...manual, dow: { mode: "nth", n: 1, day: 1 }, dom: manual.dom.mode === "all" ? manual.dom : { mode: "all" } })}>Ayın N. … günü</Radio>
              <Radio checked={manual.dow.mode === "days"} onChange={() => setManualAnd({ ...manual, dow: { mode: "days", days: [1] }, dom: manual.dom.mode === "all" ? manual.dom : { mode: "all" } })}>Seçili</Radio>
            </div>
            {manual.dow.mode === "nth" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                Ayın
                <select className="rounded border bg-background px-2 py-1" value={manual.dow.n} onChange={(e) => setManualAnd({ ...manual, dow: { ...manual.dow, mode: "nth", n: Number(e.target.value) } })}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}.</option>)}<option value={-1}>son</option>
                </select>
                <select className="rounded border bg-background px-2 py-1" value={manual.dow.day} onChange={(e) => setManualAnd({ ...manual, dow: { ...manual.dow, mode: "nth", day: Number(e.target.value) } })}>
                  {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
                günü
              </div>
            )}
            {manual.dow.mode === "days" && <Cells values={[1, 2, 3, 4, 5, 6, 0]} selected={manual.dow.days ?? []} cols={4} label={(v) => DOW[v]} onToggle={(v) => setManualAnd({ ...manual, dow: { mode: "days", days: toggle(manual.dow.days ?? [], v) } })} />}
          </Block>
          <Block title="Yıllar">
            <div className="flex gap-4"><Radio checked={!manual.years || manual.years === "*"} onChange={() => setManualAnd({ ...manual, years: null })}>Hepsi</Radio><Radio checked={Array.isArray(manual.years)} onChange={() => setManualAnd({ ...manual, years: [2027] })}>Seçili</Radio></div>
            {Array.isArray(manual.years) && <Cells values={range(2026, 2037)} selected={manual.years} cols={6} onToggle={(v) => setManualAnd({ ...manual, years: toggle(manual.years as number[], v) })} />}
          </Block>
        </div>
      )}

      <div className="text-xs">
        {err ? <span className="text-destructive">⚠ {err}</span> : preview ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Sonraki çalışmalar ({preview.perDay} kez/gün eşleşen zaman):</span>
            <span className="font-mono">{preview.next.map((d) => new Intl.DateTimeFormat("da-DK", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Copenhagen" }).format(new Date(d))).join("  ·  ") || "—"}</span>
          </div>
        ) : <span className="text-muted-foreground">Doğrulanıyor…</span>}
      </div>
    </div>
  )
}
