"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, Archive, Building2, Database, Gauge, HelpCircle, LogOut, ScrollText, Server, Users, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"
import { logout } from "@/app/(auth)/login/actions"

const ICONS = { activity: Activity, archive: Archive, database: Database, building: Building2, server: Server, users: Users, scroll: ScrollText, gauge: Gauge, wrench: Wrench, help: HelpCircle }
export type NavItem = { href: string; label: string; icon: keyof typeof ICONS }

export function Nav({ items, name, role }: { items: NavItem[]; name: string; role: string }) {
  const path = usePathname()
  return (
    <aside className="md:w-60 shrink-0 md:min-h-screen bg-gray-900 text-gray-100 flex md:flex-col gap-1 p-3 overflow-x-auto md:overflow-visible">
      <div className="hidden md:flex items-center gap-2 px-2 py-3 mb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="" className="w-8 h-8 rounded" />
        <div>
          <div className="font-semibold leading-tight">AddInvoice Ops</div>
          <div className="text-xs text-gray-400">ops.addinvoice.dk</div>
        </div>
      </div>
      <nav className="flex md:flex-col gap-1 md:flex-1">
        {items.map((it) => {
          const Icon = ICONS[it.icon]
          const active = it.href === "/" ? path === "/" : (path === it.href || path.startsWith(it.href + "/"))
          return (
            <Link
              key={it.href}
              href={it.href}
              className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors", active ? "bg-gray-700 text-white" : "text-gray-300 hover:bg-gray-800")}
            >
              <Icon className="w-4 h-4" />
              {it.label}
            </Link>
          )
        })}
      </nav>
      <div className="hidden md:block border-t border-gray-700 pt-3 mt-2 px-2">
        <div className="text-sm truncate">{name}</div>
        <div className="text-xs text-gray-400 mb-2">{role}</div>
        <form action={logout}>
          <button className="flex items-center gap-2 text-sm text-gray-300 hover:text-white">
            <LogOut className="w-4 h-4" /> Çıkış
          </button>
        </form>
      </div>
      <form action={logout} className="md:hidden ml-auto">
        <button className="px-3 py-2 text-gray-300" aria-label="Çıkış"><LogOut className="w-4 h-4" /></button>
      </form>
    </aside>
  )
}
