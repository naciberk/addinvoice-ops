"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/app/(panel)/actions"

/**
 * Onay isteyen eylem düğmesi. Sonuç mesajı düğmenin yanında gösterilir.
 * `typed`: tehlikeli işlemlerde kullanıcıdan bu metni AYNEN yazmasını ister (yanlışlıkla tıklamayı engeller).
 */
export function RunButton({ label, confirm, typed, action, variant = "outline", size = "sm" }: { label: string; confirm?: string; typed?: string; action: () => Promise<ActionResult>; variant?: "outline" | "default" | "destructive" | "secondary"; size?: "sm" | "default" }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<ActionResult | null>(null)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() => {
          if (typed) {
            const v = window.prompt(`${confirm ?? "Bu işlem etkiler."}\n\nDevam etmek için şunu aynen yaz: ${typed}`)
            if (v?.trim() !== typed) return
          } else if (confirm && !window.confirm(confirm)) return
          start(async () => setMsg(await action().catch((e) => ({ ok: false, message: String(e?.message ?? e) }))))
        }}
      >
        {pending ? "…" : label}
      </Button>
      {msg?.message && <span className={msg.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{msg.message}</span>}
    </span>
  )
}
