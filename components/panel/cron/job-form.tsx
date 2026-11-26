"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ScheduleEditor } from "@/components/panel/backup/schedule-editor"
import { cronPreview, cronSuggest, saveCronJob } from "@/app/(panel)/cron/actions"
import { dt } from "@/lib/format"
import type { ScheduleInput } from "@/lib/backup-types"
import type { CronPreview, SlotSuggestion, WorkerInfo } from "@/lib/cron-types"

const p2 = (n: number) => String(n).padStart(2, "0")

export type CronFormInitial = { id: string; name: string; target: string; schedule: ScheduleInput; enabled: boolean; timeoutSec: number; note: string }

export function CronJobForm({ initial, isNew, workers }: { initial: CronFormInitial; isNew: boolean; workers: WorkerInfo[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [f, setF] = useState(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<CronPreview | null>(null)
  const [sug, setSug] = useState<SlotSuggestion[]>([])
  const lastTarget = useRef(initial.target)
  const worker = workers.find((w) => w.name === f.target)

  // Zamanlama değiştikçe: sonraki çalışmalar + diğer görevlerle aynı dakikaya düşen çakışmalar
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await cronPreview(f.schedule, isNew ? undefined : initial.id).catch(() => null)
      setPreview(r && r.ok ? r.data : null)
    }, 400)
    return () => clearTimeout(t)
  }, [f.schedule, isNew, initial.id])

  // «Her gün, şu saatte» seçiliyse o saatin en boş dakikalarını öner
  const dailyHour = f.schedule.kind === "every" && f.schedule.unit === "days" ? (f.schedule.hour ?? 0) : null
  useEffect(() => {
    if (dailyHour == null) { setSug([]); return }
    const t = setTimeout(async () => {
      const r = await cronSuggest(dailyHour, isNew ? undefined : initial.id).catch(() => null)
      setSug(r && r.ok ? r.data.slice(0, 5) : [])
    }, 400)
    return () => clearTimeout(t)
  }, [dailyHour, isNew, initial.id])

  const submit = () => start(async () => {
    setMsg(null)
    const r = await saveCronJob({ id: isNew ? undefined : f.id, name: f.name.trim() || f.target, target: f.target, schedule: f.schedule, enabled: f.enabled, timeoutSec: f.timeoutSec, note: f.note })
    if (!r.ok) { setMsg({ ok: false, text: r.message }); return }
    router.push("/cron")
    router.refresh()
  })

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Worker (çağrılacak adres)</span>
        <select className="rounded border bg-background px-2 py-2 text-sm font-mono" disabled={!isNew} value={f.target} onChange={(e) => {
          const t = e.target.value
          setF((s) => ({ ...s, target: t, name: !s.name || s.name === lastTarget.current ? t : s.name }))
          lastTarget.current = t
        }}>
          <option value="">— seçin —</option>
          {workers.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
        {worker && <span className="text-xs text-muted-foreground">{worker.description || "Açıklama yok."} <span className="font-mono">({worker.method} /api/internal/{worker.name})</span></span>}
        <span className="text-xs text-muted-foreground">Yalnız ana uygulamadaki kimlik doğrulamalı /api/internal/* adresleri listelenir; keyfi komut çalıştırılamaz. Gizli anahtarı ajan ekler, burada görünmez.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Ad</span>
        <input className="rounded border bg-background px-2 py-2 text-sm" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
      </label>

      <ScheduleEditor value={f.schedule} onChange={(schedule) => setF({ ...f, schedule })} />

      <div className="rounded-md border p-4 text-sm flex flex-col gap-3">
        <div className="font-semibold">Diğer görevlerle çakışma</div>
        {!preview ? <p className="text-xs text-muted-foreground">Hesaplanıyor…</p> : preview.frequent ? (
          <p className="text-xs text-muted-foreground">Bu görev günde {preview.perDay} kez çalışıyor (sık görev): her zaman başka işlerle aynı dakikaya düşer; çakışma analizine girmez. Üst üste binmeyi motor önler (önceki tur sürerken yenisi başlamaz).</p>
        ) : preview.collisions.length === 0 ? (
          <p className="text-xs text-emerald-700">Önümüzdeki 7 günde aynı dakikaya düşen başka (sık olmayan) görev yok.</p>
        ) : (
          <ul className="text-xs flex flex-col gap-1">
            {preview.collisions.map((c, i) => <li key={i}><span className="text-amber-700">⚠ {dt(c.at)}</span> — aynı dakikada: {c.with.join(", ")}</li>)}
          </ul>
        )}
        {sug.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Bu saatte en boş dakikalar (tıkla):</span>
            <div className="flex flex-wrap gap-2">
              {sug.map((s) => (
                <button key={`${s.hour}:${s.minute}`} type="button" className="rounded border px-2 py-1 text-xs tabular-nums hover:bg-muted" onClick={() => setF({ ...f, schedule: { kind: "every", n: 1, unit: "days", hour: s.hour, minute: s.minute } })}>
                  {p2(s.hour)}:{p2(s.minute)}{s.load ? ` (${s.load} görev yakın)` : " (boş)"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Zaman aşımı (saniye)</span>
          <input type="number" min={5} max={1800} className="rounded border bg-background px-2 py-2 text-sm w-32" value={f.timeoutSec} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })} />
          <span className="text-xs text-muted-foreground">Bu süreyi aşan çalışma hata sayılır ve kilit açılır (5-1800).</span>
        </label>
        <label className="flex items-center gap-2 text-sm self-end">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Etkin (kapalıysa zamanlanmaz)
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Not (isteğe bağlı)</span>
        <input className="rounded border bg-background px-2 py-2 text-sm" value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Boşsa worker'ın açıklaması gösterilir" />
      </label>

      <div className="flex items-center gap-3">
        <Button disabled={pending || !f.target} onClick={submit}>{pending ? "Kaydediliyor…" : isNew ? "Görevi ekle" : "Kaydet"}</Button>
        {msg && <span className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{msg.text}</span>}
      </div>
    </div>
  )
}
