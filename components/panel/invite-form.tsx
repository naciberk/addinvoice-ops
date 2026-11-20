"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createInvite } from "@/app/(panel)/actions"
import { ROLE_HELP, ROLE_LABEL } from "@/lib/roles"

export function InviteForm() {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("viewer")
  const [res, setRes] = useState<{ ok: boolean; message?: string; link?: string } | null>(null)
  const [pending, start] = useTransition()
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          start(async () => setRes(await createInvite(email, role).catch((x) => ({ ok: false, message: String(x?.message ?? x) }))))
        }}
      >
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="kisi@ornek.dk" className="max-w-xs" />
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
          {(["viewer", "operator", "admin"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <Button type="submit" disabled={pending}>{pending ? "…" : "Davet bağlantısı oluştur"}</Button>
      </form>
      <p className="text-xs text-muted-foreground">{ROLE_HELP[role as keyof typeof ROLE_HELP]}</p>
      {res && !res.ok && <p className="text-sm text-destructive">{res.message}</p>}
      {res?.ok && res.link && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="font-medium mb-1">{res.message}</div>
          <div className="font-mono text-xs break-all select-all bg-white rounded border p-2">{res.link}</div>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => navigator.clipboard.writeText(res.link!)}>Kopyala</Button>
          <p className="text-xs text-muted-foreground mt-2">Bu bağlantı bir daha gösterilmez. Kişi kendi parolasını ve 2FA'sını bu bağlantıdan belirler.</p>
        </div>
      )}
    </div>
  )
}
