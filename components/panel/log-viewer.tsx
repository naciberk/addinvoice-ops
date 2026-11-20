"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { loadLog } from "@/app/(panel)/services/actions"

export function LogViewer({ sources }: { sources: { key: string; label: string }[] }) {
  const [src, setSrc] = useState(sources[0]?.key ?? "")
  const [lines, setLines] = useState(200)
  const [text, setText] = useState<string>("")
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const load = () =>
    start(async () => {
      const r = await loadLog(src, lines)
      if (r.ok) { setText(r.text ?? ""); setErr(null) } else setErr(r.message ?? "Hata")
    })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={src} onChange={(e) => setSrc(e.target.value)}>
          {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
          {[100, 200, 500].map((n) => <option key={n} value={n}>son {n} satır</option>)}
        </select>
        <Button size="sm" onClick={load} disabled={pending}>{pending ? "…" : "Yükle"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Günlükler kişisel veri içerebilir; her görüntüleme denetim kaydına yazılır.</p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {text && <pre className="max-h-[520px] overflow-auto rounded-md bg-gray-950 text-gray-100 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">{text}</pre>}
    </div>
  )
}
