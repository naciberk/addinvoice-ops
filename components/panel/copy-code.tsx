"use client"

import { Check, Copy } from "lucide-react"
import { useState } from "react"

export function CopyCode({ code }: { code: string }) {
  const [ok, setOk] = useState(false)
  return (
    <div className="relative">
      <pre className="rounded-md bg-gray-950 text-gray-100 p-3 pr-10 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
      <button
        type="button"
        aria-label="Kopyala"
        className="absolute top-2 right-2 text-gray-400 hover:text-white"
        onClick={() => {
          navigator.clipboard.writeText(code).then(() => {
            setOk(true)
            setTimeout(() => setOk(false), 1500)
          })
        }}
      >
        {ok ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  )
}
