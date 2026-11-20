"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cancelLogin, passwordStep, totpStep, type LoginState } from "./actions"

export function LoginForm({ pending }: { pending: boolean }) {
  const [s1, act1, p1] = useActionState<LoginState, FormData>(passwordStep, {})
  const [s2, act2, p2] = useActionState<LoginState, FormData>(totpStep, {})
  // Parola doğrulandıysa (veya sayfa 'pwd' oturumuyla açıldıysa) 2. adım
  const showTotp = (pending || s1.stage === "totp" || s2.stage === "totp") && s2.stage !== "pwd"

  if (showTotp) {
    return (
      <form action={act2} className="flex flex-col gap-4 w-full">
        <div className="text-sm text-muted-foreground text-center">
          Kimlik doğrulama uygulamandaki 6 haneli kodu gir (veya bir kurtarma kodu).
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Doğrulama kodu</Label>
          <Input id="code" name="code" inputMode="text" autoComplete="one-time-code" autoFocus required placeholder="123456" className="text-center text-lg tracking-widest" />
        </div>
        {s2.error && <p className="text-sm text-destructive">{s2.error}</p>}
        <Button type="submit" disabled={p2}>{p2 ? "Doğrulanıyor…" : "Giriş yap"}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => cancelLogin()}>Geri</Button>
      </form>
    )
  }
  return (
    <form action={act1} className="flex flex-col gap-4 w-full">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-posta</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Parola</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {(s1.error || s2.error) && <p className="text-sm text-destructive">{s1.error || s2.error}</p>}
      <Button type="submit" disabled={p1}>{p1 ? "Kontrol ediliyor…" : "Devam"}</Button>
    </form>
  )
}
