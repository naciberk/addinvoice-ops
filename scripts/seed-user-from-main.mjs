#!/usr/bin/env node
// Ana uygulamadaki (better-auth) bir kullanıcının e-posta/ad/parola ÖZETİNİ ops konsoluna kopyalar ve 2FA kurulum bağlantısı üretir.
//   node scripts/seed-user-from-main.mjs <e-posta> [admin|operator|viewer]
// Parola özeti ekrana YAZILMAZ. Kopya bir anlık görüntüdür: ana uygulamada sonradan parola değişirse ops'a yansımaz.
// 2FA her zaman zorunlu: hesap, bağlantıdaki TOTP kurulumu bitmeden giriş yapamaz.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

if (process.getuid?.() !== 0) { console.error("root olarak çalıştır"); process.exit(1) }
for (const l of fs.readFileSync("/etc/addinvoice-ops/env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}
const [emailArg, role = "admin"] = process.argv.slice(2)
const email = (emailArg ?? "").toLowerCase()
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["admin", "operator", "viewer"].includes(role)) { console.error("kullanım: seed-user-from-main.mjs <e-posta> [rol]"); process.exit(1) }

const out = execFileSync("runuser", ["-u", "postgres", "--", "psql", "-X", "-At", "-F", "\t", "-d", "addinvoice_db", "-v", "ON_ERROR_STOP=1", "-v", `e=${email}`, "-f", "-"], {
  input: "select u.name, a.password from users u join account a on a.user_id = u.id and a.provider_id = 'credential' where lower(u.email) = :'e' limit 1;",
  encoding: "utf8",
}).trim()
if (!out) { console.error("Ana uygulamada bu e-posta için parolalı (credential) hesap bulunamadı."); process.exit(1) }
const [name, hash] = out.split("\t")
if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)) { console.error("Beklenmeyen parola özeti biçimi — kopyalanmadı."); process.exit(1) }

const dir = process.env.OPS_DATA_DIR
const rd = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : [])
const users = rd("users.json"), invites = rd("invites.json")
if (users.some((u) => u.email === email)) { console.error("Bu e-posta ops'ta zaten kullanıcı."); process.exit(1) }

const id = crypto.randomBytes(12).toString("base64url")
users.push({ id, email, name: name || email, role, passwordHash: "ba-scrypt$" + hash, totpSecretSealed: "", totpLastStep: 0, recoveryHashes: [], failedLogins: 0, lockedUntil: 0, disabled: false, createdAt: Date.now(), lastLoginAt: null, invitedBy: "seed (ana uygulama kopyası)" })
const token = crypto.randomBytes(32).toString("base64url")
invites.push({ id: crypto.randomBytes(8).toString("base64url"), tokenHash: crypto.createHash("sha256").update(token).digest("hex"), kind: "enrol", userId: id, email, role, createdBy: "seed (root)", createdAt: Date.now(), expiresAt: Date.now() + 48 * 3600_000, usedAt: null })
fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify(users, null, 2), { mode: 0o600 })
fs.writeFileSync(path.join(dir, "invites.json"), JSON.stringify(invites, null, 2), { mode: 0o600 })
execFileSync("chown", ["-R", "addinvoice-ops:addinvoice-ops", dir])
console.log(`\nKullanıcı oluşturuldu: ${name} <${email}> — rol: ${role} (parola ana uygulamadan kopyalandı)\n2FA kurulum bağlantısı (48 saat, tek kullanımlık):\n\n  ${process.env.OPS_BASE_URL}/invite/${token}\n`)
