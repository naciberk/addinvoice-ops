import { agentCall } from "@/lib/agent-client"
import { requireRole } from "@/lib/auth"
import type { CronOverview, MigratePlan } from "@/lib/cron-types"
import { HelpLink } from "@/components/panel/help-link"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"
import { MigratePanel } from "@/components/panel/cron/migrate-panel"
import { SchedulerToggle } from "@/components/panel/cron/buttons"

export const metadata = { title: "Taşıma ve zamanlayıcı" }
export const dynamic = "force-dynamic"

export default async function MigratePage() {
  const { user } = await requireRole("admin")
  const actor = { email: user.email, role: user.role }
  const [p, o] = await Promise.all([agentCall<MigratePlan>("cron_migrate_plan", {}, actor), agentCall<CronOverview>("cron_overview", {}, actor)])
  if (!p.ok) return (<><PageTitle title="Taşıma ve zamanlayıcı" /><ErrorNote msg={p.error} /></>)
  return (
    <>
      <PageTitle title="Taşıma ve zamanlayıcı" sub="Eski crontab'daki worker satırlarını bu sayfadaki görevlere aktarır; eski satırlar yedeklenip kaldırılır, yerine tek bir dakikalık zamanlayıcı satırı kurulur. Her adım geri alınabilir." />
      <p className="text-sm"><HelpLink id="cron-migrate" label="Taşıma ne yapar, ne yapmaz?" /></p>
      <Section title="Zamanlayıcı" sub="Açıkken bu sayfadaki görevler zamanı gelince çalışır. Kapalıyken HİÇBİR yönetilen görev çalışmaz (eski crontab satırları ayrı çalışmaya devam eder).">
        <div className="flex flex-col gap-2 text-sm">
          <div>Durum: <b>{o.ok ? (o.data.enabled ? "açık" : "kapalı") : "?"}</b>{o.ok && o.data.tickInstalled ? " · tick satırı kurulu (/etc/cron.d/addinvoice-cron-tick)" : " · tick satırı kurulu değil"}</div>
          {o.ok && <SchedulerToggle enabled={o.data.enabled} />}
        </div>
      </Section>
      <Section title="Eski crontab'dan taşıma" sub="Önce plana bak. Yalnız tanınan worker çağrıları (curl … /api/internal/…) taşınır; başka her satır olduğu gibi kalır.">
        <MigratePanel plan={p.data} />
      </Section>
    </>
  )
}
