"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { applyMigration, rollbackMigration, type R } from "@/app/(panel)/cron/actions"
import type { MigratePlan } from "@/lib/cron-types"

const LABEL = { migrate: ["taşınacak", "text-emerald-700"], duplicate: ["zaten tanımlı", "text-amber-700"], keep: ["dokunulmaz", "text-muted-foreground"] } as const

export function MigratePanel({ plan }: { plan: MigratePlan }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [confirm, setConfirm] = useState("")
  const [r, setR] = useState<R<unknown> | null>(null)
  return (
    <div className="flex flex-col gap-4">
      {plan.problems.length > 0 && <ul className="text-sm text-destructive list-disc pl-5">{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3">Satır</th><th className="pr-3">Takvim</th><th className="pr-3">Worker / komut</th><th className="pr-3">Durum</th><th>Neden</th></tr></thead>
          <tbody>{plan.items.map((x) => (
            <tr key={x.lineNo} className="border-t align-top">
              <td className="py-1 pr-3 tabular-nums">{x.lineNo}</td>
              <td className="pr-3 font-mono whitespace-nowrap">{x.expr}</td>
              <td className="pr-3 font-mono break-all">{x.name ?? x.command}</td>
              <td className={`pr-3 font-medium ${LABEL[x.status][1]}`}>{LABEL[x.status][0]}</td>
              <td className="text-muted-foreground">{x.reason ?? ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-sm"><b>{plan.migratable}</b> satır taşınabilir · <b>{plan.keep}</b> satır dokunulmaz.</p>

      {plan.migratable > 0 ? (
        <div className="rounded-md border p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold">Taşımayı uygula</div>
          <ol className="text-xs text-muted-foreground list-decimal pl-5 flex flex-col gap-1">
            <li>Mevcut crontab olduğu gibi yedeklenir (/var/backups/addinvoice-cron).</li>
            <li>Tanınan worker satırları görev olarak içe aktarılır; gizli anahtar kopyalanmaz (çalışma anında ana uygulamanın .env'inden okunur).</li>
            <li>O satırlar crontab'dan çıkarılır, diğer satırlara dokunulmaz; tek bir dakikalık zamanlayıcı satırı kurulur.</li>
            <li>Bir görev bir dakika içinde çalışacaksa işlem reddedilir (kaçırma/ikilenme olmasın); birkaç dakika sonra tekrar dene.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <input className="rounded border bg-background px-2 py-1.5 text-sm w-32" placeholder="TAŞI" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button disabled={pending || confirm !== "TAŞI" || plan.problems.length > 0} onClick={() => start(async () => { const x = await applyMigration(confirm); setR(x); if (x.ok) { setConfirm(""); router.refresh() } })}>{pending ? "Taşınıyor…" : "Taşı"}</Button>
            <span className="text-xs text-muted-foreground">Onay için kutuya TAŞI yazın.</span>
          </div>
        </div>
      ) : <p className="text-sm text-muted-foreground">Taşınacak worker satırı yok.</p>}

      <div className="rounded-md border p-4 flex flex-col gap-2">
        <div className="text-sm font-semibold">Geri al</div>
        <p className="text-xs text-muted-foreground">Son crontab yedeği geri konur, zamanlayıcı kapatılır ve tick satırı kaldırılır: her şey eski haline döner. {plan.backups.length ? `Son yedek: ${plan.backups[0]}` : "Henüz yedek yok."}</p>
        <div><Button variant="destructive" size="sm" disabled={pending || !plan.backups.length} onClick={() => {
          if (!window.confirm(`Eski crontab geri konulacak (${plan.backups[0]}) ve zamanlayıcı kapatılacak. Devam edilsin mi?`)) return
          start(async () => { const x = await rollbackMigration(); setR(x); if (x.ok) router.refresh() })
        }}>Eski crontab'ı geri koy</Button></div>
      </div>
      {r?.message && <p className={r.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{r.message}</p>}
    </div>
  )
}
