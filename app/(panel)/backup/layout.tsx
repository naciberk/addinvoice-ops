import { requireSession } from "@/lib/auth"
import { can } from "@/lib/roles"
import { BackupTabs } from "@/components/panel/backup/tabs"

export default async function BackupLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession()
  return (
    <div className="flex flex-col gap-4">
      <BackupTabs admin={can(user.role, "admin")} />
      {children}
    </div>
  )
}
