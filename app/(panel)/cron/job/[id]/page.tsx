import Link from "next/link"
import { notFound } from "next/navigation"
import { agentCall } from "@/lib/agent-client"
import { requireRole } from "@/lib/auth"
import type { CronOverview } from "@/lib/cron-types"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"
import { HelpLink } from "@/components/panel/help-link"
import { CronJobForm, type CronFormInitial } from "@/components/panel/cron/job-form"
import { CronHistory, DeleteCron, RunNowCron } from "@/components/panel/cron/buttons"

export const dynamic = "force-dynamic"
export const metadata = { title: "Zamanlanmış görev" }

export default async function CronJobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ target?: string }> }) {
  const { id } = await params
  const { target } = await searchParams
  const { user } = await requireRole("admin")
  const r = await agentCall<CronOverview>("cron_overview", {}, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Zamanlanmış görev" /><ErrorNote msg={r.error} /></>)
  const isNew = id === "new"
  const existing = r.data.jobs.find((j) => j.id === id)
  if (!isNew && !existing) notFound()
  const pre = isNew && target && r.data.workers.some((w) => w.name === target) ? target : ""
  const initial: CronFormInitial = existing
    ? { id: existing.id, name: existing.name, target: existing.target, schedule: existing.schedule.source, enabled: existing.enabled, timeoutSec: existing.timeoutSec, note: existing.note }
    : { id: "", name: pre, target: pre, schedule: { kind: "every", n: 1, unit: "days", hour: 3, minute: 20 }, enabled: true, timeoutSec: 300, note: "" }
  return (
    <>
      <PageTitle title={isNew ? "Yeni zamanlanmış görev" : initial.name} sub={isNew ? "Hangi worker, ne zaman çalışsın — seç ve kaydet." : `Kimlik: ${initial.id} · worker: ${initial.target}`} />
      <p className="text-sm"><Link className="underline" href="/cron">← Görevler</Link> · <HelpLink id="cron-job" label="Görev ayarları ne demek?" /></p>
      <Section title={isNew ? "Görev ayarları" : "Ayarlar"}>
        <CronJobForm initial={initial} isNew={isNew} workers={r.data.workers} />
      </Section>
      {!isNew && (
        <>
          <Section title="Şimdi çalıştır"><RunNowCron id={initial.id} name={initial.name} /></Section>
          <Section title="Bu görevin geçmişi" sub="Son 50 çalışma (en yeni üstte). 30 günden eski kayıtlar silinir."><CronHistory job={initial.id} /></Section>
          <Section title="Tehlikeli alan" sub="Silmek görevi zamanlamadan kaldırır. Worker'ın kendisi ve verileri silinmez."><DeleteCron id={initial.id} /></Section>
        </>
      )}
    </>
  )
}
