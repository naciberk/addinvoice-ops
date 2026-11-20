import crypto from "crypto"
import fs from "fs"
import path from "path"

const DIR = process.env.OPS_DATA_DIR || "/var/lib/addinvoice-ops/data"
const FILE = path.join(DIR, "audit.jsonl")

export type AuditEntry = {
  seq: number
  ts: string
  actor: string // e-posta veya "-" (giriş öncesi)
  role: string
  action: string
  target?: string
  detail?: string
  ip?: string
  ok: boolean
  prev: string
  hash: string
}

let queue: Promise<unknown> = Promise.resolve()
let last: { seq: number; hash: string } | null = null

function loadLast(): { seq: number; hash: string } {
  if (last) return last
  try {
    const lines = fs.readFileSync(FILE, "utf8").trimEnd().split("\n")
    const e = JSON.parse(lines[lines.length - 1]) as AuditEntry
    last = { seq: e.seq, hash: e.hash }
  } catch {
    last = { seq: 0, hash: "GENESIS" }
  }
  return last
}

/** Yalnız-ekleme (append-only) + hash zinciri: kayıt silinir/değiştirilirse zincir bozulur ve audit sayfası bunu gösterir. */
export function audit(e: { actor: string; role?: string; action: string; target?: string; detail?: string; ip?: string; ok?: boolean }): Promise<void> {
  const run = queue.then(() => {
    const l = loadLast()
    const body = {
      seq: l.seq + 1,
      ts: new Date().toISOString(),
      actor: e.actor,
      role: e.role ?? "-",
      action: e.action,
      target: e.target,
      detail: e.detail?.slice(0, 500),
      ip: e.ip,
      ok: e.ok ?? true,
      prev: l.hash,
    }
    const hash = crypto.createHash("sha256").update(l.hash + JSON.stringify(body)).digest("hex")
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
    fs.appendFileSync(FILE, JSON.stringify({ ...body, hash }) + "\n", { mode: 0o600 })
    last = { seq: body.seq, hash }
  })
  queue = run.catch(() => undefined)
  return run
}

export function readAudit(): { entries: AuditEntry[]; chainOk: boolean; brokenAt?: number } {
  let raw = ""
  try {
    raw = fs.readFileSync(FILE, "utf8")
  } catch {
    return { entries: [], chainOk: true }
  }
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry)
  let prev = "GENESIS"
  for (const e of entries) {
    const { hash, ...body } = e
    const calc = crypto.createHash("sha256").update(prev + JSON.stringify(body)).digest("hex")
    if (e.prev !== prev || calc !== hash) return { entries, chainOk: false, brokenAt: e.seq }
    prev = hash
  }
  return { entries, chainOk: true }
}
