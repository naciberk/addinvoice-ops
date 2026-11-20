import fs from "fs"
import path from "path"

const DIR = process.env.OPS_DATA_DIR || "/var/lib/addinvoice-ops/data"

export type Role = "viewer" | "operator" | "admin"

export type User = {
  id: string
  email: string
  name: string
  role: Role
  passwordHash: string
  totpSecretSealed: string
  totpLastStep: number
  recoveryHashes: string[]
  failedLogins: number
  lockedUntil: number
  disabled: boolean
  createdAt: number
  lastLoginAt: number | null
  invitedBy: string | null
}

export type Invite = {
  id: string
  tokenHash: string
  kind: "new" | "reset" | "enrol"
  userId?: string // reset / enrol için
  email: string
  role: Role
  createdBy: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  enrolSecretSealed?: string
}

export type Session = {
  idHash: string
  userId: string
  stage: "pwd" | "ok" // pwd = parola geçti, TOTP bekleniyor
  createdAt: number
  lastSeen: number
  expiresAt: number
  ip: string
  ua: string
}

type Db = { users: User[]; invites: Invite[]; sessions: Session[] }

const FILES: Record<keyof Db, string> = {
  users: "users.json",
  invites: "invites.json",
  sessions: "sessions.json",
}

let queue: Promise<unknown> = Promise.resolve()

function readFile<K extends keyof Db>(k: K): Db[K] {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, FILES[k]), "utf8")) as Db[K]
  } catch {
    return [] as unknown as Db[K]
  }
}

function writeFile<K extends keyof Db>(k: K, v: Db[K]) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const f = path.join(DIR, FILES[k])
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** Tüm okuma-değiştirme-yazma işlemleri tek sırada (süreç içi kilit). Tek süreç çalıştığı için yeterli. */
export function tx<T>(fn: (db: Db) => T): Promise<T> {
  const run = queue.then(() => {
    const db: Db = { users: readFile("users"), invites: readFile("invites"), sessions: readFile("sessions") }
    const before = JSON.stringify(db)
    const out = fn(db)
    const after = JSON.stringify(db)
    if (before !== after) {
      for (const k of Object.keys(FILES) as (keyof Db)[]) writeFile(k, db[k])
    }
    return out
  })
  queue = run.catch(() => undefined)
  return run
}

export function snapshot(): Db {
  return { users: readFile("users"), invites: readFile("invites"), sessions: readFile("sessions") }
}
