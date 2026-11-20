import { agentCall } from "@/lib/agent-client"
import { requireRole } from "@/lib/auth"
import { ConfigEditor, type CfgFile } from "@/components/panel/config-editor"
import { HelpLink } from "@/components/panel/help-link"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"

export const metadata = { title: "Yapılandırma" }
export const dynamic = "force-dynamic"

export default async function ConfigPage() {
  const { user } = await requireRole("admin")
  const r = await agentCall<CfgFile[]>("config_list", {}, { email: user.email, role: user.role })
  return (
    <>
      <PageTitle title="Yapılandırma" sub="nginx, pgBouncer ve PostgreSQL ayar dosyalarını güvenli düzenle: yedek → doğrulama → uygulama → sağlık kontrolü → bozulursa otomatik geri alma." />
      <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-950 p-4 text-sm flex flex-col gap-1">
        <b>Önce oku</b>
        <ul className="list-disc ml-5">
          <li>Her uygulama yedeklenir; son 30 yedek saklanır ve buradan geri dönülebilir.</li>
          <li>Bozuk yapılandırma <b>otomatik geri alınır</b>; ama mantıksal hatalar (ör. kendini dışarıda bırakan bir IP kısıtı) doğrulamayı geçebilir — ops sitesinin nginx dosyasında özellikle dikkat.</li>
          <li>PostgreSQL'de <i>restart gerektiren</i> ayarlar uygulandıktan sonra listelenir; devreye girmesi için Servisler → PostgreSQL → Restart gerekir.</li>
        </ul>
        <HelpLink id="config-edit" label="Ayrıntılı açıklama" />
      </div>
      <Section title="Dosyayı düzenle">
        {r.ok ? <ConfigEditor files={r.data} /> : <ErrorNote msg={r.error} />}
      </Section>
    </>
  )
}
