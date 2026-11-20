import { redirect } from "next/navigation"

// Eski adres: "Yedekler" sayfası "Yedekleme → Veritabanı (PITR)" sekmesine taşındı (20 Kas 2026).
export default function OldBackupsPage() {
  redirect("/backup/db")
}
