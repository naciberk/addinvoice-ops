import { agentCall } from "@/lib/agent-client"
import { requireRole } from "@/lib/auth"
import type { Config } from "@/lib/backup-types"
import { HelpLink } from "@/components/panel/help-link"
import { ErrorNote, PageTitle, Section } from "@/components/panel/ui"
import { RestoreWizard, WorkspacesBox } from "@/components/panel/backup/restore-wizard"

export const metadata = { title: "Geri yükleme (borg)" }
export const dynamic = "force-dynamic"

export default async function RestorePage() {
  const { user } = await requireRole("admin")
  const r = await agentCall<Config>("backup_config_get", {}, { email: user.email, role: user.role })
  return (
    <>
      <PageTitle title="Geri yükleme" sub="Borg arşivlerinden dosya, klasör, tablo veya şirket seçerek GÜVENLİ KOPYAYA geri yükle. Canlı veriye hiçbir şey yazılmaz." />
      <div className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-950 p-4 text-sm flex flex-col gap-1">
        <b>Bu sihirbaz güvenli çalışır</b>
        <ul className="list-disc ml-5">
          <li>Seçtiklerin ayrı bir çalışma alanına (dosyalar) veya <b>geçici bir veritabanına</b> açılır; canlı dosyalara ve canlı veritabanına dokunulmaz.</li>
          <li>Sonuç <b>şifreli paket</b> olarak iner (parola bir kez gösterilir); geçici veritabanı ve paketler 24 saat sonra silinir.</li>
          <li>Veritabanından tek tablo, bir şirketin satırları veya şirketin tam paketi seçilebilir; satır önizlemesi vardır.</li>
          <li>Canlıya geri uygulama (Aşama 2) henüz yok: indirdiğin veriyi gözden geçirip gerekeni birlikte uygularız.</li>
        </ul>
        <HelpLink id="backup-restore" label="Ayrıntılı açıklama" />
      </div>
      <Section title="Sihirbaz">
        {!r.ok ? <ErrorNote msg={r.error} /> : <RestoreWizard targets={r.data.targets.filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name }))} jobs={r.data.jobs.map((j) => ({ id: j.id, name: j.name, type: j.type }))} />}
      </Section>
      <Section title="Açık çalışma alanları" sub="Geçici veritabanları 24 saat sonra otomatik silinir; istersen şimdi temizle veya yeniden aç.">
        <WorkspacesBox />
      </Section>
    </>
  )
}
