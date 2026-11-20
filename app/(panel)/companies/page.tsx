import { requireSession } from "@/lib/auth"
import { query, safe } from "@/lib/db"
import { bytes, num } from "@/lib/format"
import { can } from "@/lib/roles"
import { ErrorNote, PageTitle, Section, td, th } from "@/components/panel/ui"
import { ExportButton } from "@/components/panel/export-button"
import { JobsBox } from "@/components/panel/jobs"
import { HelpLink } from "@/components/panel/help-link"

export const metadata = { title: "Şirketler" }
export const dynamic = "force-dynamic"

type Hit = { company_id: string; company_name: string; slug: string; cvr: string | null; gln: string | null; company_type: string; is_test: boolean; created_at: string }

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { user } = await requireSession()
  const operator = can(user.role, "operator")
  const q = ((await searchParams).q ?? "").trim().slice(0, 100)
  const hits = q.length >= 3 ? await safe(() => query<Hit>("select * from ops.company_lookup($1)", [q])) : null
  const r = await safe(() => query<{ company_id: string; company_name: string; slug: string; total_rows: string; est_bytes: string; top_table: string | null; top_rows: string | null }>("select * from ops.company_sizes()"))
  const total = r.data?.reduce((s, c) => s + Number(c.est_bytes), 0) ?? 0
  const big = r.data?.[0]

  return (
    <>
      <PageTitle title="Şirketler" sub="Şirket başına veri hacmi (tahmini). Büyük bir şirket diğerlerini yavaşlatıyorsa buradan görürsün; dışa aktarma o şirketin tüm verisini şifreli arşive alır." />
      <Section title="Şirket ara" sub="CVR, GLN/EAN, P-nr., SE-nr., şirket adı, slug veya şirket kimliği ile (en az 3 karakter). Bir makam talebinde doğru müşteriyi bulmak içindir; ayrıca P-numarası ve SE-numarası.">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input name="q" defaultValue={q} placeholder="CVR (8 hane), GLN, ad…" className="h-9 w-72 rounded-md border bg-background px-3 text-sm" autoComplete="off" />
          <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">Ara</button>
          {q && <a href="/companies" className="text-xs text-muted-foreground underline">Temizle</a>}
        </form>
        {q && q.length < 3 && <p className="mt-3 text-xs text-muted-foreground">En az 3 karakter girin.</p>}
        {hits && (hits.error ? <div className="mt-3"><ErrorNote msg={hits.error} /></div> : hits.data!.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Sonuç yok.</p>
        ) : (
          <table className="mt-3 w-full">
            <thead><tr><th className={th}>Şirket</th><th className={th}>CVR</th><th className={th}>GLN</th><th className={th}>Tür</th><th className={th}>Kimlik</th>{operator && <th className={th}>İşlem</th>}</tr></thead>
            <tbody>
              {hits.data!.map((c) => (
                <tr key={c.company_id} className="border-t">
                  <td className={td}><div className="font-medium">{c.company_name}{c.is_test ? " · test" : ""}</div><div className="text-xs text-muted-foreground">{c.slug}</div></td>
                  <td className={td + " tabular-nums"}>{c.cvr || "—"}</td>
                  <td className={td + " tabular-nums"}>{c.gln || "—"}</td>
                  <td className={td + " text-xs"}>{c.company_type}</td>
                  <td className={td + " text-xs font-mono"}>{c.company_id}</td>
                  {operator && <td className={td}><ExportButton id={c.company_id} name={c.company_name} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </Section>
      {operator && (
        <Section title="İşler" right={<HelpLink id="company-export" label="Şifreli dışa aktar ne yapar?" />} sub="Dışa aktarma arka planda çalışır; bitince indirme bağlantısı ve parola burada çıkar (parola yalnız bir kez gösterilir, dosya 24 saat sonra silinir).">
          <JobsBox />
        </Section>
      )}
      <Section title="Boyut sıralaması" right={<HelpLink id="company-sizes" />} sub={r.data ? `${r.data.length} şirket · toplam ≈ ${bytes(total)}${big && total > 0 ? ` · en büyüğü %${Math.round((Number(big.est_bytes) / total) * 100)}` : ""}` : undefined}>
        {r.error ? <ErrorNote msg={r.error} /> : (
          <table className="w-full">
            <thead><tr><th className={th}>Şirket</th><th className={th}>Satır</th><th className={th}>Tahmini boyut</th><th className={th}>Pay</th><th className={th}>En büyük tablo</th>{operator && <th className={th}>İşlem</th>}</tr></thead>
            <tbody>
              {r.data!.map((c) => (
                <tr key={c.company_id} className="border-t">
                  <td className={td}><div className="font-medium">{c.company_name}</div><div className="text-xs text-muted-foreground">{c.slug}</div></td>
                  <td className={td}>{num(c.total_rows)}</td>
                  <td className={td}>{bytes(c.est_bytes)}</td>
                  <td className={td}>
                    <div className="w-24 h-2 bg-muted rounded"><div className="h-2 bg-primary rounded" style={{ width: `${total ? Math.max(2, (Number(c.est_bytes) / total) * 100) : 0}%` }} /></div>
                  </td>
                  <td className={td + " text-xs"}>{c.top_table ? `${c.top_table} (${num(c.top_rows)})` : "—"}</td>
                  {operator && <td className={td}><ExportButton id={c.company_id} name={c.company_name} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  )
}
