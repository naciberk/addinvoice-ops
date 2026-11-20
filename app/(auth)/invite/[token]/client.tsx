"use client"

import Link from "next/link"
import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { acceptInvite, type InviteState } from "./actions"

export function InviteForm({ token, kind, email, qr, secret }: { token: string; kind: "new" | "reset" | "enrol"; email: string; qr: string; secret: string }) {
  const [s, act, pending] = useActionState<InviteState, FormData>(acceptInvite.bind(null, token), {})

  if (s.done && s.recoveryCodes) {
    return (
      <div className="flex flex-col gap-4 w-full">
        <h2 className="font-semibold text-center">Hesap hazır ✔</h2>
        <p className="text-sm text-muted-foreground">
          Aşağıdaki <b>kurtarma kodlarını</b> güvenli bir yere kaydet. Telefonunu kaybedersen girişin tek yolu bunlardır. Her kod bir kez çalışır ve{" "}
          <b>bir daha gösterilmez</b>.
        </p>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-muted rounded-md p-3 select-all">
          {s.recoveryCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <Button asChild>
          <Link href="/login">Giriş sayfasına git</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={act} className="flex flex-col gap-4 w-full">
      <p className="text-sm text-muted-foreground">
        {kind === "new" ? "AddInvoice Ops hesabını oluştur: " : kind === "enrol" ? "İki adımlı doğrulamayı (2FA) kur — parolan mevcut hesabından aynen geçerli: " : "Parola ve 2FA'yı yenile: "}
        <b>{email}</b>
      </p>
      {kind === "new" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Ad soyad</Label>
          <Input id="name" name="name" required autoComplete="name" />
        </div>
      )}
      {kind !== "enrol" && (
        <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Parola (en az 12 karakter)</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={12} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password2">Parola (tekrar)</Label>
        <Input id="password2" name="password2" type="password" autoComplete="new-password" required minLength={12} />
      </div>
        </>
      )}
      <div className="rounded-md border p-3 flex flex-col items-center gap-2">
        <p className="text-sm text-center">Kimlik doğrulama uygulamanla (Google Authenticator, 1Password, Authy…) QR kodu tara:</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="2FA QR" width={180} height={180} className="bg-white rounded" />
        <p className="text-xs text-muted-foreground text-center break-all">
          Elle girmek için: <span className="font-mono select-all">{secret}</span>
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="code">Uygulamadaki 6 haneli kod</Label>
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required placeholder="123456" className="text-center tracking-widest" />
      </div>
      {s.error && <p className="text-sm text-destructive">{s.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Kaydediliyor…" : "Hesabı etkinleştir"}</Button>
    </form>
  )
}
