"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { configApply, configRead, configRollback } from "@/app/(panel)/actions"

export type CfgFile = { key: string; label: string; path: string; size: number; backups: string[] }

// Satır satır fark (LCS): yalnız eklenen/silinen satırları gösterir — "ne uygulayacağım?" gözle görülsün.
function diffLines(a: string[], b: string[]): { t: "+" | "-" | " "; s: string }[] {
  const n = a.length, m = b.length
  if (n * m > 4_000_000) return [{ t: " ", s: "(dosya çok büyük, fark gösterilemiyor)" }]
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: "+" | "-" | " "; s: string }[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: a[i++] })
    else out.push({ t: "+", s: b[j++] })
  }
  while (i < n) out.push({ t: "-", s: a[i++] })
  while (j < m) out.push({ t: "+", s: b[j++] })
  return out
}

const fmtStamp = (s: string) => `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`

export function ConfigEditor({ files }: { files: CfgFile[] }) {
  const [key, setKey] = useState(files[0]?.key ?? "")
  const [orig, setOrig] = useState("")
  const [text, setText] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; message?: string } | null>(null)
  const [pending, start] = useTransition()
  const file = files.find((f) => f.key === key)

  const load = (k: string, backup?: string) =>
    start(async () => {
      const r = await configRead(k, backup).catch((e) => ({ ok: false, message: String(e?.message ?? e) }) as { ok: boolean; content?: string; message?: string })
      if (r.ok && r.content !== undefined) {
        if (!backup) setOrig(r.content)
        setText(r.content)
        setLoaded(true)
        setMsg(backup ? { ok: true, message: `Yedek ${fmtStamp(backup)} editöre yüklendi (henüz uygulanmadı).` } : null)
      } else setMsg({ ok: false, message: r.message })
    })

  const changed = loaded && text !== orig
  const diff = changed ? diffLines(orig.split("\n"), text.split("\n")).filter((d) => d.t !== " ") : []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={key} onChange={(e) => { setKey(e.target.value); setLoaded(false); setMsg(null); setText(""); setOrig("") }}>
          {files.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => load(key)}>{loaded ? "Yeniden oku" : "Dosyayı aç"}</Button>
        {file && <span className="text-xs text-muted-foreground font-mono">{file.path}</span>}
      </div>

      {loaded && (
        <>
          <textarea
            className="w-full h-[28rem] rounded-md border bg-background p-3 font-mono text-xs leading-relaxed"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {changed && (
            <div className="rounded-md border">
              <div className="text-xs font-medium px-3 py-2 border-b bg-muted">Değişiklikler ({diff.filter((d) => d.t === "+").length} satır eklendi, {diff.filter((d) => d.t === "-").length} satır silindi)</div>
              <pre className="p-3 text-xs overflow-x-auto max-h-64">
                {diff.map((d, i) => <div key={i} className={d.t === "+" ? "text-emerald-700 bg-emerald-50" : "text-red-700 bg-red-50"}>{d.t} {d.s}</div>)}
              </pre>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={pending || !changed} onClick={() => start(async () => setMsg(await configApply(key, text, true).catch((e) => ({ ok: false, message: String(e?.message ?? e) }))))}>Doğrula (kaydetmeden dene)</Button>
            <Button
              size="sm"
              disabled={pending || !changed}
              onClick={() => {
                if (!window.confirm(`${file?.label}\n\nDeğişiklik uygulanacak: yedek alınır, doğrulanır, servis reload edilir; sağlık kontrolü başarısızsa otomatik geri alınır.\n\nDevam?`)) return
                start(async () => {
                  const r = await configApply(key, text, false).catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
                  setMsg(r)
                  if (r.ok) load(key)
                })
              }}
            >
              Doğrula ve uygula
            </Button>
            {pending && <span className="text-xs text-muted-foreground">çalışıyor…</span>}
          </div>
        </>
      )}

      {msg?.message && <p className={"text-sm rounded-md border p-3 " + (msg.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900")}>{msg.message}</p>}

      {file && (
        <div>
          <div className="text-sm font-medium mb-1">Yedekler ({file.backups.length})</div>
          {!file.backups.length ? <p className="text-xs text-muted-foreground">Bu dosya için henüz yedek yok (ilk uygulamada oluşur).</p> : (
            <ul className="flex flex-col gap-1">
              {file.backups.slice(0, 10).map((b) => (
                <li key={b} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs">{fmtStamp(b)}</span>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => load(key, b)}>Editöre yükle</Button>
                  <Button size="sm" variant="destructive" disabled={pending} onClick={() => window.confirm(`${fmtStamp(b)} tarihli yedeğe geri dönülsün mü? (Mevcut hal de yedeklenir.)`) && start(async () => setMsg(await configRollback(key, b).catch((e) => ({ ok: false, message: String(e?.message ?? e) }))))}>Bu yedeğe geri dön</Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground mt-2">Sayfa yenilenince yeni yedekler listede görünür.</p>
        </div>
      )}
    </div>
  )
}
