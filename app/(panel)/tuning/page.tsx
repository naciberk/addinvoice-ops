import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { query, safe } from "@/lib/db"
import { ago } from "@/lib/format"
import { APP_NOTE, HISTORY, NGINX_ITEMS, PGB_ITEMS, PG_ITEMS, SYSCTL_ITEMS, type Item } from "@/lib/tuning"
import { Dot, ErrorNote, PageTitle, Section, Stat, td, th } from "@/components/panel/ui"
import { HelpLink } from "@/components/panel/help-link"
import os from "os"

export const metadata = { title: "Ayarlar (tuning)" }
export const dynamic = "force-dynamic"

type Snap = { pgbouncer: Record<string, string>; nginx: Record<string, string>; app: { name: string; mode: string; id: number; status: string; restarts: number; memory: number; cpu: number; uptime: number }[]; sysctl: Record<string, string>; thp: string }

const norm = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase()

function Table({ items, current, showDedicated }: { items: Item[]; current: Record<string, string | undefined>; showDedicated?: boolean }) {
  return (
    <table className="w-full">
      <thead><tr><th className={th}>Ayar</th><th className={th}>Şu an</th><th className={th}>Hedef</th>{showDedicated && <th className={th}>Dedicated (48 GB)</th>}<th className={th}>Ne işe yarar / neden bu değer?</th></tr></thead>
      <tbody>
        {items.map((it) => {
          const cur = current[it.key]
          const same = norm(cur) === norm(it.target) || (it.equiv ?? []).map(norm).includes(norm(cur))
          return (
            <tr key={it.key} className={"border-t " + (cur === undefined ? "" : same ? "" : "bg-amber-50")}>
              <td className={td}><div className="font-medium">{it.label}</div><div className="font-mono text-xs text-muted-foreground">{it.key}</div></td>
              <td className={td + " font-mono text-xs max-w-[14rem] break-words"}><Dot tone={cur === undefined ? "off" : same ? "ok" : "warn"} />{cur ?? "—"}</td>
              <td className={td + " font-mono text-xs max-w-[14rem] break-words"}>{it.target.length > 40 ? it.target.slice(0, 40) + "…" : it.target}</td>
              {showDedicated && <td className={td + " font-mono text-xs"}>{it.dedicated ?? "—"}</td>}
              <td className={td + " text-xs text-muted-foreground min-w-[18rem]"}>{it.why}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default async function TuningPage() {
  const { user } = await requireSession()
  const [pg, snap] = await Promise.all([
    safe(() => query<{ name: string; val: string; pending: boolean }>("select name, current_setting(name) as val, pending_restart as pending from pg_settings where name = any($1)", [PG_ITEMS.map((i) => i.key)])),
    agentCall<Snap>("tuning_snapshot", {}, { email: user.email, role: user.role }, 30_000),
  ])
  const pgCur = Object.fromEntries((pg.data ?? []).map((r) => [r.name, r.val]))
  const pending = (pg.data ?? []).filter((r) => r.pending).map((r) => r.name)
  const s = snap.ok ? snap.data : null
  const nginxCur: Record<string, string | undefined> = s ? { ...s.nginx } : {}
  const pgbCur: Record<string, string | undefined> = s ? { ...s.pgbouncer } : {}
  const app = s?.app.filter((a) => a.name === "addinvoice") ?? []
  const cluster = app.length > 0 && app[0].mode === "cluster_mode"

  return (
    <>
      <PageTitle title="Ayarlar (tuning)" sub="Sistemin hız ve kararlılık ayarları: şu anki canlı değer, hedef değer ve neden. Sarı satır = hedeften farklı (bilinçli olabilir). Değiştirmek için Yapılandırma sayfası (yönetici)." />
      <div className="flex gap-4 text-sm"><HelpLink id="tuning-page" label="Bu sayfa nasıl okunur?" /></div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Sunucu" value={`${os.cpus().length} çekirdek / ${(os.totalmem() / 1073741824).toFixed(0)} GB`} sub="uygulama + PostgreSQL + nginx aynı makinede" />
        <Stat label="Uygulama modu" value={app.length ? (cluster ? `cluster × ${app.length}` : "tek süreç (fork)") : "?"} sub={cluster ? "çok çekirdek kullanılıyor" : "yalnız 1 çekirdek"} tone={cluster ? "ok" : "warn"} />
        <Stat label="PostgreSQL restart bekleyen" value={pending.length ? pending.length : "yok"} sub={pending.join(", ") || "tüm ayarlar uygulanmış"} tone={pending.length ? "warn" : "ok"} />
        <Stat label="Transparent Huge Pages" value={s?.thp.match(/\[(\w+)\]/)?.[1] ?? "?"} sub="madvise = PostgreSQL için doğru" />
      </div>

      <Section title="PostgreSQL" sub="Canlı değerler pg_settings'ten; dosya: /etc/postgresql/16/main/conf.d/addinvoice-tuning.conf">
        {pg.error ? <ErrorNote msg={pg.error} /> : <Table items={PG_ITEMS} current={pgCur} showDedicated />}
      </Section>

      <Section title="pgBouncer (bağlantı havuzu)" sub="Dosya: /etc/pgbouncer/pgbouncer.ini">
        {!snap.ok ? <ErrorNote msg={snap.error} /> : <Table items={PGB_ITEMS} current={pgbCur} />}
      </Section>

      <Section title="nginx (web sunucusu)" sub="Dosyalar: /etc/nginx/nginx.conf ve sites-enabled/addinvoice. Cloudflare önde olduğundan HTTP/2/3 ve brotli istemci tarafında zaten orada.">
        {!snap.ok ? <ErrorNote msg={snap.error} /> : <Table items={NGINX_ITEMS} current={{ ...nginxCur, upstream_keepalive: nginxCur.upstream_keepalive }} />}
      </Section>

      <Section title="Uygulama (Next.js / pm2)" sub="pm2 süreçleri">
        {!snap.ok ? <ErrorNote msg={snap.error} /> : (
          <div className="flex flex-col gap-3">
            <table className="w-full">
              <thead><tr><th className={th}>#</th><th className={th}>Ad</th><th className={th}>Mod</th><th className={th}>Durum</th><th className={th}>Bellek</th><th className={th}>CPU %</th><th className={th}>Açık kalma</th><th className={th}>Yeniden başl.</th></tr></thead>
              <tbody>{app.map((a) => <tr key={a.id} className="border-t"><td className={td}>{a.id}</td><td className={td}>{a.name}</td><td className={td}>{a.mode}</td><td className={td}><Dot tone={a.status === "online" ? "ok" : "bad"} />{a.status}</td><td className={td}>{Math.round(a.memory / 1048576)} MB</td><td className={td}>{a.cpu}</td><td className={td}>{ago(Date.now() - a.uptime)}</td><td className={td}>{a.restarts}</td></tr>)}</tbody>
            </table>
            {!cluster && <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-950">Uygulama tek süreç. <b>Cluster'a geçiş hazır</b> (ecosystem.config.cjs, 3 instance) — çalıştırılacak komutlar için <a className="underline" href="/help#komutlar">Rehber → Komutlar</a>.</div>}
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{APP_NOTE}</pre>
          </div>
        )}
      </Section>

      <Section title="Çekirdek (sysctl)" sub="Dosya: /etc/sysctl.d/99-addinvoice.conf (arayüzden değiştirilemez; SSH)">
        {!snap.ok ? <ErrorNote msg={snap.error} /> : <Table items={SYSCTL_ITEMS} current={s!.sysctl} />}
      </Section>

      <Section title="Değişiklik geçmişi" sub="Ne zaman, ne değişti. Yapılandırma değişikliklerinin dosya yedekleri Yapılandırma sayfasında.">
        <ol className="flex flex-col gap-4">
          {HISTORY.map((h) => (
            <li key={h.date}><div className="font-medium text-sm">{h.date} — {h.title}</div><ul className="list-disc ml-5 text-sm text-muted-foreground mt-1 flex flex-col gap-1">{h.items.map((x, i) => <li key={i}>{x}</li>)}</ul></li>
          ))}
        </ol>
      </Section>
    </>
  )
}
