"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createRestorePoint } from "@/app/(panel)/actions"

export function RestorePointForm() {
  const [name, setName] = useState("")
  const [msg, setMsg] = useState<{ ok: boolean; message?: string } | null>(null)
  const [pending, start] = useTransition()
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        start(async () => {
          const r = await createRestorePoint(name.trim()).catch((x) => ({ ok: false, message: String(x?.message ?? x) }))
          setMsg(r)
          if (r.ok) setName("")
        })
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="ör. oncesi-buyuk-guncelleme" className="max-w-xs" maxLength={40} />
      <Button type="submit" size="sm" variant="outline" disabled={pending || name.trim().length < 3}>{pending ? "…" : "Restore noktası oluştur"}</Button>
      {msg?.message && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{msg.message}</span>}
    </form>
  )
}
