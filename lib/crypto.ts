import crypto from "crypto"

// ── Parola (scrypt) ───────────────────────────────────────────────────────────
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt)
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${key.toString("base64")}`
}

/**
 * Ana uygulamadan (better-auth) KOPYALANAN parola özeti: "ba-scrypt$<tuz>:<anahtar>" (tuz = hex METNİ, scrypt N=16384 r=16 p=1, 64 bayt).
 * Yalnız doğrulama içindir; yeni parola belirlenince (davet/sıfırlama) standart "scrypt$…" biçimine geçer.
 */
async function verifyBetterAuth(password: string, rest: string): Promise<boolean> {
  const [salt, keyHex] = rest.split(":")
  if (!salt || !keyHex) return false
  const expected = Buffer.from(keyHex, "hex")
  const actual = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, expected.length, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (e, k) => (e ? reject(e) : resolve(k)))
  )
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("ba-scrypt$")) return verifyBetterAuth(password, stored.slice("ba-scrypt$".length))
  const [alg, , saltB64, keyB64] = stored.split("$")
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, "base64")
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function scrypt(password: string, salt: Buffer, len = 64): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, len, SCRYPT, (e, k) => (e ? reject(e) : resolve(k)))
  )
}

// Var olmayan kullanıcıda da aynı süreyi harcamak için (kullanıcı varlığı zamanlamayla sızmasın).
export async function dummyVerify() {
  await scrypt("dummy-password", Buffer.alloc(16, 1))
}

export function checkPasswordStrength(pw: string): string | null {
  if (pw.length < 12) return "Parola en az 12 karakter olmalı."
  if (pw.length > 200) return "Parola çok uzun."
  if (/^(.)\1+$/.test(pw)) return "Parola çok basit."
  const classes = [/[a-zæøå]/, /[A-ZÆØÅ]/, /\d/, /[^A-Za-z0-9æøåÆØÅ]/].filter((r) => r.test(pw)).length
  if (classes < 2 && pw.length < 16) return "Parola en az iki karakter türü içermeli (veya 16+ karakter olmalı)."
  return null
}

// ── Rastgele token / hash ─────────────────────────────────────────────────────
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url")
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex")

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

// ── Gizli veri şifreleme (TOTP sırrı vb.) — AES-256-GCM, anahtar OPS_SESSION_SECRET'tan ──
function dataKey(): Buffer {
  const secret = process.env.OPS_SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error("OPS_SESSION_SECRET eksik/kısa")
  return crypto.createHash("sha256").update("ops-data-key:" + secret).digest()
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", dataKey(), iv)
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`
}

export function unseal(blob: string): string {
  const [v, iv, enc, tag] = blob.split(".")
  if (v !== "v1") throw new Error("bilinmeyen format")
  const d = crypto.createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(iv, "base64url"))
  d.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8")
}

// ── TOTP (RFC 6238, SHA-1, 6 hane, 30 sn) ─────────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function newTotpSecret(): string {
  const bytes = crypto.randomBytes(20)
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

function b32decode(s: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 15
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(code % 1_000_000).padStart(6, "0")
}

/** Başarılıysa kullanılan 30 sn'lik adımı döner (tekrar kullanımı engellemek için saklanır), yoksa null. ±1 adım tolerans. */
export function verifyTotp(secret: string, code: string, lastStep = 0): number | null {
  const clean = code.replace(/\s/g, "")
  if (!/^\d{6}$/.test(clean)) return null
  const now = Math.floor(Date.now() / 30_000)
  for (const step of [now, now - 1, now + 1]) {
    if (step > lastStep && safeEqual(totpAt(secret, step), clean)) return step
  }
  return null
}

export function totpUri(secret: string, email: string): string {
  const label = encodeURIComponent(`AddInvoice Ops:${email}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("AddInvoice Ops")}&algorithm=SHA1&digits=6&period=30`
}

// ── Kurtarma kodları ──────────────────────────────────────────────────────────
export function newRecoveryCodes(n = 8): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString("hex")
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
  return { plain, hashes: plain.map(hashRecovery) }
}
export const hashRecovery = (code: string) => sha256("rc:" + code.toLowerCase().replace(/[^a-f0-9]/g, ""))
