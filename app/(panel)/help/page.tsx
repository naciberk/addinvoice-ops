import { Card, CardContent } from "@/components/ui/card"
import { CopyCode } from "@/components/panel/copy-code"
import { PageTitle } from "@/components/panel/ui"
import { requireSession } from "@/lib/auth"
import { COMMANDS, GLOSSARY, HELP, HELP_GROUPS } from "@/lib/help"
import { ROLE_LABEL } from "@/lib/roles"

export const metadata = { title: "Rehber" }
export const dynamic = "force-dynamic"

export default async function HelpPage() {
  await requireSession()
  return (
    <>
      <PageTitle title="Rehber" sub="Hangi düğme ne işe yarar, tıklarsan ne olur, nelere dikkat etmelisin — ve sunucuda çalıştıracağın komutlar. Sayfalardaki 'Bu ne?' bağlantıları buraya gelir." />

      <nav className="flex flex-wrap gap-2 text-sm">
        {HELP_GROUPS.map((g) => (
          <a key={g.id} href={`#g-${g.id}`} className="rounded-full border px-3 py-1 hover:bg-muted">{g.title}</a>
        ))}
        <a href="#komutlar" className="rounded-full border px-3 py-1 hover:bg-muted font-medium">Komutlar</a>
        <a href="#sozluk" className="rounded-full border px-3 py-1 hover:bg-muted">Sözlük</a>
      </nav>

      <Card>
        <CardContent className="p-4 text-sm flex flex-col gap-2">
          <b>Altın kurallar</b>
          <ul className="list-disc ml-5 flex flex-col gap-1 text-muted-foreground">
            <li>Emin değilsen önce <b>okuyan</b> sayfalara bak (Genel bakış, Veritabanı); değiştiren düğmeler her zaman onay ister.</li>
            <li>Riskli bir işlemden (toplu güncelleme, migrasyon, ayar değişikliği) hemen önce <a className="underline" href="#restore-point">restore noktası</a> koy.</li>
            <li>Yapılandırma değişikliği sonrası Genel bakış'ı ve <a className="underline" href="/tuning">Ayarlar</a> sayfasını kontrol et.</li>
            <li>Her işlem — kim, ne zaman, hangi IP — <a className="underline" href="/audit">denetim kaydına</a> yazılır (yönetici görür).</li>
            <li>Sunucuyu <b>ele geçirmeye karşı</b> tasarlandı: web uygulaması root değil; root işlerini yalnız izin listesindeki eylemlerle ayrı bir ajan yapar.</li>
          </ul>
        </CardContent>
      </Card>

      {HELP_GROUPS.map((g) => (
        <section key={g.id} id={`g-${g.id}`} className="flex flex-col gap-4 scroll-mt-4">
          <h2 className="text-xl font-semibold border-b pb-2">{g.title}</h2>
          {HELP.filter((h) => h.group === g.id).map((h) => (
            <Card key={h.id} id={h.id} className="scroll-mt-4 target:ring-2 target:ring-primary">
              <CardContent className="p-5 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{h.title}</h3>
                  <span className="text-xs rounded-full bg-muted px-2 py-0.5">{ROLE_LABEL[h.role]}{h.role !== "admin" ? " ve üstü" : ""}</span>
                </div>
                <p className="text-sm">{h.what}</p>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Tıklarsan / açarsan ne olur?</div>
                  <ul className="list-disc ml-5 text-sm flex flex-col gap-1">{h.happens.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
                {h.caution.length > 0 && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-3">
                    <div className="text-xs font-medium text-amber-900 mb-1">Dikkat</div>
                    <ul className="list-disc ml-5 text-sm text-amber-950 flex flex-col gap-1">{h.caution.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                <p className="text-xs text-muted-foreground"><b>Geri alma:</b> {h.undo}</p>
              </CardContent>
            </Card>
          ))}
        </section>
      ))}

      <section id="komutlar" className="flex flex-col gap-4 scroll-mt-4">
        <h2 className="text-xl font-semibold border-b pb-2">Komutlar</h2>
        <p className="text-sm text-muted-foreground">Sunucuya SSH ile bağlanıp (root) çalıştırılır. Kopyala düğmesi sağ üst köşede. “Nerede” satırı komutun çalıştırılacağı klasördür.</p>
        {COMMANDS.map((g) => (
          <div key={g.group} className="flex flex-col gap-3">
            <h3 className="font-medium">{g.group}</h3>
            {g.items.map((c) => (
              <Card key={c.title}>
                <CardContent className="p-4 flex flex-col gap-2">
                  <div className="text-sm font-medium">{c.title}</div>
                  <div className="text-xs text-muted-foreground">Nerede: <code>{c.where}</code></div>
                  <CopyCode code={c.cmd} />
                  {c.note && <p className="text-xs text-muted-foreground">{c.note}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        ))}
        <Card>
          <CardContent className="p-4 text-sm">
            <b>Dosyaların yeri</b>
            <ul className="list-disc ml-5 mt-1 text-muted-foreground flex flex-col gap-0.5 text-xs">
              <li><code>/var/www/addinvoice-ops</code> — bu konsolun kodu (root'a ait, salt okunur); <code>agent/agent.mjs</code> root ajanı.</li>
              <li><code>/etc/addinvoice-ops/env</code> — gizli ayarlar (DB parolası, oturum sırrı). Kimseyle paylaşma.</li>
              <li><code>/var/lib/addinvoice-ops/data</code> — kullanıcılar, davetler, oturumlar, denetim kaydı. <code>…/downloads</code> — şifreli dışa aktarmalar (24 sa).</li>
              <li><code>/var/log/addinvoice-ops/agent-audit.jsonl</code> — ajanın root'a ait denetim kaydı.</li>
              <li><code>/var/backups/addinvoice-ops-config/&lt;anahtar&gt;/</code> — yapılandırma yedekleri.</li>
              <li><code>/var/lib/pgbackrest</code> — veritabanı yedek deposu (şimdilik AYNI diskte). <code>/var/log/addinvoice-db-health</code> — haftalık sağlık raporu.</li>
              <li>Dokümanlar: <code>/var/www/addinvoice/docs/ops-konsol.md</code>, <code>docs/ops-postgres.md</code>.</li>
            </ul>
          </CardContent>
        </Card>
      </section>

      <section id="sozluk" className="flex flex-col gap-3 scroll-mt-4">
        <h2 className="text-xl font-semibold border-b pb-2">Sözlük</h2>
        <dl className="grid md:grid-cols-2 gap-3">
          {GLOSSARY.map((g) => (
            <Card key={g.term}><CardContent className="p-4"><dt className="font-medium text-sm">{g.term}</dt><dd className="text-sm text-muted-foreground mt-1">{g.def}</dd></CardContent></Card>
          ))}
        </dl>
      </section>
    </>
  )
}
