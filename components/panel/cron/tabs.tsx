"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export function CronTabs({ admin }: { admin: boolean }) {
  const path = usePathname()
  const tabs = [
    { href: "/cron", label: "Görevler", match: (p: string) => p === "/cron" || p.startsWith("/cron/job") },
    { href: "/cron/grid", label: "Çakışma haritası", match: (p: string) => p.startsWith("/cron/grid") },
    { href: "/cron/system", label: "Sistem cron'ları", match: (p: string) => p.startsWith("/cron/system") },
    ...(admin ? [{ href: "/cron/migrate", label: "Taşıma ve zamanlayıcı", match: (p: string) => p.startsWith("/cron/migrate") }] : []),
  ]
  return (
    <div className="flex flex-wrap gap-1 border-b">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={cn("px-4 py-2 text-sm -mb-px border-b-2", t.match(path) ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</Link>
      ))}
    </div>
  )
}
