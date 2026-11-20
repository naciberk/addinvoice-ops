"use client"

import { useEffect, useRef, useState } from "react"
import { Download } from "lucide-react"

type Job = { id: string; kind: string; label: string; actor: { email: string }; state: "running" | "done" | "failed"; startedAt: number; endedAt: number | null; log: string[]; result: unknown; secret: string | null }

const stateText = { running: "çalışıyor…", done: "tamamlandı", failed: "başarısız" }

export function JobsBox() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState<string | null>(null)
  const secrets = useRef<Record<string, string>>({}) // parola yalnız ilk yanıtta gelir → bellekte tut

  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const r = await fetch("/api/jobs", { cache: "no-store" })
        const j = await r.json()
        if (stop) return
        if (j.ok) {
          for (const x of j.data as Job[]) if (x.secret) secrets.current[x.id] = x.secret
          setJobs(j.data)
          setErr(null)
        } else setErr(j.error ?? "Ajana ulaşılamadı")
      } catch {
        if (!stop) setErr("Bağlantı hatası")
      }
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  if (err) return <p className="text-sm text-destructive">İşler okunamadı: {err}</p>
  if (!jobs.length) return <p className="text-sm text-muted-foreground">Ajan başladığından beri çalıştırılmış iş yok.</p>
  return (
    <ul className="flex flex-col gap-3">
      {jobs.map((j) => {
        const res = j.result as { file?: string; size?: number } | string | null
        const file = typeof res === "object" && res?.file ? res.file : null
        return (
          <li key={j.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{j.label}</span>
              <span className={j.state === "failed" ? "text-destructive" : j.state === "done" ? "text-emerald-700" : "text-amber-600"}>{stateText[j.state]}</span>
            </div>
            <div className="text-xs text-muted-foreground">{j.actor.email} · {new Date(j.startedAt).toLocaleString("da-DK")}</div>
            {typeof res === "string" && <div className="text-xs mt-1">{res}</div>}
            {file && (
              <div className="mt-2 flex flex-col gap-1">
                <a href={`/api/download/${file}`} className="inline-flex items-center gap-1 underline text-sm"><Download className="w-4 h-4" /> {file}</a>
                {secrets.current[j.id] ? (
                  <div className="rounded bg-amber-50 border border-amber-300 p-2 text-xs">
                    <b>Şifre çözme parolası (bir kez gösterilir, kaydet):</b>
                    <div className="font-mono select-all text-sm mt-1">{secrets.current[j.id]}</div>
                    <div className="mt-1 text-muted-foreground">Açmak için: <span className="font-mono">openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in {file} | tar x</span> · dosya 24 saat sonra silinir.</div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">Parola daha önce gösterildi (tekrar gösterilmez). Kaybolduysa dışa aktarmayı yenile.</div>
                )}
              </div>
            )}
            {j.state === "failed" && j.log.length > 0 && <pre className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{j.log.slice(-3).join("\n")}</pre>}
          </li>
        )
      })}
    </ul>
  )
}
