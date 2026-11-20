import { agentCall } from "@/lib/agent-client"
import { readAudit } from "@/lib/audit"
import { requireRole } from "@/lib/auth"
import { dt } from "@/lib/format"
import { HelpLink } from "@/components/panel/help-link"
import { Dot, Empty, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"

export const metadata = { title: "Denetim kaydı" }
export const dynamic = "force-dynamic"

type AgentEntry = { ts: string; kind: string; action?: string; actor?: string; role?: string; label?: string; state?: string; reason?: string; params?: unknown }

export default async function AuditPage() {
  const { user } = await requireRole("admin")
  const { entries, chainOk, brokenAt } = readAudit()
  const web = entries.slice(-300).reverse()
  const agent = await agentCall<AgentEntry[]>("agent_audit", { lines: 200 }, { email: user.email, role: user.role })

  return (
    <>
      <PageTitle title="Denetim kaydı" sub="Kim, ne zaman, neyi yaptı. Web kaydı yalnız-ekleme + hash zincirli; ajan kaydı root'a ait ayrı bir dosyada (web uygulaması değiştiremez)." />
      <HelpLink id="audit" label="Hash zinciri ne demek?" />
      <div className={"rounded-md border p-3 text-sm " + (chainOk ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900")}>
        {chainOk ? `Hash zinciri doğrulandı (${entries.length} kayıt).` : `⚠ Hash zinciri #${brokenAt} kaydında BOZUK: kayıt değiştirilmiş/silinmiş olabilir. Hemen incele.`}
      </div>

      <Section title="Web konsolu kayıtları" sub="Son 300">
        {!web.length ? <Empty>Kayıt yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>#</th><th className={th}>Zaman</th><th className={th}>Kişi</th><th className={th}>Olay</th><th className={th}>Hedef / ayrıntı</th><th className={th}>IP</th></tr></thead>
            <tbody>
              {web.map((e) => (
                <tr key={e.seq} className="border-t">
                  <td className={td}>{e.seq}</td><td className={td + " whitespace-nowrap text-xs"}>{dt(e.ts)}</td>
                  <td className={td}>{e.actor}<div className="text-xs text-muted-foreground">{e.role}</div></td>
                  <td className={td}><Dot tone={e.ok ? "ok" : "bad"} />{e.action}</td>
                  <td className={td + " text-xs"}>{[e.target, e.detail].filter(Boolean).join(" — ") || "—"}</td>
                  <td className={td + " text-xs"}>{e.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Root ajan kayıtları" sub="Ajanın çalıştırdığı / reddettiği her istek (son 200)">
        {!agent.ok ? <ErrorNote msg={agent.error} /> : !agent.data.length ? <Empty>Kayıt yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Zaman</th><th className={th}>Tür</th><th className={th}>Eylem</th><th className={th}>Kişi</th><th className={th}>Ayrıntı</th></tr></thead>
            <tbody>
              {agent.data.map((e, i) => (
                <tr key={i} className="border-t">
                  <td className={td + " whitespace-nowrap text-xs"}>{dt(e.ts)}</td><td className={td}>{e.kind}</td><td className={td}>{e.action ?? "—"}</td><td className={td}>{e.actor ?? "—"}</td>
                  <td className={td + " text-xs font-mono break-all"}>{e.reason ?? e.state ?? (e.params ? JSON.stringify(e.params) : e.label ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  )
}
