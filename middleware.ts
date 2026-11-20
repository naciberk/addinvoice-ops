import { NextResponse, type NextRequest } from "next/server"

// Hızlı ilk kapı: oturum çerezi yoksa giriş sayfasına. (Gerçek doğrulama her sayfa/eylemde sunucuda yapılır.)
export function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname
  if (p.startsWith("/login") || p.startsWith("/invite/") || p.startsWith("/_next") || p === "/favicon.ico" || p === "/logo.svg") return NextResponse.next()
  if (!req.cookies.get("ops_session")) {
    if (p.startsWith("/api/")) return NextResponse.json({ ok: false }, { status: 401 })
    // next start 127.0.0.1:7332'de dinlediği için req.url iç adrestir → dışarıdan görünen adresi proxy başlığından al.
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || ""
    const proto = req.headers.get("x-forwarded-proto") || "https"
    return NextResponse.redirect(new URL("/login", `${proto}://${host}`))
  }
  return NextResponse.next()
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] }
