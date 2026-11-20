import { requireRole } from "@/lib/auth"
import { dt } from "@/lib/format"
import { ROLE_HELP, ROLE_LABEL } from "@/lib/roles"
import { snapshot } from "@/lib/store"
import { Dot, Empty, PageTitle, Section, td, th } from "@/components/panel/ui"
import { HelpLink } from "@/components/panel/help-link"
import { InviteForm } from "@/components/panel/invite-form"
import { RevokeInvite, UserActions } from "@/components/panel/user-actions"

export const metadata = { title: "Kullanıcılar" }
export const dynamic = "force-dynamic"

export default async function UsersPage() {
  const { user: me } = await requireRole("admin")
  const db = snapshot()
  const invites = db.invites.filter((i) => !i.usedAt && i.expiresAt > Date.now())
  const sessions = db.sessions.filter((s) => s.stage === "ok" && s.expiresAt > Date.now())

  return (
    <>
      <PageTitle title="Kullanıcılar" sub="Bu konsolun kullanıcıları AddInvoice müşteri hesaplarından tamamen ayrıdır. Giriş: parola + 2FA (TOTP)." />
      <Section title="Birine erişim ver" right={<div className="flex flex-col items-end gap-1"><HelpLink id="invite" label="Davet nasıl çalışır?" /><HelpLink id="roles" label="Roller" /></div>} sub="E-posta gönderilmez: oluşan bağlantıyı kişiye kendin ilet. 48 saat geçerli, tek kullanımlık.">
        <InviteForm />
        <dl className="grid md:grid-cols-3 gap-3 mt-4 text-xs text-muted-foreground">
          {(["viewer", "operator", "admin"] as const).map((r) => <div key={r}><dt className="font-medium text-foreground">{ROLE_LABEL[r]}</dt><dd>{ROLE_HELP[r]}</dd></div>)}
        </dl>
      </Section>

      <Section title="Kullanıcılar" right={<div className="flex flex-col items-end gap-1"><HelpLink id="reset-access" label="Erişimi sıfırla ne yapar?" /><HelpLink id="disable-user" label="Devre dışı bırak" /></div>}>
        <table className="w-full">
          <thead><tr><th className={th}>Kişi</th><th className={th}>Rol</th><th className={th}>Son giriş</th><th className={th}>Oturum</th><th className={th}>Yönet</th></tr></thead>
          <tbody>
            {db.users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className={td}><div className="font-medium">{u.name}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                <td className={td}><Dot tone={u.disabled ? "off" : "ok"} />{ROLE_LABEL[u.role]}{u.disabled ? " (devre dışı)" : ""}</td>
                <td className={td}>{dt(u.lastLoginAt)}</td>
                <td className={td}>{sessions.filter((s) => s.userId === u.id).length}</td>
                <td className={td}><UserActions id={u.id} role={u.role} disabled={u.disabled} self={u.id === me.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Bekleyen davetler">
        {!invites.length ? <Empty>Bekleyen davet yok.</Empty> : (
          <table className="w-full">
            <thead><tr><th className={th}>E-posta</th><th className={th}>Tür</th><th className={th}>Rol</th><th className={th}>Davet eden</th><th className={th}>Bitiş</th><th className={th}></th></tr></thead>
            <tbody>{invites.map((i) => <tr key={i.id} className="border-t"><td className={td}>{i.email}</td><td className={td}>{i.kind === "new" ? "yeni" : i.kind === "enrol" ? "2FA kurulumu" : "sıfırlama"}</td><td className={td}>{ROLE_LABEL[i.role]}</td><td className={td}>{i.createdBy}</td><td className={td}>{dt(i.expiresAt)}</td><td className={td}><RevokeInvite id={i.id} /></td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </>
  )
}
