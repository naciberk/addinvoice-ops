import Link from "next/link"
import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { bytes, dt } from "@/lib/format"
import { can } from "@/lib/roles"
import { describeSchedule, type Overview } from "@/lib/backup-types"
import { HelpLink } from "@/components/panel/help-link"
import { Dot, Empty, ErrorNote, PageTitle, Section, Stat, td, th } from "@/components/panel/ui"
import { HistoryBox, RunNow, ToggleJob } from "@/components/panel/backup/buttons"

export const metadata = { title: "Yedekleme (hedefler ve görevler)" }
export const dynamic = "force-dynamic"

export default async function BackupPage() {
  const { user } = await requireSession()
  const admin = can(user.role, "admin")
  const operator = can(user.role, "operator")
  const r = await agentCall<Overview>("backup_overview", {}, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Yedekleme" /><ErrorNote msg={r.error} /></>)
  const o = r.data
  const all = o.jobs.filter((j) => j.enabled).flatMap((j) => j.status.map((s) => ({ job: j, s })))
  const failing = all.filter(({ s }) => s.ok === false).length
  const running = all.filter(({ s }) => s.running).length
  const nextAll = o.jobs.filter((j) => j.enabled && j.next[0]).sort((a, b) => a.next[0].localeCompare(b.next[0]))[0]

  return (
    <>
      <PageTitle title="Yedekleme" sub="Dosya, veritabanı ve sunucu ayarları yedekleri: şifreli (BorgBackup), görev başına ayrı takvim ve hedef. Zamanlama sunucuda dakikada bir çalışan zamanlayıcıyla yürür." />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link className="underline" href="/backup/targets">Hedefler ({o.targets.length})</Link>
        {admin && <Link className="underline" href="/backup/job/new">+ Yeni görev</Link>}
        <HelpLink id="backup-engine" label="Bu sayfa nasıl çalışır?" />
        <HelpLink id="backup-schedule" label="Zamanlama nasıl seçilir?" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Görev" value={`${o.jobs.filter((j) => j.enabled).length} / ${o.jobs.length}`} sub="etkin / toplam" />
        <Stat label="Hatalı son çalışma" value={failing} tone={failing ? "bad" : "ok"} sub={failing ? "Günlüğe bak" : "hepsi başarılı"} />
        <Stat label="Şu an çalışan" value={running} />
        <Stat label="Sıradaki" value={nextAll ? dt(nextAll.next[0]) : "—"} sub={nextAll?.name} />
      </div>
      <Section title="Görevler" sub="Saatler Danimarka saatiyle. Hedefe giden her çalışmanın sonucu ayrı gösterilir.">
        {!o.jobs.length ? <Empty>Henüz görev yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Görev</th><th className={th}>Takvim</th><th className={th}>Sıradaki</th><th className={th}>Son çalışma (hedef)</th><th className={th}></th></tr></thead>
            <tbody>
              {o.jobs.map((j) => (
                <tr key={j.id} className={"border-t " + (j.enabled ? "" : "opacity-60")}>
                  <td className={td}>
                    <div className="font-medium">{admin ? <Link className="underline underline-offset-2" href={`/backup/job/${j.id}`}>{j.name}</Link> : j.name}</div>
                    <div className="text-xs text-muted-foreground">{o.typeNames[j.type] ?? j.type} · <code>{j.id}</code>{!j.enabled && " · durdurulmuş"}</div>
                  </td>
                  <td className={td + " text-xs"}>{describeSchedule(j.schedule)}</td>
                  <td className={td + " text-xs whitespace-nowrap"}>{j.enabled && j.next[0] ? dt(j.next[0]) : "—"}</td>
                  <td className={td + " text-xs"}>
                    {j.status.length === 0 ? <span className="text-muted-foreground">henüz çalışmadı</span> : j.status.map((s) => (
                      <div key={s.target} className="whitespace-nowrap">
                        <Dot tone={s.running ? "warn" : s.ok === false ? "bad" : s.ok ? "ok" : "off"} />
                        {s.running ? "çalışıyor" : s.finishedAt ? dt(s.finishedAt * 1000) : "—"}
                        <span className="text-muted-foreground"> → {s.target}{s.sizes ? ` · +${bytes(s.sizes.deduplicated)}` : ""}{s.ok === false ? ` · ${s.message ?? ""}` : ""}</span>
                      </div>
                    ))}
                  </td>
                  <td className={td}>
                    <div className="flex flex-col gap-1 items-start">
                      {operator && <RunNow job={j.id} />}
                      {admin && <ToggleJob id={j.id} enabled={j.enabled} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Çalışma geçmişi" sub="Son çalışmalar (en yeni üstte).">
        <HistoryBox />
      </Section>
      {o.savedAt && <p className="text-xs text-muted-foreground">Yapılandırma son kaydedilme: {dt(o.savedAt)} · {o.savedBy}</p>}
    </>
  )
}
