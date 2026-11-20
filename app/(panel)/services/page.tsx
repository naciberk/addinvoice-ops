import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { bytes } from "@/lib/format"
import { can } from "@/lib/roles"
import { Dot, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"
import { LogViewer } from "@/components/panel/log-viewer"
import { ServiceButtons } from "@/components/panel/service-buttons"
import { HelpLink } from "@/components/panel/help-link"

export const metadata = { title: "Servisler" }
export const dynamic = "force-dynamic"

type Svc = { unit: string; active: string; sub: string; since: string; memory: number | null; restarts: number }

export default async function ServicesPage() {
  const { user } = await requireSession()
  const actor = { email: user.email, role: user.role }
  const operator = can(user.role, "operator")
  const [svc, src] = await Promise.all([agentCall<Svc[]>("services", {}, actor), operator ? agentCall<{ key: string; label: string }[]>("log_sources", {}, actor) : Promise.resolve(null)])

  return (
    <>
      <PageTitle title={operator ? "Servisler ve günlükler" : "Servisler"} sub="Durum + yeniden yükleme/başlatma. Yapılandırma değişikliği için Yapılandırma sayfası (yönetici)." />
      <Section title="Servisler" right={<HelpLink id="services" />}>
        {!svc.ok ? <ErrorNote msg={svc.error} /> : (
          <table className="w-full">
            <thead><tr><th className={th}>Servis</th><th className={th}>Durum</th><th className={th}>Alt durum</th><th className={th}>Başlangıç</th><th className={th}>Bellek</th><th className={th}>Yeniden başl.</th></tr></thead>
            <tbody>
              {svc.data.map((s) => (
                <tr key={s.unit} className="border-t">
                  <td className={td + " font-mono text-xs"}>{s.unit}</td>
                  <td className={td}><Dot tone={s.active === "active" ? "ok" : "bad"} />{s.active}</td>
                  <td className={td}>{s.sub}</td>
                  <td className={td + " text-xs"}>{s.since || "—"}</td>
                  <td className={td}>{s.memory ? bytes(s.memory) : "—"}</td>
                  <td className={td}>{s.restarts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {operator && (
        <Section title="Yeniden yükle / yeniden başlat" sub="Reload kesintisizdir; Restart kısa kesinti yapar (yalnız yönetici). PostgreSQL restart'ında adı yazman istenir.">
          <div className="flex flex-col gap-3">
            <ServiceButtons canRestart={can(user.role, "admin")} />
            <div className="flex gap-4"><HelpLink id="service-reload" label="Reload ne yapar?" /><HelpLink id="service-restart" label="Restart ne yapar / ne zaman?" /></div>
          </div>
        </Section>
      )}
      {operator && (
        <Section title="Günlükler" right={<HelpLink id="logs" />}>
          {src && src.ok ? <LogViewer sources={src.data} /> : <ErrorNote msg={src && !src.ok ? src.error : "?"} />}
        </Section>
      )}
    </>
  )
}
