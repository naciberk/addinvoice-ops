import Link from "next/link"
import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import type { DayGridData } from "@/lib/cron-types"
import { HelpLink } from "@/components/panel/help-link"
import { Empty, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"

export const metadata = { title: "Çakışma haritası" }
export const dynamic = "force-dynamic"

const p2 = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const shift = (s: string, days: number) => { const [y, m, d] = s.split("-").map(Number); return ymd(new Date(y, m - 1, d + days)) }
const WD = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]

export default async function GridPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date: q } = await searchParams
  const { user } = await requireSession()
  const date = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : ymd(new Date())
  const r = await agentCall<DayGridData>("cron_grid", { date }, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Çakışma haritası" /><ErrorNote msg={r.error} /></>)
  const g = r.data
  const [y, m, d] = date.split("-").map(Number)
  const wd = WD[new Date(y, m - 1, d).getDay()]
  const busiest = Math.max(1, ...g.cells)
  return (
    <>
      <PageTitle title="Çakışma haritası" sub="Seçilen günde her dakikada hangi görevlerin çalıştığı: yönetilen görevler + sistem cron'ları (yedek, pgBackRest, sertifika…). Aynı dakikaya düşen iki ya da daha fazla görev kırmızı." />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link className="underline" href={`/cron/grid?date=${shift(date, -1)}`}>← önceki gün</Link>
        <b>{date} · {wd}</b>
        <Link className="underline" href={`/cron/grid?date=${shift(date, 1)}`}>sonraki gün →</Link>
        <Link className="underline" href="/cron/grid">bugün</Link>
        <HelpLink id="cron-grid" label="Bu harita nasıl okunur?" />
      </div>
      <Section title="Gün haritası" sub="Satır = saat, sütun = dakika (0-59). Üzerine gelince o dakikadaki görevler görünür. Sık çalışan görevler (günde ≥24 kez) haritaya girmez; aşağıda ayrıca listelenir.">
        <div className="overflow-x-auto">
          <div className="inline-block min-w-[720px]">
            <div className="flex text-[10px] text-muted-foreground ml-8 mb-1">{Array.from({ length: 12 }, (_, i) => <span key={i} style={{ width: `${100 / 12}%` }} className="inline-block min-w-[48px]">:{p2(i * 5)}</span>)}</div>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="flex items-center gap-1 mb-[2px]">
                <span className="w-7 text-[10px] text-muted-foreground tabular-nums text-right">{p2(h)}</span>
                <div className="flex flex-1 gap-[1px]">
                  {Array.from({ length: 60 }, (_, mi) => {
                    const n = g.cells[h * 60 + mi]
                    const names = g.at[h * 60 + mi]
                    const cls = n === 0 ? "bg-gray-100" : n === 1 ? "bg-emerald-400" : "bg-red-500"
                    return <span key={mi} title={n ? `${p2(h)}:${p2(mi)} — ${names.join(", ")}` : `${p2(h)}:${p2(mi)}`} className={`flex-1 h-4 rounded-[1px] ${cls}`} />
                  })}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3 ml-8"><span><span className="inline-block w-3 h-3 bg-gray-100 align-middle mr-1" />boş</span><span><span className="inline-block w-3 h-3 bg-emerald-400 align-middle mr-1" />1 görev</span><span><span className="inline-block w-3 h-3 bg-red-500 align-middle mr-1" />çakışma (≥2){busiest >= 2 ? "" : " — yok"}</span></div>
          </div>
        </div>
      </Section>
      <Section title={`Çakışmalar (${g.collisions.length})`} sub="Aynı dakikada başlayan, sık olmayan görevler. Zararsız olabilir; ama faturalama gibi ağır işler aynı anda çalışmasın istenir. Çözüm: görevlerden birinin dakikasını kaydır.">
        {!g.collisions.length ? <Empty>Bu gün aynı dakikaya düşen görev yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Saat</th><th className={th}>Birlikte çalışanlar</th></tr></thead>
            <tbody>{g.collisions.map((c) => <tr key={c.minute} className="border-t"><td className={td + " tabular-nums whitespace-nowrap font-medium"}>{c.minute}</td><td className={td + " text-sm"}>{c.names.join(" · ")}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
      <Section title={`Sık çalışan görevler (${g.frequent.length})`} sub="Günde en az 24 kez (saatte en az bir) çalıştıkları için her zaman başka işlerle aynı dakikaya düşerler; haritaya girmezler. Bunlar için üst üste binmeyi motor önler (önceki tur sürerken yenisi başlamaz).">
        {!g.frequent.length ? <Empty>Yok.</Empty> : <ul className="text-sm flex flex-wrap gap-x-6 gap-y-1">{g.frequent.map((f) => <li key={f.name + f.kind}><b>{f.name}</b> <span className="text-xs text-muted-foreground">günde {f.perDay} kez · {f.kind === "managed" ? "yönetilen" : "sistem"}</span></li>)}</ul>}
      </Section>
    </>
  )
}
