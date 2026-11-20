import fs from "fs"
import os from "os"
import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { query, safe } from "@/lib/db"
import { ago, bytes, num } from "@/lib/format"
import { HelpLink } from "@/components/panel/help-link"
import { Dot, ErrorNote, PageTitle, Section, Stat, td, th } from "@/components/panel/ui"

export const metadata = { title: "Genel bakış" }

type BackupInfo = { backup?: { type: string; timestamp: { stop: number }; info: { size: number; repository: { size: number } } }[]; status?: { code: number; message: string } }[]
type Svc = { unit: string; active: string; sub: string; since: string; memory: number | null; restarts: number }
type Health = { date: string | null; status: string; warnings: string[] }
type WdCheck = { key: string; label: string; ok: boolean; detail: string; severity: "critical" | "warn"; failCount: number; since: number | null }
type Watchdog = { updatedAt: number; checks: Record<string, WdCheck>; alerted: Record<string, unknown>; lastMailAt: number; lastSmsAt: number; lastError: string | null; settingsSource: string } | null

function disk(p: string) {
  try {
    const s = fs.statfsSync(p)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    return { total, used: total - free, pct: Math.round(((total - free) / total) * 100) }
  } catch {
    return null
  }
}

export default async function Overview() {
  const { user } = await requireSession()
  const actor = { email: user.email, role: user.role }
  const [dbR, svcR, bkR, hlR, wdR] = await Promise.all([
    safe(async () => {
      const [r] = await query<{ size: string; conns: string; maxc: string; xid: string; hit: string; failed: string; last_arch: string | null }>(`
        select pg_database_size(current_database())::text size,
          (select count(*) from pg_stat_activity where datname = current_database())::text conns,
          current_setting('max_connections') maxc,
          (select age(datfrozenxid) from pg_database where datname = current_database())::text xid,
          (select round(100.0 * blks_hit / greatest(blks_hit + blks_read, 1), 2) from pg_stat_database where datname = current_database())::text hit,
          (select failed_count from pg_stat_archiver)::text failed,
          (select to_char(last_archived_time, 'YYYY-MM-DD HH24:MI') from pg_stat_archiver) last_arch`)
      return r
    }),
    agentCall<Svc[]>("services", {}, actor),
    agentCall<BackupInfo>("backup_info", {}, actor, 60_000),
    agentCall<Health>("health_report", {}, actor),
    agentCall<Watchdog>("watchdog_status", {}, actor),
  ])

  const load = os.loadavg()
  const cpus = os.cpus().length
  const memTotal = os.totalmem()
  const memUsed = memTotal - os.freemem()
  const root = disk("/")
  const pgdata = disk("/var/lib/postgresql")

  let lastBackup: number | null = null
  let repoSize = 0
  if (bkR.ok) {
    const b = bkR.data?.[0]?.backup ?? []
    lastBackup = b.length ? Math.max(...b.map((x) => x.timestamp.stop)) * 1000 : null
    repoSize = b.reduce((m, x) => Math.max(m, x.info.repository.size), 0)
  }

  const alerts: string[] = []
  if (root && root.pct > 85) alerts.push(`Disk doluluğu %${root.pct}`)
  if (lastBackup && Date.now() - lastBackup > 36 * 3_600_000) alerts.push("Son yedek 36 saatten eski")
  if (bkR.ok && !lastBackup) alerts.push("Hiç yedek bulunamadı")
  if (svcR.ok) for (const s of svcR.data) if (s.active !== "active") alerts.push(`Servis çalışmıyor: ${s.unit} (${s.active})`)
  if (hlR.ok) for (const w of hlR.data.warnings) alerts.push(w.replace(/^WARN:\s*/, ""))
  if (dbR.data && Number(dbR.data.failed) > 0 && !dbR.data.last_arch) alerts.push("WAL arşivleme hatası")
  if (dbR.data && Number(dbR.data.xid) > 500_000_000) alerts.push("Transaction ID yaşı yüksek")
  if (!svcR.ok) alerts.push("Root ajanına ulaşılamadı: " + svcR.error)
  // Bağımsız izleyici (agent/watchdog.mjs, 15 dk): teyitli sorunlar + izleyicinin kendisi durduysa uyarı
  const wd = wdR.ok ? wdR.data : null
  const wdChecks = wd ? Object.values(wd.checks) : []
  const WD_STALE_MS = 35 * 60_000
  if (wdR.ok && !wd) alerts.push("Bağımsız izleyici henüz hiç çalışmadı (cron: /etc/cron.d/addinvoice-ops-watchdog)")
  if (wd && Date.now() - wd.updatedAt > WD_STALE_MS) alerts.push(`Bağımsız izleyici ${ago(wd.updatedAt)} sonuç yazmadı — cron/izleyici durmuş olabilir (sorun olsa bile e-posta/SMS GİTMEZ)`)
  for (const c of wdChecks) if (!c.ok && c.failCount >= 1) alerts.push(`${c.label}: ${c.detail}`)
  if (wd?.lastError) alerts.push("İzleyici uyarı gönderemedi: " + wd.lastError)

  return (
    <>
      <PageTitle title="Genel bakış" sub="Sunucu, veritabanı, yedek ve servis durumu — canlı okuma." />
      <HelpLink id="overview" label="Bu sayfa nasıl okunur? Uyarılar ne demek?" />

      {alerts.length > 0 ? (
        <div className="rounded-md border border-red-300 bg-red-50 text-red-900 p-4 text-sm">
          <b>Dikkat gerektiren {alerts.length} durum</b>
          <ul className="list-disc ml-5 mt-1">{alerts.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      ) : (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-900 p-3 text-sm"><Dot tone="ok" /> Her şey yolunda görünüyor.</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="CPU yükü (1/5/15 dk)" value={load.map((x) => x.toFixed(2)).join(" / ")} sub={`${cpus} çekirdek`} tone={load[0] > cpus ? "bad" : load[0] > cpus * 0.7 ? "warn" : "ok"} />
        <Stat label="Bellek" value={`${bytes(memUsed)} / ${bytes(memTotal)}`} sub={`%${Math.round((memUsed / memTotal) * 100)} (önbellek dahil)`} />
        <Stat label="Disk (/)" value={root ? `%${root.pct}` : "?"} sub={root ? `${bytes(root.used)} / ${bytes(root.total)}` : undefined} tone={root && root.pct > 85 ? "bad" : root && root.pct > 70 ? "warn" : "ok"} />
        <Stat label="Çalışma süresi" value={`${Math.floor(os.uptime() / 86400)} gün`} sub={os.hostname()} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {dbR.error ? (
          <div className="col-span-full"><ErrorNote msg={dbR.error} /></div>
        ) : (
          <>
            <Stat label="Veritabanı boyutu" value={bytes(dbR.data!.size)} />
            <Stat label="Bağlantılar" value={`${dbR.data!.conns} / ${dbR.data!.maxc}`} sub="PostgreSQL tarafı (pgBouncer arkası)" tone={Number(dbR.data!.conns) > Number(dbR.data!.maxc) * 0.8 ? "warn" : "ok"} />
            <Stat label="Önbellek isabeti" value={`%${dbR.data!.hit}`} sub="hedef > %99" tone={Number(dbR.data!.hit) < 95 ? "warn" : "ok"} />
            <Stat label="Transaction ID yaşı" value={num(dbR.data!.xid)} sub="2 milyara çok uzak olmalı" tone={Number(dbR.data!.xid) > 500_000_000 ? "bad" : "ok"} />
          </>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Yedek" sub="pgBackRest (WAL arşivi + tam/fark yedekler)">
          {!bkR.ok ? <ErrorNote msg={bkR.error} /> : (
            <div className="text-sm flex flex-col gap-1">
              <div><Dot tone={lastBackup && Date.now() - lastBackup < 36 * 3_600_000 ? "ok" : "bad"} />Son yedek: {lastBackup ? ago(lastBackup) : "yok"}</div>
              <div className="text-muted-foreground">Depo boyutu: {bytes(repoSize)} · WAL son arşiv: {dbR.data?.last_arch ?? "—"} · hatalı arşiv: {dbR.data?.failed ?? "?"}</div>
              {pgdata && <div className="text-muted-foreground">Yedek deposu aynı diskte → disk arızasına karşı koruma DEĞİL (uzak depo bekleniyor).</div>}
            </div>
          )}
        </Section>

        <Section title="Servisler">
          {!svcR.ok ? <ErrorNote msg={svcR.error} /> : (
            <table className="w-full">
              <thead><tr><th className={th}>Servis</th><th className={th}>Durum</th><th className={th}>Yeniden başl.</th></tr></thead>
              <tbody>
                {svcR.data.map((s) => (
                  <tr key={s.unit} className="border-t">
                    <td className={td}>{s.unit}</td>
                    <td className={td}><Dot tone={s.active === "active" ? "ok" : "bad"} />{s.active}</td>
                    <td className={td}>{s.restarts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title="Canlı denetimler (bağımsız izleyici, 15 dakikada bir)" sub={wd ? `Son denetim: ${ago(wd.updatedAt)} · uyarılar: e-posta + (kritikse) SMS · ayar kaynağı: ${wd.settingsSource}` : undefined} right={<HelpLink id="watchdog" />}>
        {!wdR.ok ? <ErrorNote msg={wdR.error} /> : !wd ? <p className="text-sm text-muted-foreground">Henüz sonuç yok.</p> : (
          <table className="w-full">
            <thead><tr><th className={th}>Denetim</th><th className={th}>Durum</th><th className={th}>Ayrıntı</th></tr></thead>
            <tbody>
              {wdChecks.map((c) => (
                <tr key={c.key} className="border-t">
                  <td className={td}>{c.label}{c.severity === "critical" ? "" : <span className="text-xs text-muted-foreground"> (uyarı düzeyi)</span>}</td>
                  <td className={td}><Dot tone={c.ok ? "ok" : "bad"} />{c.ok ? "tamam" : "SORUN"}</td>
                  <td className={td + " text-xs"}>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Haftalık sağlık raporu" sub={hlR.ok ? `Son rapor: ${hlR.data.date ?? "yok"} · durum: ${hlR.data.status}` : undefined}>
        {!hlR.ok ? <ErrorNote msg={hlR.error} /> : hlR.data.warnings.length ? (
          <ul className="list-disc ml-5 text-sm">{hlR.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        ) : <p className="text-sm text-muted-foreground">Uyarı yok.</p>}
      </Section>
    </>
  )
}
