import Link from "next/link"
import { agentCall } from "@/lib/agent-client"
import { requireSession } from "@/lib/auth"
import { ago, dt } from "@/lib/format"
import { can } from "@/lib/roles"
import { describeSchedule } from "@/lib/backup-types"
import type { CronOverview } from "@/lib/cron-types"
import { HelpLink } from "@/components/panel/help-link"
import { Dot, Empty, ErrorNote, PageTitle, Section, Stat, td, th } from "@/components/panel/ui"
import { RunNowCron, SchedulerToggle, ToggleCron } from "@/components/panel/cron/buttons"

export const metadata = { title: "Zamanlanmış görevler" }
export const dynamic = "force-dynamic"

const dur = (ms?: number) => (ms == null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} sn` : `${ms} ms`)

export default async function CronPage() {
  const { user } = await requireSession()
  const admin = can(user.role, "admin")
  const r = await agentCall<CronOverview>("cron_overview", {}, { email: user.email, role: user.role })
  if (!r.ok) return (<><PageTitle title="Zamanlanmış görevler" /><ErrorNote msg={r.error} /></>)
  const o = r.data
  const active = o.jobs.filter((j) => j.enabled)
  const failing = o.jobs.filter((j) => j.enabled && j.state.consecutiveFailures > 0)
  const sum = o.jobs.reduce((a, j) => ({ ok: a.ok + j.stats24h.ok, fail: a.fail + j.stats24h.fail, skipped: a.skipped + j.stats24h.skipped }), { ok: 0, fail: 0, skipped: 0 })
  const hbMs = o.heartbeat ? Date.parse(o.heartbeat) : NaN
  const hbOk = Number.isFinite(hbMs) && Date.now() - hbMs < 3 * 60_000
  const nextAll = active.filter((j) => j.next[0]).sort((a, b) => a.next[0].localeCompare(b.next[0]))[0]

  return (
    <>
      <PageTitle title="Zamanlanmış görevler" sub="Uygulamanın arka plan işleri (worker'lar): ne zaman çalışıyorlar, son çalışma başarılı mı, birbirleriyle çakışıyor mu. Saatler Danimarka saatiyle." />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {admin && <Link className="underline" href="/cron/job/new">+ Yeni görev</Link>}
        <HelpLink id="cron-engine" label="Bu sayfa nasıl çalışır?" />
        <HelpLink id="cron-schedule" label="Zamanlama nasıl seçilir?" />
      </div>

      {!o.enabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 p-4 text-sm flex flex-col gap-2">
          <div className="font-medium">Zamanlayıcı kapalı — bu sayfadaki görevler şu an ÇALIŞMIYOR.</div>
          {o.legacyLines > 0 ? (
            <div>{o.legacyLines} worker çağrısı hâlâ eski crontab'da (hata görünmeden, çakışma denetimi olmadan) çalışıyor. {admin ? <Link className="underline" href="/cron/migrate">Taşıma sayfasına git →</Link> : "Taşıma için bir yönetici gerekir."}</div>
          ) : (
            <div>{admin ? <>Hiç görev yok ya da zamanlayıcı durdurulmuş. <Link className="underline" href="/cron/migrate">Taşıma ve zamanlayıcı →</Link></> : "Bir yönetici zamanlayıcıyı açmalı."}</div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Zamanlayıcı" value={o.enabled ? (hbOk ? "çalışıyor" : "SUSTU") : "kapalı"} tone={o.enabled ? (hbOk ? "ok" : "bad") : "warn"} sub={o.heartbeat ? `son nabız: ${ago(hbMs)}` : "henüz nabız yok"} />
        <Stat label="Görev" value={`${active.length} / ${o.jobs.length}`} sub="etkin / toplam" />
        <Stat label="Son 24 saat" value={`${sum.ok} ✓ · ${sum.fail} ✗`} tone={sum.fail ? "bad" : "ok"} sub={sum.skipped ? `${sum.skipped} tur atlandı (önceki sürüyordu)` : "atlanan yok"} />
        <Stat label="Sıradaki" value={nextAll ? dt(nextAll.next[0]) : "—"} sub={nextAll?.name} />
      </div>

      {failing.length > 0 && (
        <p className="text-sm text-destructive">Son çalışması başarısız: {failing.map((j) => j.name).join(", ")}</p>
      )}

      <Section title="Görevler" sub="Her görevin altında ne işe yaradığı yazar. Başarısız çalışmalar günlük kaydında HTTP kodu ve cevapla görünür." right={admin ? <SchedulerToggle enabled={o.enabled} /> : undefined}>
        {!o.jobs.length ? <Empty>Henüz görev yok. Eski crontab'daki worker satırlarını Taşıma sekmesinden aktarabilir ya da “+ Yeni görev” ile ekleyebilirsin.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>Görev</th><th className={th}>Takvim</th><th className={th}>Sıradaki</th><th className={th}>Son çalışma</th><th className={th}></th></tr></thead>
            <tbody>
              {o.jobs.map((j) => {
                const lr = j.state.lastRun
                const tone = j.state.running ? "warn" : lr?.outcome === "fail" ? "bad" : lr?.outcome === "ok" ? "ok" : "off"
                return (
                  <tr key={j.id} className={"border-t " + (j.enabled ? "" : "opacity-60")}>
                    <td className={td}>
                      <div className="font-medium">{admin ? <Link className="underline underline-offset-2" href={`/cron/job/${j.id}`}>{j.name}</Link> : j.name}</div>
                      <div className="text-xs text-muted-foreground"><code>{j.target}</code>{!j.enabled && " · duraklatıldı"}{j.frequent && " · sık görev"}</div>
                      {j.description && <div className="text-xs text-muted-foreground mt-1 max-w-xl">{j.description}</div>}
                    </td>
                    <td className={td + " text-xs"}>{describeSchedule(j.schedule)}{j.schedule.source.kind === "cron" && <div className="font-mono text-muted-foreground">{j.schedule.source.expr}</div>}</td>
                    <td className={td + " text-xs whitespace-nowrap"}>{o.enabled && j.enabled && j.next[0] ? dt(j.next[0]) : "—"}</td>
                    <td className={td + " text-xs"}>
                      {!lr && !j.state.running ? <span className="text-muted-foreground">henüz çalışmadı</span> : (
                        <div>
                          <Dot tone={tone} />{j.state.running ? "çalışıyor…" : <>{dt(lr!.ts)} · {lr!.outcome === "ok" ? "başarılı" : lr!.outcome === "fail" ? "HATA" : "atlandı"}{lr!.status ? ` · ${lr!.status}` : ""}{lr!.ms != null ? ` · ${dur(lr!.ms)}` : ""}</>}
                          {lr && lr.outcome !== "ok" && lr.message && <div className="text-destructive break-all max-w-sm">{lr.message}</div>}
                          <div className="text-muted-foreground">24 sa: {j.stats24h.ok} ✓ {j.stats24h.fail ? `· ${j.stats24h.fail} ✗ ` : ""}{j.stats24h.skipped ? `· ${j.stats24h.skipped} atlandı` : ""}</div>
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      {admin && (
                        <div className="flex flex-col gap-1 items-start">
                          <RunNowCron id={j.id} name={j.name} />
                          <ToggleCron id={j.id} enabled={j.enabled} />
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Section>

      {o.unscheduled.length > 0 && (
        <Section title="Zamanlanmamış worker'lar" sub="Ana uygulamada bu adresler var ama hiçbir yerde zamanlanmamış. Bilerek mi kapalı, yoksa unutulmuş mu? Gerekiyorsa zamanla.">
          <table className="w-full">
            <tbody>
              {o.unscheduled.map((w) => (
                <tr key={w.name} className="border-t">
                  <td className={td}><div className="font-medium font-mono text-sm">{w.name}</div><div className="text-xs text-muted-foreground max-w-2xl">{w.description || "Açıklama yok."}</div></td>
                  <td className={td}>{admin && <Link className="underline text-sm" href={`/cron/job/new?target=${w.name}`}>Zamanla</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {o.savedAt && <p className="text-xs text-muted-foreground">Yapılandırma son kaydedilme: {dt(o.savedAt)} · {o.savedBy}</p>}
    </>
  )
}
