import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { query, safe } from "@/lib/db"
import { bytes, dt } from "@/lib/format"
import { can } from "@/lib/roles"
import { Empty, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"
import { JobsBox } from "@/components/panel/jobs"
import { BackupButtons } from "@/components/panel/backup-buttons"
import { RestorePointForm } from "@/components/panel/restore-point-form"
import { HelpLink } from "@/components/panel/help-link"
import { DrillButton } from "@/components/panel/drill-button"

export const metadata = { title: "Veritabanı yedekleri (PITR)" }

type B = {
  label: string
  type: string
  timestamp: { start: number; stop: number }
  info: { size: number; delta: number; repository: { size: number; delta: number } }
  archive: { start: string; stop: string }
  reference?: string[]
}
type Info = { name: string; backup: B[]; archive: { min: string; max: string }[]; status: { code: number; message: string } }[]

export const dynamic = "force-dynamic"

export default async function BackupsPage() {
  const { user } = await requireSession()
  const actor = { email: user.email, role: user.role }
  const operator = can(user.role, "operator")
  const [info, arch] = await Promise.all([
    agentCall<Info>("backup_info", {}, actor, 60_000),
    safe(() => query<{ archived_count: string; failed_count: string; last_archived_wal: string; last_archived_time: string; last_failed_wal: string | null; last_failed_time: string | null }>("select archived_count::text, failed_count::text, last_archived_wal, last_archived_time::text, last_failed_wal, last_failed_time::text from pg_stat_archiver")),
  ])
  const stanza = info.ok ? info.data?.[0] : null
  const backups = (stanza?.backup ?? []).slice().reverse()

  return (
    <>
      <PageTitle title="Veritabanı yedekleri (pgBackRest / PITR)" sub="Bu sunucudaki yerel veritabanı yedeği: sürekli WAL arşivi + haftalık tam / günlük fark yedek. Herhangi bir ana geri dönülebilir (PITR). Sunucu DIŞI şifreli kopyalar ve dosya/ayar yedekleri için Görevler sekmesine, seçici geri yükleme için Geri yükleme sekmesine bak." />

      {operator && (
        <Section title="İşlemler" sub="Yedek işleri arka planda çalışır; ilerlemeyi aşağıdaki 'İşler' kutusundan izle. Aynı anda tek iş çalışır.">
          <div className="flex flex-col gap-4">
            <BackupButtons />
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <HelpLink id="backup-diff" label="Fark yedek ne?" /><HelpLink id="backup-incr" label="Artımlı ne?" /><HelpLink id="backup-full" label="Tam yedek ne?" />
            </div>
            <div>
              <div className="text-sm font-medium mb-1">İsimli restore noktası</div>
              <p className="text-xs text-muted-foreground mb-2">Riskli bir işlemden (toplu güncelleme, migrasyon) hemen önce oluştur: gerekirse tam bu ana geri dönülebilir (<code>--type=name --target=ad</code>).</p>
              <RestorePointForm />
              <div className="mt-1"><HelpLink id="restore-point" label="Restore noktası ne işe yarar?" /></div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Geri yükleme provası</div>
              <p className="text-xs text-muted-foreground mb-2">Son yedeği geçici bir kopyaya açıp sayar ve siler — yedeklerin gerçekten geri yüklenebildiğini kanıtlar. Canlıya dokunmaz.</p>
              <DrillButton />
              <div className="mt-1"><HelpLink id="restore-drill" label="Prova ne yapar? Riski var mı?" /></div>
            </div>
          </div>
        </Section>
      )}

      <Section title="İşler" sub="Son çalıştırılan arka plan işleri (ajan yeniden başlayınca sıfırlanır).">
        <JobsBox />
      </Section>

      <Section title="Yedek listesi" sub={stanza ? `Stanza: ${stanza.name} · WAL aralığı: ${stanza.archive?.[0]?.min ?? "?"} → ${stanza.archive?.[0]?.max ?? "?"}` : undefined}>
        {!info.ok ? <ErrorNote msg={info.error} /> : !backups.length ? <Empty>Henüz yedek yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Etiket</th><th className={th}>Tür</th><th className={th}>Bitiş</th><th className={th}>Süre</th><th className={th}>DB boyutu</th><th className={th}>Depoda</th><th className={th}>WAL</th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.label} className="border-t">
                  <td className={td + " font-mono text-xs"}>{b.label}</td>
                  <td className={td}>{b.type}</td>
                  <td className={td}>{dt(b.timestamp.stop * 1000)}</td>
                  <td className={td}>{Math.round(b.timestamp.stop - b.timestamp.start)} sn</td>
                  <td className={td}>{bytes(b.info.size)}</td>
                  <td className={td}>{bytes(b.info.repository.delta)}</td>
                  <td className={td + " font-mono text-xs"}>{b.archive?.start?.slice(-14)}…{b.archive?.stop?.slice(-8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="WAL arşivleme" right={<HelpLink id="wal-archive" />}>
        {arch.error ? <ErrorNote msg={arch.error} /> : (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">Arşivlenen</dt><dd>{arch.data![0].archived_count}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Hatalı</dt><dd>{arch.data![0].failed_count}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Son arşiv</dt><dd>{dt(arch.data![0].last_archived_time)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Son hata</dt><dd>{arch.data![0].last_failed_time ? dt(arch.data![0].last_failed_time) : "—"}</dd></div>
          </dl>
        )}
      </Section>

      <Section title="Geri yükleme" sub="Üretim geri yüklemesi bu arayüzden BİLEREK yapılamaz (faz 4).">
        <p className="text-sm text-muted-foreground">
          Bilerek yalnız SSH'den: bir yanlışlık tüm veritabanını eskiye döndürebilir. <b>Rehber → Komutlar</b> bölümünde kopyalanabilir adımlar var (en son duruma / belirli ana / isimli noktaya). Tek bir şirketi geri almak için <b>Şirketler</b> sayfasından şifreli dışa aktarma al. <a className="underline" href="/help#komutlar">Komutlara git</a>
        </p>
      </Section>
    </>
  )
}
