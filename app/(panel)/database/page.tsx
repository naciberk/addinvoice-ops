import { requireSession } from "@/lib/auth"
import { query, safe } from "@/lib/db"
import { bytes, num } from "@/lib/format"
import { can } from "@/lib/roles"
import { Empty, ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"
import { JobsBox } from "@/components/panel/jobs"
import { TableActions } from "@/components/panel/table-actions"
import { HelpLink } from "@/components/panel/help-link"

export const metadata = { title: "Veritabanı" }
export const dynamic = "force-dynamic"

export default async function DatabasePage() {
  const { user } = await requireSession()
  const operator = can(user.role, "operator")
  const admin = can(user.role, "admin")

  const [tables, bloat, slow, activity, unused, cand, parts] = await Promise.all([
    safe(() => query<{ t: string; total: string; heap: string; idx: string; live: string; dead: string; vac: string | null; avac: string | null; seq: string; idxs: string }>(`
      select relname t, pg_total_relation_size(relid)::text total, pg_relation_size(relid)::text heap,
        pg_indexes_size(relid)::text idx, n_live_tup::text live, n_dead_tup::text dead,
        to_char(last_vacuum,'MM-DD HH24:MI') vac, to_char(last_autovacuum,'MM-DD HH24:MI') avac,
        coalesce(seq_scan,0)::text seq, coalesce(idx_scan,0)::text idxs
      from pg_stat_user_tables s
      where not exists (select 1 from pg_inherits i where i.inhrelid = s.relid)
      order by pg_total_relation_size(relid) desc limit 25`)),
    safe(() => query<{ table_name: string; total_bytes: string; dead_tuple_pct: string; free_pct: string }>("select * from ops.bloat(25)")),
    safe(() => query<{ query: string; calls: string; total_ms: string; mean_ms: string; max_ms: string }>("select query, calls::text, total_ms::text, mean_ms::text, max_ms::text from ops.slow_queries(12)")),
    safe(() => query<{ pid: number; usename: string; state: string; wait_event_type: string | null; running_secs: string; blocked_by: number[]; query: string }>("select * from ops.activity()")),
    safe(() => query<{ table_name: string; index_name: string; index_bytes: string }>("select table_name, index_name, index_bytes::text from ops.unused_indexes() where index_bytes > 262144")),
    safe(() => query<{ table_name: string; total_bytes: string; est_rows: string; n_tup_ins: string; n_tup_upd: string; n_tup_del: string; partitioned: boolean }>("select table_name, total_bytes::text, est_rows::text, n_tup_ins::text, n_tup_upd::text, n_tup_del::text, partitioned from ops.partition_candidates() limit 12")),
    safe(() => query<{ parent: string; partition: string; bound: string; total_bytes: string; est_rows: string }>("select parent, partition, bound, total_bytes::text, est_rows::text from ops.partitions()")),
  ])

  const blocked = activity.data?.filter((a) => a.blocked_by.length) ?? []
  const bloatMap = new Map(bloat.data?.map((b) => [b.table_name, b]) ?? [])

  return (
    <>
      <PageTitle title="Veritabanı" sub="Boyut, şişme, yavaş sorgular, bağlantılar, kilitler, kullanılmayan indeksler, bölümleme. İşlemler tablo bazında." />

      {operator && (
        <Section title="İşler" sub="Bakım işleri arka planda çalışır; aynı anda tek iş.">
          <JobsBox />
        </Section>
      )}

      <Section title="Tablolar" right={<div className="flex flex-col items-end gap-1"><HelpLink id="table-columns" label="Sütunlar ne demek?" /><HelpLink id="analyze" label="ANALYZE ne?" /><HelpLink id="vacuum" label="VACUUM ne?" /><HelpLink id="reindex" label="REINDEX ne?" /></div>} sub="En büyük 25 (bölümlenmiş tablolar toplam). Ölü satır % yüksek veya boş alan % yüksekse VACUUM düşün; REINDEX yalnız indeks şişmesi için.">
        {tables.error ? <ErrorNote msg={tables.error} /> : (
          <table className="w-full">
            <thead><tr><th className={th}>Tablo</th><th className={th}>Toplam</th><th className={th}>Veri</th><th className={th}>İndeks</th><th className={th}>Satır</th><th className={th}>Ölü %</th><th className={th}>Boş alan %</th><th className={th}>Son vacuum</th>{operator && <th className={th}>İşlem</th>}</tr></thead>
            <tbody>
              {tables.data!.map((t) => {
                const dead = Number(t.live) + Number(t.dead) > 0 ? (100 * Number(t.dead)) / (Number(t.live) + Number(t.dead)) : 0
                const b = bloatMap.get(t.t)
                return (
                  <tr key={t.t} className="border-t">
                    <td className={td + " font-mono text-xs"}>{t.t}</td>
                    <td className={td}>{bytes(t.total)}</td>
                    <td className={td}>{bytes(t.heap)}</td>
                    <td className={td}>{bytes(t.idx)}</td>
                    <td className={td}>{num(t.live)}</td>
                    <td className={td + (dead > 20 ? " text-red-600 font-medium" : dead > 5 ? " text-amber-600" : "")}>{dead.toFixed(1)}</td>
                    <td className={td + (b && Number(b.free_pct) > 30 ? " text-amber-600" : "")}>{b ? b.free_pct : "—"}</td>
                    <td className={td}>{t.avac ?? t.vac ?? "—"}</td>
                    {operator && <td className={td}><TableActions table={t.t} canReindex={admin} /></td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Bağlantılar ve kilitler" right={<HelpLink id="activity-locks" />} sub={activity.data ? `${activity.data.length} istemci bağlantısı · ${blocked.length} kilit bekleyen` : undefined}>
        {activity.error ? <ErrorNote msg={activity.error} /> : (
          <table className="w-full">
            <thead><tr><th className={th}>PID</th><th className={th}>Kullanıcı</th><th className={th}>Durum</th><th className={th}>Bekleme</th><th className={th}>Süre (sn)</th><th className={th}>Engelleyen</th><th className={th}>Sorgu</th></tr></thead>
            <tbody>
              {activity.data!.filter((a) => a.state !== "idle" || a.blocked_by.length).slice(0, 25).map((a) => (
                <tr key={a.pid} className={"border-t" + (a.blocked_by.length ? " bg-red-50" : "")}>
                  <td className={td}>{a.pid}</td><td className={td}>{a.usename}</td><td className={td}>{a.state}</td>
                  <td className={td}>{a.wait_event_type ?? "—"}</td><td className={td}>{a.running_secs}</td>
                  <td className={td}>{a.blocked_by.length ? a.blocked_by.join(", ") : "—"}</td>
                  <td className={td + " font-mono text-xs max-w-md break-all"}>{a.query}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {activity.data && !activity.data.some((a) => a.state !== "idle") && <Empty>Şu an çalışan sorgu yok (bağlantıların hepsi boşta).</Empty>}
      </Section>

      <Section title="En yavaş sorgular" right={<HelpLink id="slow-queries" />} sub="pg_stat_statements, toplam süreye göre. Değerler normalize edilmiştir ($1…).">
        {slow.error ? <ErrorNote msg={slow.error} /> : (
          <table className="w-full">
            <thead><tr><th className={th}>Çağrı</th><th className={th}>Toplam (ms)</th><th className={th}>Ort (ms)</th><th className={th}>Maks (ms)</th><th className={th}>Sorgu</th></tr></thead>
            <tbody>
              {slow.data!.map((q, i) => (
                <tr key={i} className="border-t">
                  <td className={td}>{num(q.calls)}</td><td className={td}>{num(q.total_ms)}</td><td className={td}>{q.mean_ms}</td><td className={td}>{num(q.max_ms)}</td>
                  <td className={td + " font-mono text-xs max-w-xl break-all"}>{q.query}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Kullanılmayan indeksler" right={<HelpLink id="unused-indexes" />} sub="Hiç taranmamış, benzersiz olmayan indeksler. Silmeden önce istatistik süresi (son sıfırlama) yeterli uzunlukta mı kontrol et; bu ekran silme yapmaz.">
        {unused.error ? <ErrorNote msg={unused.error} /> : !unused.data!.length ? <Empty>Anlamlı boyutta kullanılmayan indeks yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Tablo</th><th className={th}>İndeks</th><th className={th}>Boyut</th></tr></thead>
            <tbody>{unused.data!.map((u) => <tr key={u.index_name} className="border-t"><td className={td}>{u.table_name}</td><td className={td + " font-mono text-xs"}>{u.index_name}</td><td className={td}>{bytes(u.index_bytes)}</td></tr>)}</tbody>
          </table>
        )}
      </Section>

      <Section title="Bölümleme" right={<HelpLink id="partitions" />} sub="Büyük, ağırlıklı yalnız-ekleme tablolar aylık bölümlenebilir (eski bölüm = hızlı arşiv/silme). Eşik: yaklaşık 5–10 milyon satır / birkaç GB.">
        {cand.error ? <ErrorNote msg={cand.error} /> : (
          <table className="w-full mb-4">
            <thead><tr><th className={th}>Tablo</th><th className={th}>Boyut</th><th className={th}>Satır (tah.)</th><th className={th}>Ekleme</th><th className={th}>Güncelleme</th><th className={th}>Silme</th><th className={th}>Durum</th></tr></thead>
            <tbody>
              {cand.data!.map((c) => (
                <tr key={c.table_name} className="border-t">
                  <td className={td + " font-mono text-xs"}>{c.table_name}</td><td className={td}>{bytes(c.total_bytes)}</td><td className={td}>{num(c.est_rows)}</td>
                  <td className={td}>{num(c.n_tup_ins)}</td><td className={td}>{num(c.n_tup_upd)}</td><td className={td}>{num(c.n_tup_del)}</td>
                  <td className={td}>{c.partitioned ? "bölümlenmiş ✔" : Number(c.est_rows) > 5_000_000 ? "aday" : "gerek yok"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {parts.error ? <ErrorNote msg={parts.error} /> : parts.data && parts.data.length > 0 && (
          <table className="w-full">
            <thead><tr><th className={th}>Ana tablo</th><th className={th}>Bölüm</th><th className={th}>Aralık</th><th className={th}>Boyut</th><th className={th}>Satır</th></tr></thead>
            <tbody>{parts.data.map((p) => <tr key={p.partition} className="border-t"><td className={td}>{p.parent}</td><td className={td + " font-mono text-xs"}>{p.partition}</td><td className={td + " text-xs"}>{p.bound}</td><td className={td}>{bytes(p.total_bytes)}</td><td className={td}>{num(p.est_rows)}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </>
  )
}
