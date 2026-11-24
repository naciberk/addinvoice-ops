import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { can } from "@/lib/roles"
import { HelpLink } from "@/components/panel/help-link"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"
import { NotifyForm } from "@/components/panel/backup/notify-form"
import type { Config, NotifySettings } from "@/lib/backup-types"

export const metadata = { title: "Yedek bildirimleri" }
export const dynamic = "force-dynamic"

export default async function NotificationsPage() {
  const { user } = await requireSession()
  const admin = can(user.role, "admin")
  const actor = { email: user.email, role: user.role }
  const [n, c] = await Promise.all([agentCall<NotifySettings>("backup_notify_get", {}, actor), agentCall<Config>("backup_config_get", {}, actor)])
  return (
    <>
      <PageTitle title="Yedek bildirimleri" sub="Yedekler başarısız olunca veya düzenli özet olarak e-posta al. E-postalar bağımsız izleyiciden gider: ops uygulaması çökse de çalışır." />
      <p className="text-sm"><HelpLink id="backup-notify" label="Bildirim türleri ve önerilen ayarlar" /></p>
      <Section title="Ayarlar">
        {!n.ok ? <ErrorNote msg={n.error} /> : !c.ok ? <ErrorNote msg={c.error} /> : <NotifyForm initial={n.data} targets={c.data.targets.map((t) => ({ id: t.id, name: t.name }))} canEdit={admin} />}
      </Section>
    </>
  )
}
