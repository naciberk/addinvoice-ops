"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ScheduleEditor } from "@/components/panel/backup/schedule-editor"
import { browseDir, loadTables, saveJob } from "@/app/(panel)/backup/actions"
import type { Job, JobType, ScheduleInput, Target } from "@/lib/backup-types"
import { cn } from "@/lib/utils"

const TYPES: { id: JobType; label: string; hint: string }[] = [
  { id: "uploads", label: "Bilag dosyaları (uploads)", hint: "data/uploads klasörü (müşteri belgeleri)." },
  { id: "code", label: "Site/uygulama dosyaları", hint: "addinvoice, addinvoice-site, addinvoice-ops kaynak kodu (node_modules ve derleme çıktıları hariç; .env ayrı görevde)." },
  { id: "db", label: "Tüm veritabanı", hint: "Tam pg_dump + roller. İstersen pgBackRest deposunu da ekleyebilirsin." },
  { id: "tables", label: "Önemli tablolar", hint: "Seçtiğin tabloların ayrı, sık alınan dökümü (varsayılan: postering ve kassekladde)." },
  { id: "server", label: "Sunucu ayarları + kurulu programlar", hint: "/etc, nginx, sertifikalar, cron, systemd, ufw, pm2, paket ve sürüm listeleri." },
  { id: "custom", label: "Özel yollar", hint: "İzinli köklerin altından seçtiğin klasör/dosyalar." },
  { id: "verify", label: "Yedek doğrulama", hint: "Depo bütünlüğü + son dökümün okunabilirliği (önerilen: ayda bir)." },
]

const slug = (s: string) => s.toLowerCase().replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30)

function PathPicker({ paths, onChange, roots }: { paths: string[]; onChange: (p: string[]) => void; roots: string[] }) {
  const [dir, setDir] = useState<string | null>(null)
  const [items, setItems] = useState<{ name: string; path: string; dir: boolean }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState("")
  const go = async (d: string) => { const r = await browseDir(d); if (r.ok) { setItems(r.data); setDir(d); setErr(null) } else setErr(r.message) }
  const add = (p: string) => { if (!paths.includes(p)) onChange([...paths, p]) }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {paths.length === 0 && <li className="text-xs text-muted-foreground">Henüz yol seçilmedi.</li>}
        {paths.map((p) => <li key={p} className="flex items-center gap-2 text-sm font-mono"><span className="break-all">{p}</span><button type="button" className="text-xs text-destructive" onClick={() => onChange(paths.filter((x) => x !== p))}>kaldır</button></li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <input className="rounded border bg-background px-2 py-1.5 text-sm font-mono flex-1 min-w-48" placeholder="/var/www/…" value={manual} onChange={(e) => setManual(e.target.value)} />
        <Button type="button" size="sm" variant="outline" onClick={() => { if (manual.trim()) { add(manual.trim()); setManual("") } }}>Ekle</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => go("/")}>Gözat</Button>
      </div>
      <p className="text-xs text-muted-foreground">İzinli kökler: {roots.join("  ")}. Dışındaki yollar reddedilir.</p>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {dir && (
        <div className="rounded border p-2 text-sm max-h-64 overflow-auto">
          <div className="flex items-center gap-2 mb-1 text-xs"><b className="font-mono">{dir}</b>{dir !== "/" && <button type="button" className="underline" onClick={() => go(dir.split("/").slice(0, -1).join("/") || "/")}>↑ üst</button>}{dir !== "/" && <button type="button" className="underline" onClick={() => add(dir)}>bu klasörü ekle</button>}</div>
          <ul>{items.map((i) => (
            <li key={i.path} className="flex items-center gap-2 py-0.5">
              {i.dir ? <button type="button" className="underline font-mono text-xs" onClick={() => go(i.path)}>📁 {i.name}</button> : <span className="font-mono text-xs">📄 {i.name}</span>}
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => add(i.path)}>+ ekle</button>
            </li>
          ))}</ul>
        </div>
      )}
    </div>
  )
}

function TablePicker({ tables, onChange }: { tables: string[]; onChange: (t: string[]) => void }) {
  const [all, setAll] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm">Seçili: <span className="font-mono text-xs">{tables.join(", ") || "(varsayılan 4 tablo)"}</span></div>
      <span><Button type="button" size="sm" variant="outline" onClick={async () => { const r = await loadTables(); if (r.ok) setAll(r.data); else setErr(r.message) }}>{all ? "Yenile" : "Tabloları listele"}</Button></span>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {all && <div className="grid gap-1 sm:grid-cols-2 md:grid-cols-3 max-h-64 overflow-auto rounded border p-2">{all.map((t) => <label key={t} className="flex items-center gap-2 text-xs font-mono"><input type="checkbox" checked={tables.includes(t)} onChange={() => onChange(tables.includes(t) ? tables.filter((x) => x !== t) : [...tables, t])} />{t}</label>)}</div>}
    </div>
  )
}

export function JobForm({ initial, isNew, targets, otherJobs, roots }: { initial: Job; isNew: boolean; targets: Target[]; otherJobs: { id: string; name: string; type: string }[]; roots: string[] }) {
  const [job, setJob] = useState<Job>(initial)
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const router = useRouter()
  const set = (p: Partial<Job>) => setJob((j) => ({ ...j, ...p }))
  const setOpt = (p: Job["options"]) => setJob((j) => ({ ...j, options: { ...j.options, ...p } }))
  const typeInfo = TYPES.find((t) => t.id === job.type)

  const submit = () => start(async () => {
    const payload: Job = { ...job, id: job.id || slug(job.name), name: job.name || typeInfo?.label || job.id }
    const r = await saveJob(payload, isNew)
    setMsg({ ok: r.ok, text: r.message ?? "" })
    if (r.ok) { router.push("/backup"); router.refresh() }
  })

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Görev adı
          <input className="rounded border bg-background px-2 py-1.5" value={job.name} onChange={(e) => set({ name: e.target.value, ...(isNew && !initial.id ? { id: slug(e.target.value) } : {}) })} placeholder="Örn. Haftalık tam kod yedeği" />
        </label>
        <label className="flex flex-col gap-1 text-sm">Kimlik <span className="text-xs text-muted-foreground">(arşiv adlarının öneki; sonradan değişmez)</span>
          <input className="rounded border bg-background px-2 py-1.5 font-mono disabled:opacity-60" value={job.id} disabled={!isNew} onChange={(e) => set({ id: slug(e.target.value) })} />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold">Ne yedeklensin?</div>
        <div className="grid gap-2 md:grid-cols-2">
          {TYPES.map((t) => (
            <button type="button" key={t.id} disabled={!isNew} onClick={() => setJob((j) => ({ ...j, type: t.id, options: t.id === "custom" ? { paths: [] } : t.id === "tables" ? { tables: ["transactions", "transaction_payment_entries", "journals", "journal_entries"] } : t.id === "db" ? { includePgbackrest: false } : {} }))}
              className={cn("rounded-md border p-3 text-left text-sm", job.type === t.id ? "border-primary bg-primary/5" : "hover:bg-muted", !isNew && "cursor-default opacity-80")}>
              <div className="font-medium">{t.label}</div><div className="text-xs text-muted-foreground mt-0.5">{t.hint}</div>
            </button>
          ))}
        </div>
        {!isNew && <p className="text-xs text-muted-foreground">Görev türü sonradan değiştirilemez; farklı tür için yeni görev ekle.</p>}
      </div>

      {job.type === "custom" && <div><div className="text-sm font-semibold mb-2">Yollar</div><PathPicker paths={job.options.paths ?? []} roots={roots} onChange={(paths) => setOpt({ paths })} /></div>}
      {job.type === "tables" && <div><div className="text-sm font-semibold mb-2">Tablolar</div><TablePicker tables={job.options.tables ?? []} onChange={(tables) => setOpt({ tables })} /></div>}
      {job.type === "db" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!job.options.includePgbackrest} onChange={(e) => setOpt({ includePgbackrest: e.target.checked })} /> pgBackRest deposunu (PITR/WAL) da bu göreve ekle <span className="text-xs text-muted-foreground">(ayrı “pitr” görevi varsa gerekmez)</span></label>}
      {job.type === "verify" && (
        <label className="flex flex-col gap-1 text-sm max-w-md">Okunabilirliği sınanacak görev
          <select className="rounded border bg-background px-2 py-1.5" value={job.options.checkJobId ?? ""} onChange={(e) => setOpt({ checkJobId: e.target.value || undefined })}>
            <option value="">Otomatik (tables, yoksa db)</option>
            {otherJobs.filter((j) => j.type === "tables" || j.type === "db").map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </label>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold">Hedefler <span className="text-xs font-normal text-muted-foreground">(birden fazla seçersen aynı döküm hepsine gider)</span></div>
        {targets.length === 0 ? <p className="text-sm text-muted-foreground">Önce bir hedef ekle (Hedefler sayfası).</p> : (
          <div className="flex flex-wrap gap-4">{targets.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={job.targets.includes(t.id)} onChange={() => set({ targets: job.targets.includes(t.id) ? job.targets.filter((x) => x !== t.id) : [...job.targets, t.id] })} />{t.name} {!t.enabled && <span className="text-xs text-amber-600">(durdurulmuş)</span>}</label>
          ))}</div>
        )}
      </div>

      <ScheduleEditor value={job.schedule.source as ScheduleInput} onChange={(source) => set({ schedule: { ...job.schedule, source } })} />

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Gelişmiş</summary>
        <div className="mt-2 flex flex-col gap-3">
          <label className="flex flex-col gap-1 max-w-xs">Gecikme toleransı (dk) <span className="text-xs text-muted-foreground">Planlı zamandan bu kadar sonra yedek yoksa uyarı gelir.</span>
            <input type="number" min={5} max={1440} className="rounded border bg-background px-2 py-1.5" value={job.graceMin} onChange={(e) => set({ graceMin: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">Hariç tutulacak desenler (satır başına bir)
            <textarea className="rounded border bg-background px-2 py-1.5 font-mono text-xs h-24" value={(job.options.excludes ?? []).join("\n")} onChange={(e) => setOpt({ excludes: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} placeholder={"*/node_modules\n*.tmp"} />
          </label>
        </div>
      </details>

      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={job.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Görev etkin</label>

      <div className="flex items-center gap-3">
        <Button disabled={pending || !job.targets.length || !(job.name || job.id)} onClick={submit}>{pending ? "Kaydediliyor…" : isNew ? "Görevi oluştur" : "Kaydet"}</Button>
        <Button variant="outline" onClick={() => router.push("/backup")}>Vazgeç</Button>
        {msg && <span className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{msg.text}</span>}
      </div>
    </div>
  )
}
