import Link from "next/link"
import { HelpCircle } from "lucide-react"

/** Küçük "?" bağlantısı: Rehber sayfasında ilgili bölüme götürür (ne işe yarar / tıklarsam ne olur / dikkat). */
export function HelpLink({ id, label }: { id: string; label?: string }) {
  return (
    <Link href={`/help#${id}`} title="Bu ne işe yarar? Tıklarsam ne olur?" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
      <HelpCircle className="w-3.5 h-3.5" />
      {label ?? "Bu ne?"}
    </Link>
  )
}
