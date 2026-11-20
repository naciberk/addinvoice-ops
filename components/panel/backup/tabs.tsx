"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export function BackupTabs({ admin }: { admin: boolean }) {
  const path = usePathname()
  const tabs = [
    { href: "/backup", label: "Görevler", match: (p: string) => p === "/backup" || p.startsWith("/backup/job") },
    { href: "/backup/targets", label: "Hedefler", match: (p: string) => p.startsWith("/backup/targets") },
    ...(admin ? [{ href: "/backup/restore", label: "Geri yükleme", match: (p: string) => p.startsWith("/backup/restore") }] : []),
    { href: "/backup/db", label: "Veritabanı (PITR)", match: (p: string) => p.startsWith("/backup/db") },
  ]
  return (
    <div className="flex flex-wrap gap-1 border-b">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={cn("px-4 py-2 text-sm -mb-px border-b-2", t.match(path) ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</Link>
      ))}
    </div>
  )
}
