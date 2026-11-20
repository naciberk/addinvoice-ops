import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { can } from "@/lib/roles"
import { HelpLink } from "@/components/panel/help-link"
import { ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"
import { TargetActions, ArchivesBox } from "@/components/panel/backup/buttons"
import { TargetWizard } from "@/components/panel/backup/target-wizard"
import type { Config } from "@/lib/backup-types"
import Link from "next/link"

export const metadata = { title: "Yedek hedefleri" }
export const dynamic = "force-dynamic"

export default async function TargetsPage() {
  const { user } = await requireSession()
  const admin = can(user.role, "admin")
  const r = await agentCall<Config>("backup_config_get", {}, { email: user.email, role: user.role })
  return (
    <>
      <PageTitle title="Yedek hedefleri" sub="Yedeklerin gittiği yerler: başka Linux sunucu, SSH'lı NAS veya bağlı bir klasör (NAS paylaşımı). Her hedefin ayrı şifreleme parolası vardır." />
      <p className="text-sm"><Link className="underline" href="/backup">← Yedekleme görevleri</Link> · <HelpLink id="backup-targets" label="Hedef türleri ve kurulum adımları" /></p>
      <Section title="Hedefler">
        {!r.ok ? <ErrorNote msg={r.error} /> : (
          <div className="flex flex-col gap-5">
            {r.data.targets.map((t) => (
              <div key={t.id} className="rounded-md border p-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3"><b>{t.name}</b><code className="text-xs">{t.id}</code><span className={"text-xs " + (t.enabled ? "text-emerald-700" : "text-amber-600")}>{t.enabled ? "etkin" : "durdurulmuş"}</span></div>
                <div className="text-xs text-muted-foreground font-mono break-all">{t.type === "ssh" ? `ssh://${t.user}@${t.host}:${t.port}${t.repoPath}` : t.repoPath + (t.mountCheck ? `  (bağlama: ${t.mountCheck})` : "")}</div>
                {t.note && <div className="text-xs">{t.note}</div>}
                <div className="text-xs text-muted-foreground">Kullanan görevler: {r.data.jobs.filter((j) => j.targets.includes(t.id)).map((j) => j.name).join(", ") || "—"}</div>
                {admin ? <TargetActions t={t} /> : null}
              </div>
            ))}
            {!r.data.targets.length && <p className="text-sm text-muted-foreground">Henüz hedef yok.</p>}
          </div>
        )}
      </Section>
      <Section title="Hedefteki arşivler" sub="Seçilen hedefin deposundan son arşivleri okur (parola sunucuda; arayüze gelmez).">
        {r.ok ? <ArchivesBox targets={r.data.targets.filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name }))} /> : null}
      </Section>
      {admin && <Section title="Yeni hedef ekle" sub="Anahtar ve parola otomatik üretilir; hedef tarafta yapılacak komutlar adım adım gösterilir.">
        <TargetWizard />
      </Section>}
    </>
  )
}
