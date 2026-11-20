import { Nav, type NavItem } from "@/components/panel/nav"
import { requireSession } from "@/lib/auth"
import { can, ROLE_LABEL } from "@/lib/roles"

export const dynamic = "force-dynamic"

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession()
  const items: NavItem[] = [
    { href: "/", label: "Genel bakış", icon: "activity" },
    { href: "/backup", label: "Yedekleme", icon: "archive" },
    { href: "/database", label: "Veritabanı", icon: "database" },
    { href: "/companies", label: "Şirketler", icon: "building" },
    ...(can(user.role, "operator") ? [{ href: "/services", label: "Servisler ve günlükler", icon: "server" } as NavItem] : [{ href: "/services", label: "Servisler", icon: "server" } as NavItem]),
    { href: "/tuning", label: "Ayarlar (tuning)", icon: "gauge" },
    ...(can(user.role, "admin") ? ([{ href: "/config", label: "Yapılandırma", icon: "wrench" }, { href: "/users", label: "Kullanıcılar", icon: "users" }, { href: "/audit", label: "Denetim kaydı", icon: "scroll" }] as NavItem[]) : []),
    { href: "/help", label: "Rehber", icon: "help" },
  ]
  return (
    <div className="flex flex-col md:flex-row min-h-screen">
      <Nav items={items} name={user.name} role={ROLE_LABEL[user.role]} />
      <main className="flex-1 min-w-0 p-4 md:p-8 bg-muted/30">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">{children}</div>
      </main>
    </div>
  )
}
