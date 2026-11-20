#!/usr/bin/env node
// İlk yöneticiyi (veya erişim kaybında yeni birini) davet etmek için — yalnız root çalıştırır.
//   node scripts/bootstrap-invite.mjs <e-posta> [admin|operator|viewer]
// Çıktı: tek kullanımlık davet bağlantısı (48 saat). Bağlantıyı açan kişi parola + 2FA'sını kendisi belirler.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

if (process.getuid?.() !== 0) { console.error("root olarak çalıştır"); process.exit(1) }
for (const l of fs.readFileSync("/etc/addinvoice-ops/env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const [email, role = "admin"] = process.argv.slice(2)
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["admin", "operator", "viewer"].includes(role)) {
  console.error("kullanım: node scripts/bootstrap-invite.mjs <e-posta> [admin|operator|viewer]"); process.exit(1)
}
const dir = process.env.OPS_DATA_DIR
const file = path.join(dir, "invites.json")
const invites = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []
const users = fs.existsSync(path.join(dir, "users.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8")) : []
if (users.some((u) => u.email === email.toLowerCase())) { console.error("Bu e-posta zaten kullanıcı. Yönetici arayüzünden 'Erişimi sıfırla' kullan."); process.exit(1) }
const token = crypto.randomBytes(32).toString("base64url")
invites.push({
  id: crypto.randomBytes(8).toString("base64url"),
  tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  kind: "new", email: email.toLowerCase(), role, createdBy: "bootstrap (root)",
  createdAt: Date.now(), expiresAt: Date.now() + 48 * 3600_000, usedAt: null,
})
fs.writeFileSync(file, JSON.stringify(invites, null, 2), { mode: 0o600 })
execFileSync("chown", ["-R", "addinvoice-ops:addinvoice-ops", dir])
console.log(`\nDavet bağlantısı (48 saat, tek kullanımlık, rol: ${role}):\n\n  ${process.env.OPS_BASE_URL}/invite/${token}\n`)
