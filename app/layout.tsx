import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: { template: "%s | AddInvoice Ops", default: "AddInvoice Ops" },
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.ico" },
}
export const viewport: Viewport = { width: "device-width", initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  )
}
