import Link from "next/link"

export default function Forbidden() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3">
      <h1 className="text-xl font-semibold">Yetkin yok</h1>
      <p className="text-sm text-muted-foreground">Bu sayfa için rolün yeterli değil.</p>
      <Link href="/" className="underline text-sm">Ana sayfaya dön</Link>
    </div>
  )
}
