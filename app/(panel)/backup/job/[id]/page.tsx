import Link from "next/link"
import { notFound } from "next/navigation"
import { agentCall } from "@/lib/agent-client"
import { requireRole } from "@/lib/auth"
import { emptyJob, type Config } from "@/lib/backup-types"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"
import { HelpLink } from "@/components/panel/help-link"
import { JobForm } from "@/components/panel/backup/job-form"
import { DeleteJob, HistoryBox, LogBox, RunNow } from "@/components/panel/backup/buttons"

export const dynamic = "force-dynamic"
export const metadata = { title: "Yedekleme görevi" }

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user } = await requireRole("admin")
  const r = await agentCall<Config>("backup_config_get", {}, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Yedekleme görevi" /><ErrorNote msg={r.error} /></>)
  const isNew = id === "new"
  const existing = r.data.jobs.find((j) => j.id === id)
  if (!isNew && !existing) notFound()
  const initial = existing ?? { ...emptyJob(), targets: r.data.targets.filter((t) => t.enabled).slice(0, 1).map((t) => t.id) }
  return (
    <>
      <PageTitle title={isNew ? "Yeni yedekleme görevi" : initial.name} sub={isNew ? "Ne yedeklensin, nereye ve ne zaman — seç ve kaydet." : `Kimlik: ${initial.id}`} />
      <p className="text-sm"><Link className="underline" href="/backup">← Görevler</Link> · <HelpLink id="backup-job-types" label="Görev türleri ne yapar?" /></p>
      <Section title={isNew ? "Görev ayarları" : "Ayarlar"}>
        <JobForm initial={initial} isNew={isNew} targets={r.data.targets} otherJobs={r.data.jobs.map((j) => ({ id: j.id, name: j.name, type: j.type }))} roots={r.data.allowedRoots} />
      </Section>
      {!isNew && (
        <>
          <Section title="Şimdi çalıştır / günlük">
            <div className="flex flex-col gap-4">
              <RunNow job={initial.id} />
              <LogBox job={initial.id} />
            </div>
          </Section>
          <Section title="Bu görevin geçmişi"><HistoryBox job={initial.id} /></Section>
          <Section title="Tehlikeli alan" sub="Görevi silmek takvimden kaldırır. Hedefteki mevcut arşivler silinmez (hedefler append-only).">
            <DeleteJob id={initial.id} />
          </Section>
        </>
      )}
    </>
  )
}
