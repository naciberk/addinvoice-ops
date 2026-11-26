import { requireSession } from "@/lib/auth"
import { can } from "@/lib/roles"
import { CronTabs } from "@/components/panel/cron/tabs"

export default async function CronLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession()
  return (
    <div className="flex flex-col gap-4">
      <CronTabs admin={can(user.role, "admin")} />
      {children}
    </div>
  )
}
