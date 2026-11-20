"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { changeRole, resetUserAccess, revokeInvite, setDisabled } from "@/app/(panel)/actions"
import { ROLE_LABEL } from "@/lib/roles"
import type { Role } from "@/lib/store"

export function UserActions({ id, role, disabled, self }: { id: string; role: Role; disabled: boolean; self: boolean }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; message?: string; link?: string } | null>(null)
  const run = (fn: () => Promise<{ ok: boolean; message?: string; link?: string }>) => start(async () => setMsg(await fn().catch((e) => ({ ok: false, message: String(e?.message ?? e) }))))
  if (self) return <span className="text-xs text-muted-foreground">(sen)</span>
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <select className="h-8 rounded-md border bg-background px-1 text-xs" value={role} disabled={pending} onChange={(e) => confirm("Rol değişsin mi? Kullanıcının oturumları kapanır.") && run(() => changeRole(id, e.target.value))}>
          {(["viewer", "operator", "admin"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => confirm("Bu kullanıcının parolası ve 2FA'sı sıfırlanacak (yeni bağlantı üretilir). Devam?") && run(() => resetUserAccess(id))}>Erişimi sıfırla</Button>
        <Button size="sm" variant={disabled ? "default" : "destructive"} disabled={pending} onClick={() => confirm(disabled ? "Tekrar etkinleştirilsin mi?" : "Devre dışı bırakılsın mı? Oturumları kapanır.") && run(() => setDisabled(id, !disabled))}>{disabled ? "Etkinleştir" : "Devre dışı"}</Button>
      </div>
      {msg?.message && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{msg.message}</span>}
      {msg?.link && <div className="font-mono text-xs break-all select-all bg-amber-50 border border-amber-300 rounded p-2">{msg.link}</div>}
    </div>
  )
}

export function RevokeInvite({ id }: { id: string }) {
  const [pending, start] = useTransition()
  return <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => void (await revokeInvite(id)))}>İptal</Button>
}
