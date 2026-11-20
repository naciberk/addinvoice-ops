import { redirect } from "next/navigation"
import { Card, CardContent, CardTitle } from "@/components/ui/card"
import { getSession } from "@/lib/auth"
import { LoginForm } from "./client"

export const metadata = { title: "Giriş" }

export default async function LoginPage() {
  if (await getSession("ok")) redirect("/")
  const pending = !!(await getSession("pwd"))
  return (
    <Card className="w-full max-w-md mx-auto p-8 flex flex-col items-center justify-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.svg" alt="AddInvoice" width={96} height={96} className="w-24 h-24 rounded-xl" />
      <CardTitle className="text-2xl font-bold">AddInvoice Ops</CardTitle>
      <p className="text-xs text-muted-foreground -mt-2">Yalnız yetkili personel · tüm işlemler kayda alınır</p>
      <CardContent className="w-full flex flex-col gap-4 p-0">
        <LoginForm pending={pending} />
      </CardContent>
    </Card>
  )
}
