import fs from "fs"
import path from "path"
import { Readable } from "stream"
import { NextResponse } from "next/server"
import { audit } from "@/lib/audit"
import { clientInfo, getSession } from "@/lib/auth"
import { can } from "@/lib/roles"

export const dynamic = "force-dynamic"
const DIR = process.env.OPS_DOWNLOAD_DIR || "/var/lib/addinvoice-ops/downloads"

export async function GET(_: Request, { params }: { params: Promise<{ file: string }> }) {
  const a = await getSession("ok")
  if (!a || !can(a.user.role, "operator")) return new NextResponse("Yetkisiz", { status: 403 })
  const { file } = await params
  if (!/^[a-z0-9][a-z0-9-]{0,80}\.tar\.enc$/.test(file)) return new NextResponse("Geçersiz", { status: 400 })
  const full = path.join(DIR, file)
  let st: fs.Stats
  try {
    st = fs.statSync(full)
  } catch {
    return new NextResponse("Bulunamadı (24 saat sonra silinir)", { status: 404 })
  }
  const { ip } = await clientInfo()
  await audit({ actor: a.user.email, role: a.user.role, action: "export.download", target: file, ip })
  return new NextResponse(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, {
    headers: { "content-type": "application/octet-stream", "content-length": String(st.size), "content-disposition": `attachment; filename="${file}"` },
  })
}
