"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CopyCode } from "@/components/panel/copy-code"
import { bytes, dt } from "@/lib/format"
import { cn } from "@/lib/utils"
import { loadArchives } from "@/app/(panel)/backup/actions"
import { cleanupWorkspace, dbPreview, dbSummary, getJob, listWorkspaces, restoreBrowse, startDbExport, startDbPrepare, startExtract, type Browse, type Child, type DbSummary, type JobView, type Workspace } from "@/app/(panel)/backup/restore/actions"

// ── İş izleme (2 sn'de bir sorgular; parola yalnız ilk teslimde gelir, bellekte tutulur) ──────────────────
function useJob(jobId: string | null) {
  const [job, setJob] = useState<JobView | null>(null)
  const secret = useRef<string | null>(null)
  useEffect(() => {
    secret.current = null
    setJob(null)
    if (!jobId) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const r = await getJob(jobId).catch(() => null)
      if (stop) return
      if (r && r.ok && r.data) {
        if (r.data.secret) secret.current = r.data.secret
        setJob({ ...r.data, secret: secret.current })
        if (r.data.state !== "running") return
      }
      timer = setTimeout(tick, 2000)
    }
    tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [jobId])
  return job
}

function JobBox({ job }: { job: JobView | null }) {
  if (!job) return <p className="text-xs text-muted-foreground">İş başlatılıyor…</p>
  const res = job.result as { file?: string; size?: number; files?: number } | string | null
  const file = typeof res === "object" && res?.file ? res.file : null
  return (
    <div className="rounded-md border p-3 text-sm flex flex-col gap-2">
      <div className="flex justify-between gap-2"><span className="font-medium">{job.label}</span><span className={job.state === "failed" ? "text-destructive" : job.state === "done" ? "text-emerald-700" : "text-amber-600"}>{job.state === "running" ? "çalışıyor…" : job.state === "done" ? "tamamlandı" : "başarısız"}</span></div>
      {job.state === "failed" && typeof res === "string" && <p className="text-xs text-destructive">{res}</p>}
      {job.state === "running" && job.log.length > 0 && <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{job.log.slice(-3).join("\n")}</pre>}
      {file && (
        <div className="flex flex-col gap-2">
          <a href={`/api/download/${file}`} className="inline-flex items-center gap-1 underline"><Download className="w-4 h-4" /> {file} {typeof res === "object" && res?.size ? `(${bytes(res.size)})` : ""}</a>
          {job.secret ? (
            <div className="rounded bg-amber-50 border border-amber-300 p-2 text-xs flex flex-col gap-1">
              <b>Şifre çözme parolası (bir kez gösterilir; parola yöneticine kaydet):</b>
              <CopyCode code={job.secret} />
              <span className="text-muted-foreground">Açmak için:</span>
              <CopyCode code={`openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in ${file} | tar x`} />
              <span className="text-muted-foreground">Dosya 24 saat sonra silinir.</span>
            </div>
          ) : <p className="text-xs text-muted-foreground">Parola daha önce gösterildi (tekrar gösterilmez).</p>}
        </div>
      )}
    </div>
  )
}

// ── Dosya gezgini (arşiv içinde klasör/dosya seç) ────────────────────────────────────────────────────────
function FileBrowser({ target, archive }: { target: string; archive: string }) {
  const [data, setData] = useState<Browse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<Record<string, Child>>({})
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId)

  const go = useCallback(async (dir: string, auto = false) => {
    setLoading(true)
    const r = await restoreBrowse(target, archive, dir, auto)
    setLoading(false)
    if (r.ok) { setData(r.data); setErr(null) } else setErr(r.message)
  }, [target, archive])
  useEffect(() => { setSel({}); setJobId(null); go("", true) }, [go])

  const chosen = Object.values(sel)
  const totalFiles = chosen.reduce((a, c) => a + c.files, 0)
  const totalSize = chosen.reduce((a, c) => a + c.size, 0)
  const crumbs = (data?.dir ?? "").split("/").filter(Boolean)
  const toggle = (c: Child) => setSel((s) => { const n = { ...s }; if (n[c.path]) delete n[c.path]; else n[c.path] = c; return n })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
        <button type="button" className="underline" onClick={() => go("")}>/</button>
        {crumbs.map((c, i) => <span key={i}>/<button type="button" className="underline" onClick={() => go(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
        {loading && <span className="text-muted-foreground ml-2">yükleniyor…</span>}
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {data && (
        <div className="rounded border max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <tbody>
              {data.dir && <tr className="border-b"><td colSpan={4} className="px-2 py-1"><button type="button" className="text-xs underline" onClick={() => go(data.dir.split("/").slice(0, -1).join("/"))}>↑ üst klasör</button></td></tr>}
              {data.children.map((c) => (
                <tr key={c.path} className={cn("border-b last:border-0", sel[c.path] && "bg-primary/5")}>
                  <td className="px-2 py-1 w-8"><input type="checkbox" checked={!!sel[c.path]} onChange={() => toggle(c)} aria-label={`${c.name} seç`} /></td>
                  <td className="px-2 py-1 font-mono text-xs break-all">{c.dir ? <button type="button" className="underline" onClick={() => go(c.path)}>📁 {c.name}</button> : <span>📄 {c.name}</span>}</td>
                  <td className="px-2 py-1 text-xs text-muted-foreground whitespace-nowrap">{c.dir ? `${c.files} dosya` : c.mtime.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-2 py-1 text-xs text-muted-foreground whitespace-nowrap text-right">{bytes(c.size)}</td>
                </tr>
              ))}
              {!data.children.length && <tr><td className="px-2 py-3 text-xs text-muted-foreground">Bu klasör boş.</td></tr>}
            </tbody>
          </table>
          {data.truncated && <p className="p-2 text-xs text-amber-700">Çok sayıda öğe: ilk 1000 gösteriliyor. Daha alt bir klasöre inin.</p>}
        </div>
      )}
      <div className="rounded-md bg-muted/40 p-3 text-sm flex flex-col gap-2">
        <div><b>Seçilen:</b> {chosen.length ? `${chosen.length} öğe · ${totalFiles} dosya · ${bytes(totalSize)}` : "henüz bir şey seçilmedi"}</div>
        {chosen.length > 0 && <ul className="text-xs font-mono flex flex-col gap-0.5 max-h-32 overflow-auto">{chosen.map((c) => <li key={c.path}>{c.path} <button type="button" className="text-destructive ml-2" onClick={() => toggle(c)}>kaldır</button></li>)}</ul>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!chosen.length || (!!jobId && job?.state === "running")} onClick={async () => { const r = await startExtract(target, archive, chosen.map((c) => c.path)); if (r.ok) setJobId(r.data.jobId); else setErr(r.message) }}>Güvenli kopyaya aç ve şifreli paketle</Button>
          <span className="text-xs text-muted-foreground">Canlı dosyalara dokunulmaz; paket şifreli indirilir (24 saat).</span>
        </div>
      </div>
      {jobId && <JobBox job={job} />}
    </div>
  )
}

// ── Veritabanı dökümü: geçici veritabanı + tablo/şirket seçimi ───────────────────────────────────────────
function DbPanel({ target, archive, initialId }: { target?: string; archive?: string; initialId?: string }) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [exportJob, setExportJob] = useState<string | null>(null)
  const job = useJob(jobId)
  const expJob = useJob(exportJob)
  const [sum, setSum] = useState<DbSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [company, setCompany] = useState("")
  const [prev, setPrev] = useState<{ table: string; total: number; shown: number; rows: Record<string, unknown>[] } | null>(null)

  useEffect(() => { setSum(null); setJobId(null); setPrev(null); setPicked([]) }, [target, archive])
  useEffect(() => { if (initialId) dbSummary(initialId).then((r) => (r.ok ? setSum(r.data) : setErr(r.message))) }, [initialId])
  useEffect(() => { if (job?.state === "done" && job.result && typeof job.result === "object" && "tables" in (job.result as object)) setSum(job.result as DbSummary) }, [job])

  const tables = (sum?.tables ?? []).filter((t) => t.name.includes(filter.toLowerCase()))
  const cols = prev?.rows[0] ? Object.keys(prev.rows[0]) : []

  return (
    <div className="flex flex-col gap-3">
      {!sum && target && archive && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Döküm, <b>geçici bir veritabanına</b> (canlıdan ayrı, 24 saat sonra silinir) açılır; oradan tablo ve şirket seçebilirsin.</p>
          <span><Button disabled={!!jobId && job?.state === "running"} onClick={async () => { setErr(null); const r = await startDbPrepare(target, archive); if (r.ok) setJobId(r.data.jobId); else setErr(r.message) }}>Geçici veritabanına aç</Button></span>
          {jobId && <JobBox job={job} />}
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
      {sum && (
        <div className="flex flex-col gap-3">
          <div className="text-xs text-muted-foreground">Geçici veritabanı <code>{sum.db}</code> · {sum.archive} · {sum.tables.length} tablo</div>
          <div className="flex flex-wrap items-center gap-3">
            <input className="rounded border bg-background px-2 py-1.5 text-sm" placeholder="Tablo ara…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">Şirket süzgeci
              <select className="rounded border bg-background px-2 py-1.5 text-sm max-w-64" value={company} onChange={(e) => { setCompany(e.target.value); setPrev(null) }}>
                <option value="">Tümü</option>
                {sum.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <span className="text-xs text-muted-foreground">(yalnız şirket sütunu olan tablolara uygulanır)</span>
          </div>
          <div className="rounded border max-h-80 overflow-auto">
            <table className="w-full text-sm"><tbody>
              {tables.map((t) => {
                const byCompany = company && sum.companyTables.includes(t.name)
                return (
                  <tr key={t.name} className={cn("border-b last:border-0", picked.includes(t.name) && "bg-primary/5")}>
                    <td className="px-2 py-1 w-8"><input type="checkbox" checked={picked.includes(t.name)} onChange={() => setPicked((p) => (p.includes(t.name) ? p.filter((x) => x !== t.name) : [...p, t.name]))} aria-label={t.name} /></td>
                    <td className="px-2 py-1 font-mono text-xs">{t.name}{byCompany ? <span className="ml-2 text-primary">(şirkete süzülür)</span> : null}</td>
                    <td className="px-2 py-1 text-xs text-muted-foreground text-right">{t.rows} satır</td>
                    <td className="px-2 py-1 text-right"><button type="button" className="text-xs underline" onClick={async () => { const r = await dbPreview(sum.id, t.name, byCompany ? company : undefined); if (r.ok) { setPrev(r.data); setErr(null) } else setErr(r.message) }}>önizle</button></td>
                  </tr>
                )
              })}
            </tbody></table>
          </div>
          {prev && (
            <div className="flex flex-col gap-1">
              <div className="text-xs"><b>{prev.table}</b>: {prev.total} satırdan ilk {prev.shown} gösteriliyor</div>
              <div className="rounded border overflow-auto max-h-72">
                <table className="text-xs"><thead><tr>{cols.map((c) => <th key={c} className="text-left font-medium text-muted-foreground px-2 py-1 whitespace-nowrap">{c}</th>)}</tr></thead>
                  <tbody>{prev.rows.map((r, i) => <tr key={i} className="border-t">{cols.map((c) => <td key={c} className="px-2 py-1 whitespace-nowrap max-w-64 overflow-hidden text-ellipsis">{r[c] == null ? <span className="text-muted-foreground">∅</span> : String(r[c])}</td>)}</tr>)}</tbody></table>
              </div>
            </div>
          )}
          <div className="rounded-md bg-muted/40 p-3 flex flex-col gap-2">
            <div className="text-sm"><b>Seçilen:</b> {picked.length ? `${picked.length} tablo` : "tablo seçilmedi"}{company ? ` · şirket süzgeci açık` : ""}</div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!picked.length} onClick={async () => { const r = await startDbExport(sum.id, { tables: picked, companyId: company || undefined }); if (r.ok) setExportJob(r.data.jobId); else setErr(r.message) }}>Seçili tabloları CSV olarak şifreli indir</Button>
              <Button variant="outline" disabled={!company} onClick={async () => { const r = await startDbExport(sum.id, { companyId: company, companyPackage: true }); if (r.ok) setExportJob(r.data.jobId); else setErr(r.message) }}>Seçili şirketin tam paketini indir</Button>
              <Button variant="outline" onClick={async () => { const r = await cleanupWorkspace(sum.id); if (r.ok) { setSum(null); setPrev(null); setJobId(null); setExportJob(null) } else setErr(r.message) }}>Geçici veritabanını sil</Button>
            </div>
            <p className="text-xs text-muted-foreground">CSV ve şirket paketi şifreli (.tar.enc) iner. Canlı veritabanına HİÇBİR şey yazılmaz. Canlıya geri uygulama Aşama 2'dedir.</p>
          </div>
          {exportJob && <JobBox job={expJob} />}
        </div>
      )}
    </div>
  )
}

// ── Sihirbaz ──────────────────────────────────────────────────────────────────────────────────────────────
type JobLite = { id: string; name: string; type: string }
const LEGACY: JobLite[] = [{ id: "files", name: "Eski: bilag dosyaları (files)", type: "files" }, { id: "config", name: "Eski: sunucu ayarları + kod (config)", type: "files" }]

export function RestoreWizard({ targets, jobs }: { targets: { id: string; name: string }[]; jobs: JobLite[] }) {
  const [target, setTarget] = useState(targets[0]?.id ?? "")
  const [group, setGroup] = useState<JobLite | null>(null)
  const [archives, setArchives] = useState<{ name: string; time: string }[] | null>(null)
  const [archive, setArchive] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const choices = [...jobs.filter((j) => j.type !== "verify"), ...LEGACY.filter((l) => !jobs.some((j) => j.id === l.id))]
  const isDb = group?.type === "db" || group?.type === "tables"

  useEffect(() => { setGroup(null); setArchives(null); setArchive(null) }, [target])
  const pick = async (g: JobLite) => {
    setGroup(g); setArchive(null); setArchives(null); setErr(null); setLoading(true)
    const r = await loadArchives(target, g.id)
    setLoading(false)
    if (r.ok) setArchives(r.data.archives); else setErr(r.message)
  }

  if (!targets.length) return <p className="text-sm text-muted-foreground">Etkin yedek hedefi yok.</p>
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold">1. Hangi hedeften?</div>
        <select className="rounded border bg-background px-2 py-1.5 text-sm max-w-sm" value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold">2. Neyi geri yükleyeceksin?</div>
        <div className="grid gap-2 md:grid-cols-3">
          {choices.map((g) => (
            <button type="button" key={g.id} onClick={() => pick(g)} className={cn("rounded-md border p-3 text-left text-sm", group?.id === g.id ? "border-primary bg-primary/5" : "hover:bg-muted")}>
              <div className="font-medium">{g.name}</div><div className="text-xs text-muted-foreground"><code>{g.id}</code></div>
            </button>
          ))}
        </div>
      </div>
      {group && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold">3. Hangi zamandan? <span className="font-normal text-xs text-muted-foreground">(en yeni üstte)</span></div>
          {loading && <p className="text-xs text-muted-foreground">Arşivler okunuyor…</p>}
          {err && <p className="text-xs text-destructive">{err}</p>}
          {archives && !archives.length && <p className="text-sm text-muted-foreground">Bu görev için arşiv bulunamadı.</p>}
          {archives && archives.length > 0 && (
            <div className="grid gap-1 sm:grid-cols-2 md:grid-cols-3 max-h-56 overflow-auto">
              {archives.map((a) => (
                <label key={a.name} className={cn("flex items-center gap-2 rounded border px-2 py-1 text-xs cursor-pointer", archive === a.name && "border-primary bg-primary/5")}>
                  <input type="radio" name="archive" checked={archive === a.name} onChange={() => setArchive(a.name)} />
                  <span><span className="font-mono">{a.name}</span><span className="block text-muted-foreground">{a.time}</span></span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {group && archive && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold">4. {isDb ? "Tablo / şirket seç" : "Dosya ve klasör seç"}</div>
          {isDb ? <DbPanel target={target} archive={archive} /> : <FileBrowser target={target} archive={archive} />}
        </div>
      )}
    </div>
  )
}

/** Açık çalışma alanları (geçici veritabanları): yeniden aç veya temizle. */
export function WorkspacesBox() {
  const [list, setList] = useState<Workspace[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => { const r = await listWorkspaces(); if (r.ok) setList(r.data); else setErr(r.message) }, [])
  useEffect(() => { load() }, [load])
  if (err) return <p className="text-xs text-destructive">{err}</p>
  if (!list) return <p className="text-xs text-muted-foreground">Okunuyor…</p>
  if (!list.length) return <p className="text-sm text-muted-foreground">Açık çalışma alanı yok.</p>
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full text-sm"><tbody>
        {list.map((w) => (
          <tr key={w.id} className="border-t">
            <td className="px-2 py-1 font-mono text-xs">{w.id}</td><td className="px-2 py-1 text-xs">{w.type === "db" ? "veritabanı" : "dosyalar"}</td><td className="px-2 py-1 text-xs font-mono">{w.archive}</td><td className="px-2 py-1 text-xs text-muted-foreground">{dt(w.created)} · {w.actor}</td>
            <td className="px-2 py-1 text-right whitespace-nowrap">
              {w.db && <button type="button" className="text-xs underline mr-3" onClick={() => setOpen(w.id)}>aç</button>}
              <button type="button" className="text-xs text-destructive" onClick={async () => { await cleanupWorkspace(w.id); if (open === w.id) setOpen(null); load() }}>temizle</button>
            </td>
          </tr>
        ))}
      </tbody></table>
      {open && <DbPanel initialId={open} />}
    </div>
  )
}
