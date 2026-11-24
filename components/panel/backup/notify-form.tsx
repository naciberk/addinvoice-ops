"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { saveNotify, sendNotifyTest } from "@/app/(panel)/backup/actions"
import type { NotifySettings } from "@/lib/backup-types"

const DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]
const MINUTES = [0, 15, 30, 45]
const pad = (n: number) => String(n).padStart(2, "0")
const input = "rounded border bg-background px-2 py-1.5 text-sm"

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input className="mt-1" type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
    </label>
  )
}
function TimeSelect({ hour, minute, onChange, disabled }: { hour: number; minute: number; onChange: (h: number, m: number) => void; disabled?: boolean }) {
  const mins = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort((a, b) => a - b)
  return (
    <span className="inline-flex items-center gap-1">
      <select className={input} disabled={disabled} value={hour} onChange={(e) => onChange(Number(e.target.value), minute)}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{pad(h)}</option>)}</select>
      :
      <select className={input} disabled={disabled} value={minute} onChange={(e) => onChange(hour, Number(e.target.value))}>{mins.map((m) => <option key={m} value={m}>{pad(m)}</option>)}</select>
    </span>
  )
}
function Block({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return <div className="rounded-md border p-3 flex flex-col gap-3"><div><div className="text-sm font-semibold">{title}</div>{sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}</div>{children}</div>
}

export function NotifyForm({ initial, targets, canEdit }: { initial: NotifySettings; targets: { id: string; name: string }[]; canEdit: boolean }) {
  const [n, setN] = useState<NotifySettings>(initial)
  const [emails, setEmails] = useState(initial.recipients.join("\n"))
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (p: Partial<NotifySettings>) => { setN((x) => ({ ...x, ...p })); setMsg(null) }
  const parsed = emails.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
  const anyOn = n.alert.enabled || n.daily.enabled || n.weekly.enabled
  const dis = !canEdit || pending
  const payload = (): NotifySettings => ({ ...n, recipients: parsed })
  const report = (r: { ok: boolean; message?: string }) => setMsg({ ok: r.ok, text: r.message ?? (r.ok ? "Tamam." : "Hata") })

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      {!initial.configured && <p className="rounded-md border border-amber-300 bg-amber-50 text-amber-950 p-3 text-sm">Bildirimler henüz <b>kaydedilmedi</b>: şu an yalnızca izleyicinin eski genel uyarısı çalışıyor (tek adres, sabit sıklık). Aşağıdaki ayarı kaydedince yedek uyarıları buradan yönetilir.</p>}

      <Block title="Kime gitsin?" sub="Her satıra bir e-posta adresi (en çok 10). Üç bildirim türünün hepsi bu adreslere gider.">
        <textarea className={input + " min-h-20 font-mono"} disabled={dis} value={emails} onChange={(e) => { setEmails(e.target.value); setMsg(null) }} placeholder={"ornek@firma.dk\nbaska@firma.dk"} />
        <p className="text-xs text-muted-foreground">{parsed.length} adres</p>
      </Block>

      <Block title="1) Hata uyarısı" sub="Bir yedek başarısız olunca veya planlı zamanda alınmayınca e-posta. Aynı turda birden çok sorun tek e-postada toplanır; aynı sorun için tekrar tekrar e-posta gelmez (günlük özet hatırlatır).">
        <Check checked={n.alert.enabled} disabled={dis} onChange={(v) => set({ alert: { ...n.alert, enabled: v } })} label="Hata olunca e-posta gönder" />
        {n.alert.enabled && <>
          <label className="flex flex-wrap items-center gap-2 text-sm">Kaç kez art arda başarısız olunca haber ver?
            <select className={input} disabled={dis} value={n.alert.afterFailures} onChange={(e) => set({ alert: { ...n.alert, afterFailures: Number(e.target.value) } })}>
              <option value={1}>1 — hemen (en hassas)</option><option value={2}>2 (önerilen)</option><option value={3}>3</option><option value={5}>5</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">Sık çalışan görevlerde tek seferlik geçici bir hata (ağ kesintisi gibi) gereksiz alarm üretmesin diye 2 önerilir. Haber, izleyicinin 15 dakikalık turunda gider (en geç ~15 dk).</p>
          <Check checked={n.alert.recovery} disabled={dis} onChange={(v) => set({ alert: { ...n.alert, recovery: v } })} label="Sorun giderilince “düzeldi” e-postası gönder" />
        </>}
      </Block>

      <Block title="2) Günlük özet" sub="Her gün seçtiğin saatte son 24 saatin tablosu: hangi görev, hangi hedefe, kaç kez, ne kadar yeni veri.">
        <Check checked={n.daily.enabled} disabled={dis} onChange={(v) => set({ daily: { ...n.daily, enabled: v } })} label="Günlük özet gönder" />
        {n.daily.enabled && <>
          <label className="flex flex-wrap items-center gap-2 text-sm">Saat (Danimarka saati): <TimeSelect hour={n.daily.hour} minute={n.daily.minute} disabled={dis} onChange={(h, m) => set({ daily: { ...n.daily, hour: h, minute: m } })} /></label>
          <Check checked={!n.daily.onlyOnProblems} disabled={dis} onChange={(v) => set({ daily: { ...n.daily, onlyOnProblems: !v } })} label="Sorun olmayan günlerde de gönder (önerilen)" hint="Her sabah geliyorsa sistem ayakta ve yedekler sağlam demektir. Özet gelmeyen gün, izleyicinin kendisinde sorun var demektir." />
        </>}
      </Block>

      <Block title="3) Haftalık özet" sub="Son 7 günün özeti (hedef başına toplam çalışma, hata ve eklenen veri).">
        <Check checked={n.weekly.enabled} disabled={dis} onChange={(v) => set({ weekly: { ...n.weekly, enabled: v } })} label="Haftalık özet gönder" />
        {n.weekly.enabled && (
          <label className="flex flex-wrap items-center gap-2 text-sm">Gün ve saat:
            <select className={input} disabled={dis} value={n.weekly.weekday} onChange={(e) => set({ weekly: { ...n.weekly, weekday: Number(e.target.value) } })}>{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
            <TimeSelect hour={n.weekly.hour} minute={n.weekly.minute} disabled={dis} onChange={(h, m) => set({ weekly: { ...n.weekly, hour: h, minute: m } })} />
          </label>
        )}
      </Block>

      <Block title="İkincil hedefler" sub="Seçtiğin hedeflerdeki sorunlar e-postada “uyarı (ikincil hedef)” olarak işaretlenir, diğerleri “KRİTİK”. Ana yedeğin dışındaki ek kopyalar (ör. NAS) için kullan; NAS kapalıysa panik olmasın ama haberin olsun.">
        <div className="flex flex-wrap gap-4">
          {targets.map((t) => <Check key={t.id} checked={n.secondary.includes(t.id)} disabled={dis} label={t.name} onChange={(v) => set({ secondary: v ? [...n.secondary, t.id] : n.secondary.filter((x) => x !== t.id) })} />)}
          {!targets.length && <span className="text-sm text-muted-foreground">Hedef yok.</span>}
        </div>
      </Block>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={pending || (anyOn && parsed.length === 0)} onClick={() => start(async () => { const r = await saveNotify(payload()); if (r.ok) { setN(r.data); setEmails(r.data.recipients.join("\n")) } report(r) })}>{pending ? "Kaydediliyor…" : "Kaydet"}</Button>
          <Button variant="outline" disabled={pending || !initial.configured || initial.recipients.length === 0} onClick={() => start(async () => report(await sendNotifyTest("test")))}>Deneme maili gönder</Button>
          <Button variant="outline" disabled={pending || !initial.configured || initial.recipients.length === 0} onClick={() => start(async () => report(await sendNotifyTest("report")))}>Şimdi örnek özet gönder</Button>
        </div>
      )}
      {canEdit && <p className="text-xs text-muted-foreground">Deneme düğmeleri <b>kaydedilmiş</b> ayarı kullanır; önce Kaydet. Örnek özet gerçek verinle son 24 saati gösterir ve zamanlamayı etkilemez.</p>}
      {msg && <p className={"text-sm " + (msg.ok ? "text-emerald-700" : "text-destructive")}>{msg.text}</p>}
      {initial.savedAt && <p className="text-xs text-muted-foreground">Son kayıt: {new Date(initial.savedAt).toLocaleString("sv-SE")}{initial.savedBy ? ` · ${initial.savedBy}` : ""}</p>}
    </div>
  )
}
