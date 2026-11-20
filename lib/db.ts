import { Pool } from "pg"

// Salt-okunur ops_monitor rolü (pg_monitor + ops.* fonksiyonları). İş tablolarına SELECT hakkı YOK.
const g = globalThis as unknown as { __opsPool?: Pool }

export function pool(): Pool {
  if (!g.__opsPool) {
    g.__opsPool = new Pool({
      connectionString: process.env.OPS_DB_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000,
      application_name: "addinvoice-ops",
    })
    g.__opsPool.on("error", () => {})
  }
  return g.__opsPool
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool().query(sql, params)
  return r.rows as T[]
}

/** Hata olursa sayfa çökmesin: {data} | {error}. */
export async function safe<T>(fn: () => Promise<T>): Promise<{ data: T; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await fn() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
