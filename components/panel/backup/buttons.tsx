"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CopyCode } from "@/components/panel/copy-code"
import { bytes, dt } from "@/lib/format"
import { deleteJob, deleteTarget, initTarget, loadArchives, loadHistory, loadLog, runJobNow, setupText, testTarget, toggleJob, toggleTarget, type R } from "@/app/(panel)/backup/actions"
import type { HistoryRow, Target } from "@/lib/backup-types"

function Msg({ r }: { r: R<unknown> | null }) {
  if (!r?.message) return null
  return <span className={r.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{r.message}</span>
}

export function RunNow({ job }: { job: string }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { setR(await runJobNow(job)); setTimeout(() => router.refresh(), 4000) })}>{pending ? "…" : "Şimdi çalıştır"}</Button>
      <Msg r={r} />
    </span>
  )
}

export function ToggleJob({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const x = await toggleJob(id, !enabled); setR(x); if (x.ok) router.refresh() })}>{enabled ? "Durdur" : "Etkinleştir"}</Button>
      <Msg r={r} />
    </span>
  )
}

export function DeleteJob({ id }: { id: string }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const router = useRouter()
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => {
        if (window.prompt(`'${id}' görevi silinecek (uzaktaki arşivler SİLİNMEZ).\nDevam etmek için görev kimliğini yaz: ${id}`)?.trim() !== id) return
        start(async () => { const x = await deleteJob(id); setR(x); if (x.ok) router.push("/backup") })
      }}>Görevi sil</Button>
      <Msg r={r} />
    </span>
  )
}

export function TestTarget({ id }: { id: string }) {
  const [pending, start] = useTransition()
  const [steps, setSteps] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1">
      <span><Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { setErr(null); const r = await testTarget(id); if (r.ok) setSteps(r.data); else { setSteps(null); setErr(r.message) } })}>{pending ? "Sınanıyor…" : "Bağlantıyı sına"}</Button></span>
      {err && <span className="text-xs text-destructive">{err}</span>}
      {steps && <ul className="text-xs flex flex-col gap-0.5">{steps.map((s) => <li key={s.name} className={s.ok ? "text-emerald-700" : "text-destructive"}>{s.ok ? "✓" : "✗"} {s.name} — <span className="text-muted-foreground">{s.detail}</span></li>)}</ul>}
    </div>
  )
}

/** Hedef için: depoyu başlat, etkinleştir/durdur, kurulum komutlarını göster, sil. */
export function TargetActions({ t }: { t: Target }) {
  const [pending, start] = useTransition()
  const [r, setR] = useState<R<unknown> | null>(null)
  const [setup, setSetup] = useState<{ publicKey: string | null; fingerprint: string | null; setup: string } | null>(null)
  const router = useRouter()
  const run = (fn: () => Promise<R<unknown>>) => start(async () => { const x = await fn(); setR(x); if (x.ok) router.refresh() })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TestTarget id={t.id} />
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => initTarget(t.id))}>Depoyu başlat</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => toggleTarget(t.id, !t.enabled))}>{t.enabled ? "Durdur" : "Etkinleştir"}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const x = await setupText(t.id); if (x.ok) setSetup(x.data); else setR(x) })}>Kurulum komutları</Button>
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => { if (window.confirm(`'${t.id}' hedefi silinsin mi? (Kimlik bilgileri ve uzaktaki yedekler SİLİNMEZ.)`)) run(() => deleteTarget(t.id)) }}>Sil</Button>
      </div>
      <Msg r={r} />
      {setup && (
        <div className="flex flex-col gap-2">
          {setup.fingerprint && <p className="text-xs">Sunucu parmak izi (hedefte <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> ile aynı olmalı): <code className="break-all">{setup.fingerprint}</code></p>}
          <CopyCode code={setup.setup} />
        </div>
      )}
    </div>
  )
}

export function ArchivesBox({ targets }: { targets: { id: string; name: string }[] }) {
  const [t, setT] = useState(targets[0]?.id ?? "")
  const [pending, start] = useTransition()
  const [data, setData] = useState<{ archives: { name: string; time: string }[]; totalOriginal: number | null; totalUniqueCompressed: number | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  if (!targets.length) return <p className="text-sm text-muted-foreground">Etkin hedef yok.</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border bg-background px-2 py-1.5 text-sm" value={t} onChange={(e) => setT(e.target.value)}>{targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { setErr(null); const r = await loadArchives(t); if (r.ok) setData(r.data); else { setData(null); setErr(r.message) } })}>{pending ? "Okunuyor…" : "Arşivleri listele"}</Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {data && (
        <div className="text-sm">
          <p className="text-xs text-muted-foreground mb-2">Hedefte toplam: {data.totalUniqueCompressed != null ? bytes(data.totalUniqueCompressed) : "?"} (tekilleştirilmiş, sıkıştırılmış) · son 30 arşiv</p>
          <table className="w-full"><tbody>{data.archives.map((a) => <tr key={a.name} className="border-t"><td className="px-2 py-1 font-mono text-xs">{a.name}</td><td className="px-2 py-1 text-xs text-muted-foreground">{a.time}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  )
}

export function HistoryBox({ job }: { job?: string }) {
  const [pending, start] = useTransition()
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <span><Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await loadHistory(job); if (r.ok) { setRows(r.data); setErr(null) } else setErr(r.message) })}>{rows ? "Yenile" : "Geçmişi göster"}</Button></span>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {rows && (
        <table className="w-full">
          <thead><tr>{["Zaman", "Görev", "Hedef", "Sonuç", "Süre", "Boyut (eklenen)", "Mesaj"].map((h) => <th key={h} className="text-left font-medium text-muted-foreground text-xs px-2 py-1 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1 text-xs whitespace-nowrap">{dt(r.ts)}</td><td className="px-2 py-1 text-xs">{r.job}</td><td className="px-2 py-1 text-xs">{r.target}</td>
                <td className={"px-2 py-1 text-xs " + (r.ok ? "text-emerald-700" : "text-destructive")}>{r.ok ? "OK" : "HATA"}</td>
                <td className="px-2 py-1 text-xs">{r.durationSec ?? "—"} sn</td><td className="px-2 py-1 text-xs">{r.sizes ? bytes(r.sizes.deduplicated) : "—"}</td><td className="px-2 py-1 text-xs text-muted-foreground">{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function LogBox({ job }: { job: string }) {
  const [pending, start] = useTransition()
  const [log, setLog] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <span><Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await loadLog(job); setLog(r.ok ? r.data : r.message) })}>{log == null ? "Günlüğü göster" : "Yenile"}</Button></span>
      {log != null && <pre className="rounded-md bg-gray-950 text-gray-100 p-3 text-xs overflow-x-auto max-h-80 whitespace-pre-wrap break-all">{log || "(boş)"}</pre>}
    </div>
  )
}
