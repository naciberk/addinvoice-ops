"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { dt } from "@/lib/format"
import { deleteCronJob, loadCronHistory, runCronJob, setCronScheduler, toggleCronJob, type R } from "@/app/(panel)/cron/actions"
import type { RunRec } from "@/lib/cron-types"

function Msg({ r }: { r: R<unknown> | null }) {
  if (!r?.message) return null
  return <span className={r.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{r.message}</span>
}

/** Şimdi çalıştır: faturalama/e-posta gönderen görevler GERÇEK işlem yapar, bu yüzden onay istenir. */
export function RunNowCron({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => {
        if (!window.confirm(`"${name}" şimdi çalıştırılacak. Bu görev gerçek işlem yapar (e-posta, SMS, faturalama gibi). Devam edilsin mi?`)) return
        start(async () => { setR(await runCronJob(id)); setTimeout(() => router.refresh(), 5000) })
      }}>{pending ? "…" : "Şimdi çalıştır"}</Button>
      <Msg r={r} />
    </span>
  )
}

export function ToggleCron({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const x = await toggleCronJob(id, !enabled); setR(x); if (x.ok) router.refresh() })}>{enabled ? "Duraklat" : "Devam ettir"}</Button>
      <Msg r={r} />
    </span>
  )
}

export function DeleteCron({ id }: { id: string }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => {
        if (window.prompt(`'${id}' görevi silinecek (zamanlamadan kalkar; worker'ın kendisi ve verileri silinmez).\nDevam etmek için görev kimliğini yaz: ${id}`)?.trim() !== id) return
        start(async () => { const x = await deleteCronJob(id); setR(x); if (x.ok) router.push("/cron") })
      }}>Görevi sil</Button>
      <Msg r={r} />
    </span>
  )
}

/** Zamanlayıcıyı aç/kapat: kapatınca TÜM yönetilen görevler durur. */
export function SchedulerToggle({ enabled }: { enabled: boolean }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant={enabled ? "destructive" : "default"} disabled={pending} onClick={() => {
        const q = enabled ? "Zamanlayıcı DURDURULACAK: bu sayfadaki hiçbir görev çalışmayacak. Devam edilsin mi?" : "Zamanlayıcı açılacak ve bu sayfadaki görevler zamanı gelince çalışmaya başlayacak. Devam edilsin mi?"
        if (!window.confirm(q)) return
        start(async () => { const x = await setCronScheduler(!enabled); setR(x); if (x.ok) router.refresh() })
      }}>{enabled ? "Zamanlayıcıyı durdur" : "Zamanlayıcıyı aç"}</Button>
      <Msg r={r} />
    </span>
  )
}

const OUTCOME = { ok: ["başarılı", "text-emerald-700"], fail: ["HATA", "text-destructive"], skipped: ["atlandı", "text-amber-700"] } as const

export function CronHistory({ job }: { job: string }) {
  const [rows, setRows] = useState<RunRec[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { loadCronHistory(job, 50).then((r) => (r.ok ? setRows(r.data) : setErr(r.message))).catch(() => setErr("Yüklenemedi")) }, [job])
  if (err) return <p className="text-sm text-destructive">{err}</p>
  if (!rows) return <p className="text-sm text-muted-foreground">Yükleniyor…</p>
  if (!rows.length) return <p className="text-sm text-muted-foreground">Henüz çalışma kaydı yok.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3">Zaman</th><th className="pr-3">Sonuç</th><th className="pr-3">Tetik</th><th className="pr-3">HTTP</th><th className="pr-3">Süre</th><th>Ayrıntı</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-t align-top">
            <td className="py-1 pr-3 whitespace-nowrap">{dt(r.ts)}</td>
            <td className={`pr-3 font-medium ${OUTCOME[r.outcome][1]}`}>{OUTCOME[r.outcome][0]}</td>
            <td className="pr-3">{r.trigger === "manual" ? "elle" : "zamanlı"}</td>
            <td className="pr-3">{r.status ?? "—"}</td>
            <td className="pr-3 whitespace-nowrap">{r.ms != null ? (r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} sn` : `${r.ms} ms`) : "—"}</td>
            <td className="text-muted-foreground break-all">{r.message ?? ""}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}
