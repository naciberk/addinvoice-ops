import QRCode from "qrcode"
import { Card, CardContent, CardTitle } from "@/components/ui/card"
import { newTotpSecret, seal, sha256, totpUri, unseal } from "@/lib/crypto"
import { snapshot, tx } from "@/lib/store"
import { InviteForm } from "./client"

export const metadata = { title: "Davet" }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const tokenHash = sha256(token)
  let inv = snapshot().invites.find((i) => i.tokenHash === tokenHash)

  const invalid = !inv || inv.usedAt || inv.expiresAt < Date.now()
  let qr = ""
  let secret = ""
  if (!invalid && inv) {
    // TOTP sırrı davet açılırken bir kez üretilir ve davete bağlanır (sayfa yenilenince QR değişmesin).
    if (!inv.enrolSecretSealed) {
      const s = newTotpSecret()
      await tx((db) => {
        const i = db.invites.find((x) => x.tokenHash === tokenHash)
        if (i && !i.enrolSecretSealed) i.enrolSecretSealed = seal(s)
      })
      inv = snapshot().invites.find((i) => i.tokenHash === tokenHash)
    }
    secret = unseal(inv!.enrolSecretSealed!)
    qr = await QRCode.toDataURL(totpUri(secret, inv!.email), { margin: 1, width: 360 })
  }

  return (
    <Card className="w-full max-w-md mx-auto p-8 flex flex-col items-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.svg" alt="AddInvoice" width={72} height={72} className="w-18 h-18 rounded-xl" />
      <CardTitle className="text-xl font-bold">AddInvoice Ops daveti</CardTitle>
      <CardContent className="w-full p-0">
        {invalid || !inv ? (
          <p className="text-sm text-destructive text-center">Davet geçersiz, kullanılmış veya süresi dolmuş. Yöneticiden yeni bir bağlantı iste.</p>
        ) : (
          <InviteForm token={token} kind={inv.kind} email={inv.email} qr={qr} secret={secret} />
        )}
      </CardContent>
    </Card>
  )
}
