"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { CopyCode } from "@/components/panel/copy-code"
import { TargetActions } from "@/components/panel/backup/buttons"
import { createTarget, type NewTargetResult } from "@/app/(panel)/backup/actions"

const slug = (s: string) => s.toLowerCase().replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30)

export function TargetWizard() {
  const [type, setType] = useState<"ssh" | "path">("ssh")
  const [auth, setAuth] = useState<"key" | "password">("key")
  const [f, setF] = useState({ name: "", id: "", host: "", port: "22", user: "borg", password: "", remotePath: "", repoPath: "/srv/backup/ana/repo", mountCheck: "" })
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const [res, setRes] = useState<NewTargetResult | null>(null)
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const input = "rounded border bg-background px-2 py-1.5 text-sm"

  if (res) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-950 p-3 text-sm">Hedef <b>{res.target.name}</b> oluşturuldu (henüz <b>durdurulmuş</b>). Aşağıdaki adımları hedef tarafta yap, sonra “Bağlantıyı sına” ve “Depoyu başlat”.</div>
        {res.passphrase && (
          <div className="rounded-md border border-amber-400 bg-amber-50 text-amber-950 p-3 text-sm flex flex-col gap-2">
            <b>Depo şifreleme parolası — YALNIZ BİR KEZ gösterilir.</b>
            <span>Hemen parola yöneticine kaydet. Kaybedersen bu hedefteki yedekler <b>açılamaz</b>. Sunucuda root-only dosyada da durur, ama sunucu giderse o da gider.</span>
            <CopyCode code={res.passphrase} />
          </div>
        )}
        {res.fingerprint && <p className="text-xs">Sunucu parmak izi — hedefte <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> çıktısıyla <b>aynı olmalı</b>: <code className="break-all">{res.fingerprint}</code></p>}
        <div><div className="text-sm font-medium mb-1">Hedef tarafta yapılacaklar</div><CopyCode code={res.setup} /></div>
        <TargetActions t={res.target} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex flex-wrap gap-3">
        {([["ssh", "Linux sunucu / NAS (SSH + borg)", "Önerilen: append-only koruma, istemci tarafı şifreleme."], ["path", "Bağlı klasör (NAS paylaşımı, USB/ayrı disk)", "Bu sunucuya bağlı bir yola yazar. Append-only yok → NAS anlık görüntüsü şart."]] as const).map(([k, l, h]) => (
          <button type="button" key={k} onClick={() => { setType(k); set({ repoPath: k === "ssh" ? "/srv/backup/ana/repo" : "/mnt/nas-backup/borg-repo" }) }} className={"flex-1 min-w-64 rounded-md border p-3 text-left text-sm " + (type === k ? "border-primary bg-primary/5" : "hover:bg-muted")}>
            <div className="font-medium">{l}</div><div className="text-xs text-muted-foreground mt-0.5">{h}</div>
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Ad<input className={input} value={f.name} onChange={(e) => set({ name: e.target.value, id: slug(e.target.value) })} placeholder="Örn. Synology NAS" /></label>
        <label className="flex flex-col gap-1 text-sm">Kimlik<input className={input + " font-mono"} value={f.id} onChange={(e) => set({ id: slug(e.target.value) })} /></label>
        {type === "ssh" && <div className="md:col-span-2 flex flex-wrap gap-3">
          {([["key", "SSH anahtarı (önerilen)", "Panel anahtar üretir; hedefte append-only koruma kurulabilir."], ["password", "Kullanıcı adı + parola", "NAS hesabının parolasıyla bağlanır. Append-only koruma yoktur."]] as const).map(([k, l, h]) => (
            <button type="button" key={k} onClick={() => { setAuth(k); set({ user: k === "key" ? "borg" : "" }) }} className={"flex-1 min-w-56 rounded-md border p-2 text-left text-sm " + (auth === k ? "border-primary bg-primary/5" : "hover:bg-muted")}>
              <div className="font-medium">{l}</div><div className="text-xs text-muted-foreground mt-0.5">{h}</div>
            </button>
          ))}
        </div>}
        {type === "ssh" && <>
          <label className="flex flex-col gap-1 text-sm">Sunucu (IP veya ad)<input className={input} value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="185.x.x.x" /></label>
          <label className="flex flex-col gap-1 text-sm">SSH portu<input className={input} value={f.port} onChange={(e) => set({ port: e.target.value })} /></label>
          <label className="flex flex-col gap-1 text-sm">Hedefte kullanıcı<input className={input} value={f.user} onChange={(e) => set({ user: e.target.value })} /></label>
          <label className="flex flex-col gap-1 text-sm">Uzak borg yolu <span className="text-xs text-muted-foreground">(isteğe bağlı; Synology için /usr/local/bin/borg)</span><input className={input + " font-mono"} value={f.remotePath} onChange={(e) => set({ remotePath: e.target.value })} placeholder="/usr/local/bin/borg" /></label>
          {auth === "password" && <label className="flex flex-col gap-1 text-sm">Parola <span className="text-xs text-muted-foreground">(bu sunucuda yalnız root okuyabilen dosyada saklanır; ekranda bir daha gösterilmez)</span><input className={input} type="password" autoComplete="new-password" value={f.password} onChange={(e) => set({ password: e.target.value })} /></label>}
        </>}
        <label className="flex flex-col gap-1 text-sm md:col-span-2">Depo yolu {type === "ssh" ? "(hedef sunucuda)" : "(bu sunucuda)"}<input className={input + " font-mono"} value={f.repoPath} onChange={(e) => set({ repoPath: e.target.value })} /></label>
        {type === "path" && <label className="flex flex-col gap-1 text-sm md:col-span-2">Bağlama denetimi <span className="text-xs text-muted-foreground">(paylaşımın bağlanacağı yol; bağlı değilse yedek yerel diske YAZILMAZ)</span><input className={input + " font-mono"} value={f.mountCheck} onChange={(e) => set({ mountCheck: e.target.value })} placeholder="/mnt/nas-backup" /></label>}
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div><Button disabled={pending || !f.id || !f.name || (type === "ssh" && auth === "password" && (!f.user || !f.password))} onClick={() => start(async () => {
        setErr(null)
        const r = await createTarget({ id: f.id, name: f.name, type, repoPath: f.repoPath, ...(type === "ssh" ? { host: f.host, port: Number(f.port), user: f.user, auth, ...(f.remotePath ? { remotePath: f.remotePath } : {}) } : { mountCheck: f.mountCheck || undefined }) }, type === "ssh" && auth === "password" ? f.password : undefined)
        if (r.ok) setRes(r.data); else setErr(r.message)
      })}>{pending ? "Oluşturuluyor…" : "Hedefi oluştur ve kurulum adımlarını göster"}</Button></div>
    </div>
  )
}
