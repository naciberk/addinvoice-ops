import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { dt } from "@/lib/format"
import { describeSchedule } from "@/lib/backup-types"
import type { SystemCron } from "@/lib/cron-types"
import { HelpLink } from "@/components/panel/help-link"
import { Empty, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"

export const metadata = { title: "Sistem cron'ları" }
export const dynamic = "force-dynamic"

export default async function SystemCronPage() {
  const { user } = await requireSession()
  const r = await agentCall<SystemCron[]>("cron_system", {}, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Sistem cron'ları" /><ErrorNote msg={r.error} /></>)
  const rows = r.data.filter((c) => !c.ours)
  const bySource = new Map<string, SystemCron[]>()
  for (const c of rows) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c])
  return (
    <>
      <PageTitle title="Sistem cron'ları (salt-okunur)" sub="Sunucudaki diğer zamanlanmış işler: /etc/cron.d dosyaları ve root crontab'da kalan satırlar (yedek, pgBackRest, sertifika yenileme, izleyici…). Burada yalnız gösterilir ve çakışma haritasına katılır; düzenleme yok." />
      <p className="text-sm"><HelpLink id="cron-system" label="Bu liste nereden geliyor?" /></p>
      {!rows.length ? <Empty>Satır bulunamadı.</Empty> : [...bySource.entries()].map(([src, list]) => (
        <Section key={src} title={src} sub={src.startsWith("cron.d/") ? `/etc/${src}` : "root kullanıcısının crontab'ı (crontab -l)"}>
          <table className="w-full">
            <thead><tr><th className={th}>İş</th><th className={th}>Takvim</th><th className={th}>Sıradaki</th><th className={th}>Kullanıcı</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className={td}>
                    <div className="font-medium">{c.label}</div>
                    {c.info && <div className="text-xs text-muted-foreground max-w-xl">{c.info}</div>}
                    <div className="text-[11px] font-mono text-muted-foreground break-all mt-1">{c.command}</div>
                  </td>
                  <td className={td + " text-xs"}>{c.schedule ? describeSchedule(c.schedule) : c.unparsed ?? "—"}<div className="font-mono text-muted-foreground">{c.expr}</div></td>
                  <td className={td + " text-xs whitespace-nowrap"}>{c.next[0] ? dt(c.next[0]) : "—"}</td>
                  <td className={td + " text-xs"}>{c.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </>
  )
}
