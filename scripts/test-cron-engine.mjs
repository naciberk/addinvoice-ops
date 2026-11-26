// Regressionstest for agent/cron-engine.mjs (26.11.2026). Kør: node scripts/test-cron-engine.mjs
// Rører ALDRIG den rigtige crontab, /etc/cron.d eller produktionsdata: alt ligger i en midlertidig mappe (ACR_*), og workeren er en lokal mock-server.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const T = fs.mkdtempSync(path.join(os.tmpdir(), "acr-"))
const APP = path.join(T, "app")
const mk = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true }); fs.writeFileSync(path.join(APP, rel), txt) }

// ── Mock-server (spiller rollen som Next-appen) ──
const hits = []
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x")
  hits.push({ path: u.pathname, method: req.method, secret: req.headers["x-worker-secret"], key: u.searchParams.get("key") })
  const name = u.pathname.split("/").pop()
  const send = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)) }
  if (name === "a-worker") return req.headers["x-worker-secret"] === "testsecret" ? send(200, { ok: true, sent: 3 }) : send(401, { error: "Unauthorized" })
  if (name === "fail-worker") return send(500, { error: "boom" })
  if (name === "slow-worker") return setTimeout(() => send(200, { ok: true }), 2000)
  if (name === "hang-worker") return setTimeout(() => send(200, { ok: true }), 9000)
  if (name === "key-worker") return u.searchParams.get("key") === "testkey" ? send(200, { ok: true }) : send(401, { error: "bad key" })
  send(404, {})
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const PORT = server.address().port

mk(".env", `INTERNAL_WORKER_SECRET=testsecret\nINTERNAL_CRON_SECRET="testkey"\nPORT=${PORT}\n`)
const route = (name, body) => mk(`app/api/internal/${name}/route.ts`, body)
route("a-worker", `// Test: a-worker kommentar\nconst S = process.env.INTERNAL_WORKER_SECRET\nexport async function POST(req) { req.headers.get("x-worker-secret") }`)
route("fail-worker", `export async function POST(req) { req.headers.get("x-worker-secret") }`)
route("slow-worker", `export async function POST(req) { req.headers.get("x-worker-secret") }`)
route("hang-worker", `export async function POST(req) { req.headers.get("x-worker-secret") }`)
route("key-worker", `import config from "@/lib/config"\nexport async function GET(request) { const key = request.nextUrl.searchParams.get("key"); config.internal.cronSecret }`)
route("open-route", `export async function POST() {}`) // ingen autentificering → må IKKE kunne kaldes

process.env.ACR_APP = APP
process.env.ACR_CONFIG = path.join(T, "etc/config.json")
process.env.ACR_STATE = path.join(T, "state")
process.env.ACR_LOG = path.join(T, "log")
process.env.ACR_CROND = path.join(T, "cron.d")
process.env.ACR_BACKUPS = path.join(T, "backups")
process.env.ACR_CRONTAB_FILE = path.join(T, "crontab.txt")
process.env.ACR_BASE_URL = `http://127.0.0.1:${PORT}`
process.env.ACR_MAX_CONCURRENT = "2"
fs.mkdirSync(process.env.ACR_CROND, { recursive: true })

const E = await import("../agent/cron-engine.mjs")
let fail = 0
const ok = (cond, name, extra) => { console.log(cond ? "  OK  " : "  FEJL", name, cond ? "" : JSON.stringify(extra)); if (!cond) fail++ }
const throwsMsg = (fn, re) => { try { fn(); return false } catch (e) { return e instanceof E.UserError && re.test(e.message) } }
const cron = (expr) => ({ kind: "cron", expr })

// A) Worker-keshfi (tilladelsesliste)
const workers = E.discoverWorkers()
ok(workers.map((w) => w.name).join() === "a-worker,fail-worker,hang-worker,key-worker,slow-worker", "kun worker-routes med autentificering findes", workers.map((w) => w.name))
ok(workers.find((w) => w.name === "key-worker")?.auth === "key" && workers.find((w) => w.name === "key-worker")?.method === "GET", "key-worker: GET + nøgle")
ok(workers.find((w) => w.name === "a-worker")?.auth === "header" && /a-worker kommentar/.test(workers[0].description), "a-worker: header-hemmelighed; beskrivelse fra kodens kommentar", workers[0])

// B) Validering
ok(throwsMsg(() => E.upsertJob({ name: "x", target: "open-route", schedule: cron("* * * * *") }, "t"), /Bilinmeyen worker|Bilinmeyen/i) || throwsMsg(() => E.upsertJob({ name: "x", target: "open-route", schedule: cron("* * * * *") }, "t"), /worker/), "uden autentificering kan ikke planlægges")
ok(throwsMsg(() => E.upsertJob({ name: "x", target: "rm -rf /", schedule: cron("* * * * *") }, "t"), /worker/), "vilkårlig kommando afvises")
ok(throwsMsg(() => E.upsertJob({ name: "x", target: "a-worker", schedule: cron("61 * * * *") }, "t"), /./), "ugyldigt cron-udtryk afvises")
ok(throwsMsg(() => E.upsertJob({ name: "x", target: "a-worker", schedule: cron("* * * * *"), timeoutSec: 2 }, "t"), /Zaman aşımı/), "for kort timeout afvises")
const j1 = E.upsertJob({ name: "A kl. 06", target: "a-worker", schedule: cron("0 6 * * *") }, "t").job
const j2 = E.upsertJob({ name: "A anden", target: "a-worker", schedule: cron("5 6 * * *") }, "t").job
ok(j1.id === "a-worker" && j2.id === "a-worker-2", "id genereres, dubletter får -2", [j1.id, j2.id])
ok(!/testsecret|testkey/.test(fs.readFileSync(process.env.ACR_CONFIG, "utf8")), "hemmeligheder gemmes ALDRIG i konfigurationen")
ok((fs.statSync(process.env.ACR_CONFIG).mode & 0o777) === 0o600, "konfigurationsfil er 0600")
E.deleteJob("a-worker-2", "t")
ok(E.loadConfig().jobs.length === 1, "sletning virker")
ok(throwsMsg(() => E.deleteJob("findes-ikke", "t"), /bulunamadı/), "sletning af ukendt job afvises")

// C) Kørsel: succes, fejl, timeout, nøgle, manglende hemmelighed
E.upsertJob({ id: "ok-job", name: "OK", target: "a-worker", schedule: cron("* * * * *") }, "t")
let r = await E.runJob("ok-job")
ok(r.outcome === "ok" && r.status === 200 && r.ms >= 0 && /sent/.test(r.message), "succes registreres (200, varighed, svar)", r)
ok(hits.at(-1).secret === "testsecret", "hemmeligheden blev sendt af motoren (fra .env)", hits.at(-1))
E.upsertJob({ id: "fail-job", name: "Fejl", target: "fail-worker", schedule: cron("* * * * *") }, "t")
r = await E.runJob("fail-job")
ok(r.outcome === "fail" && r.status === 500, "HTTP 500 = fejl", r)
await E.runJob("fail-job")
let st = JSON.parse(fs.readFileSync(`${process.env.ACR_STATE}/state/fail-job.json`, "utf8"))
ok(st.consecutiveFailures === 2 && st.lastRun.outcome === "fail", "fejl i træk tælles", st)
E.upsertJob({ id: "key-job", name: "Nøgle", target: "key-worker", schedule: cron("* * * * *") }, "t")
r = await E.runJob("key-job")
ok(r.outcome === "ok" && hits.at(-1).key === "testkey", "GET med ?key= fra .env", [r, hits.at(-1)])
E.upsertJob({ id: "hang-job", name: "Hænger", target: "hang-worker", schedule: cron("* * * * *"), timeoutSec: 5 }, "t")
const t0 = Date.now()
r = await E.runJob("hang-job")
ok(r.outcome === "fail" && /Zaman aşımı/.test(r.message) && Date.now() - t0 < 8000, "timeout afbryder og registreres", r)
ok(!fs.existsSync(`${process.env.ACR_STATE}/locks/hang-job.lock`), "lås frigivet efter timeout")
const envBak = fs.readFileSync(path.join(APP, ".env"), "utf8")
fs.writeFileSync(path.join(APP, ".env"), "PORT=1\n")
r = await E.runJob("ok-job")
ok(r.outcome === "fail" && /INTERNAL_WORKER_SECRET/.test(r.message), "manglende hemmelighed giver tydelig fejl", r)
fs.writeFileSync(path.join(APP, ".env"), envBak)
r = await E.runJob("ok-job")
st = JSON.parse(fs.readFileSync(`${process.env.ACR_STATE}/state/ok-job.json`, "utf8"))
ok(st.consecutiveFailures === 0 && st.lastOkAt, "succes nulstiller fejltæller", st)

// D) Overlap og samtidighedsgrænse
E.upsertJob({ id: "slow-job", name: "Langsom", target: "slow-worker", schedule: cron("* * * * *") }, "t")
const [a, b] = await Promise.all([E.runJob("slow-job"), E.runJob("slow-job")])
ok([a.outcome, b.outcome].sort().join() === "ok,skipped" && [a, b].find((x) => x.outcome === "skipped").reason === "overlap", "samme job kan ikke køre dobbelt (anden springes over)", [a, b])
for (const n of ["s1", "s2", "s3"]) E.upsertJob({ id: n, name: n, target: "slow-worker", schedule: cron("* * * * *") }, "t")
const tt = Date.now()
const res3 = await Promise.all(["s1", "s2", "s3"].map((n) => E.runJob(n)))
const took = Date.now() - tt
ok(res3.every((x) => x.outcome === "ok") && took >= 3500 && took < 12000, "global grænse (2): tredje venter på en plads og kører bagefter", { took, res3: res3.map((x) => x.outcome) })

// E) Tick
for (const id of ["ok-job", "fail-job", "key-job", "hang-job", "slow-job", "s1", "s2", "s3"]) E.deleteJob(id, "t")
E.upsertJob({ id: "t1", name: "T1", target: "a-worker", schedule: cron("* * * * *") }, "t")
E.upsertJob({ id: "t2", name: "T2", target: "key-worker", schedule: cron("* * * * *") }, "t")
E.upsertJob({ id: "t3", name: "T3 pauset", target: "fail-worker", schedule: cron("* * * * *"), enabled: false }, "t")
const spawned = []
const fake = (id, o) => spawned.push({ id, ...o })
const when = new Date(2026, 10, 27, 10, 30, 0)
let tk = E.tick(when, { spawn: fake })
ok(tk.disabled === true && spawned.length === 0, "tick gør intet, mens planlæggeren er slået fra")
ok(fs.existsSync(`${process.env.ACR_STATE}/heartbeat`), "hjerteslag skrives også når planlæggeren er slået fra")
E.saveConfig({ ...E.loadConfig(), enabled: true }, "t")
tk = E.tick(when, { spawn: fake })
ok(tk.started.join() === "t1,t2" && spawned.map((s) => s.delayMs).join() === "0,1500", "tick starter kun aktive jobs, forskudt 1,5 sek", { tk, spawned })
tk = E.tick(when, { spawn: fake })
ok(tk.started.length === 0, "samme minut startes aldrig to gange")
tk = E.tick(new Date(2026, 10, 27, 10, 31, 0), { spawn: fake })
ok(tk.started.length === 2, "næste minut starter igen")

// F) Historik, 24 t-statistik, oprydning
fs.mkdirSync(`${process.env.ACR_STATE}/runs`, { recursive: true })
const old = new Date(Date.now() - 40 * 86400000).toISOString()
fs.appendFileSync(`${process.env.ACR_STATE}/runs/t1.jsonl`, JSON.stringify({ ts: old, job: "t1", outcome: "ok" }) + "\n")
await E.runJob("t1")
ok(E.history("t1", 10)[0].outcome === "ok" && E.history("t1", 10).length === 2, "historik: nyeste først", E.history("t1", 10))
ok(E.stats24h("t1").ok === 1, "24 t-statistik tæller kun de seneste 24 timer", E.stats24h("t1"))
ok(E.pruneRuns() === 1 && E.history("t1", 10).length === 1, "oprydning fjerner kørsler ældre end 30 dage")
ok(throwsMsg(() => E.history("../etc/passwd"), /Geçersiz/), "historik afviser stiforsøg")

// G) Systemets cron-linjer (skrivebeskyttet) + konflikter
fs.writeFileSync(path.join(process.env.ACR_CROND, "addinvoice-test"), [
  "SHELL=/bin/sh", "# kommentar", "*/10 * * * * root /usr/bin/node /x/backup-engine.mjs tick >> /tmp/a.log 2>&1",
  "0 7 * * 1   postgres  /usr/local/bin/addinvoice-db-health.sh", "5-55/10 * * * * root command -v debian-sa1 > /dev/null && debian-sa1 1 1",
  "@reboot root ip route replace x", "0 6 * * *  root curl -s -X POST http://localhost:7331/api/internal/abonnement-worker -H 'x-worker-secret: abcdef123456'",
].join("\n") + "\n")
const sys = E.systemCrons()
ok(sys.length === 5 && sys.every((x) => x.source === "cron.d/addinvoice-test"), "cron.d-linjer læses (variabler/kommentarer springes over)", sys.map((x) => x.expr))
ok(sys.some((x) => x.expr === "@reboot" && x.schedule === null && x.unparsed), "@reboot vises, men har ingen tidsplan")
ok(!sys.some((x) => /abcdef123456/.test(x.command)) && sys.find((x) => /abonnement/.test(x.command)).command.includes("***"), "hemmeligheder maskeres i visningen")
ok(sys.find((x) => /health/.test(x.command)).info && sys.find((x) => /debian-sa1/.test(x.command)).info, "kendte systemjobs får beskrivelse")
const pv = E.previewSchedule(cron("0 6 * * *"), {})
ok(pv.collisions.length > 0 && pv.collisions[0].with.includes("abonnement-worker"), "forhåndsvisning finder kollision med anden cron-linje kl. 06:00", pv.collisions.slice(0, 2))
const free = E.previewSchedule(cron("23 3 * * *"), {})
ok(free.collisions.length === 0, "ledigt minut giver ingen kollision")
ok(E.previewSchedule(cron("*/3 * * * *")).frequent === true && E.previewSchedule(cron("*/3 * * * *")).collisions.length === 0, "hyppige jobs (≥24/dag) markeres og ignoreres i konflikter")
const sug = E.suggestSlots({ hour: 6, count: 5 })
ok(sug.length === 5 && !sug.some((s) => s.minute === 0 || s.minute === 5) && sug.every((s) => s.hour === 6), "forslag undgår optagede minutter (kl. 06:00 og 06:05)", sug)
const grid = E.dayGrid("2026-11-30") // mandag
ok(grid.collisions.some((c) => c.minute === "07:00") === false && grid.cells.length === 1440, "dagsgitter: 1440 celler") // t1/t2 er hyppige, health 07:00 kører mandag alene
ok(grid.at[6 * 60 + 0] && grid.at[6 * 60].length >= 1, "dagsgitter viser job kl. 06:00")
ok(throwsMsg(() => E.dayGrid("30-11-2026"), /Tarih/), "dagsgitter afviser ugyldig dato")

// H) matchWorkerCommand
const mm = E.matchWorkerCommand
ok(mm("curl -s -X POST http://localhost:7331/api/internal/scan-worker -H 'x-worker-secret: abc' > /dev/null 2>&1")?.name === "scan-worker", "kendt worker-linje genkendes")
ok(mm(`curl -s "http://localhost:7331/api/internal/email-import?key=XYZ" > /dev/null 2>&1`)?.hasKey === true, "email-import med nøgle genkendes")
ok(mm("curl -s -m 30 -X POST http://localhost:7331/api/internal/scan-worker > /dev/null 2>&1") === null, "ukendt flag → flyttes ikke")
ok(mm("curl -s http://evil.example/api/internal/scan-worker") === null && mm("rm -rf /; curl http://localhost:7331/api/internal/x") === null, "andre værter/kommandoer → flyttes ikke")

// I) Migration (mod en falsk crontab-fil)
fs.writeFileSync(path.join(T, "cron.d", "addinvoice-test"), "") // ryd cron.d for denne del
E.saveConfig({ version: 1, enabled: false, jobs: [] }, "t")
const original = [
  "# min crontab", "*/3 * * * * curl -s -X POST http://localhost:7331/api/internal/a-worker -H 'x-worker-secret: testsecret' > /dev/null 2>&1",
  `5 4 * * * curl -s "http://localhost:7331/api/internal/key-worker?key=testkey" > /dev/null 2>&1`,
  "0 5 * * * curl -s -X POST http://localhost:7331/api/internal/findes-ikke -H 'x-worker-secret: x' > /dev/null 2>&1",
  "30 1 * * * /usr/local/bin/min-egen-backup.sh", "",
].join("\n")
fs.writeFileSync(process.env.ACR_CRONTAB_FILE, original)
const plan = E.migratePlan()
ok(plan.migratable === 2 && plan.keep === 2 && plan.items.find((x) => x.name === "findes-ikke").status === "keep" && !plan.problems.length, "plan: 2 flyttes, 2 lades urørt (ukendt worker + eget script)", plan.items.map((x) => [x.name ?? x.command, x.status]))
ok(!JSON.stringify(plan).includes("testsecret") && !JSON.stringify(plan).includes("testkey"), "planen indeholder ingen hemmeligheder")
ok(throwsMsg(() => E.migrateApply("ja", "t"), /TAŞI/), "forkert bekræftelse afvises")
const n = new Date()
const unsafe = `${n.getMinutes()} ${n.getHours()} * * *`
fs.writeFileSync(process.env.ACR_CRONTAB_FILE, original + `${unsafe} curl -s -X POST http://localhost:7331/api/internal/a-worker -H 'x-worker-secret: testsecret' > /dev/null 2>&1\n`)
ok(throwsMsg(() => E.migrateApply("TAŞI", "t"), /güvenli pencere/), "afvises, hvis et job skal køre inden for et minut")
fs.writeFileSync(process.env.ACR_CRONTAB_FILE, original)
const m1 = E.migrateApply("TAŞI", "t", new Date(2026, 10, 27, 12, 20, 0))
const after = fs.readFileSync(process.env.ACR_CRONTAB_FILE, "utf8")
ok(m1.migrated === 2 && !/a-worker|key-worker/.test(after) && /min-egen-backup/.test(after) && /findes-ikke/.test(after) && /^# Worker görevleri/.test(after), "flyttede worker-linjer fjernet; ukendt worker + eget script står urørte", after)
ok(fs.existsSync(m1.backupFile) && fs.readFileSync(m1.backupFile, "utf8") === original, "crontab er sikkerhedskopieret uændret")
ok(E.tickInstalled() && /cron-engine\.mjs tick/.test(fs.readFileSync(path.join(T, "cron.d", "addinvoice-cron-tick"), "utf8")) && (fs.statSync(path.join(T, "cron.d", "addinvoice-cron-tick")).mode & 0o777) === 0o644, "tick-linje installeret (0644)")
const cfgAfter = E.loadConfig()
ok(cfgAfter.enabled === true && cfgAfter.jobs.length === 2 && cfgAfter.jobs.every((j) => j.importedFrom === "crontab") && cfgAfter.jobs.find((j) => j.target === "a-worker").schedule.source.expr === "*/3 * * * *", "jobs importeret og planlægger slået til", cfgAfter.jobs.map((j) => j.target))
ok(E.migratePlan().migratable === 0, "efter flytning er der intet mere at flytte")
const ov = E.overview()
ok(ov.enabled && ov.jobs.length === 2 && ov.jobs.find((j) => j.target === "a-worker").description && ov.unscheduled.map((w) => w.name).includes("fail-worker"), "oversigt: beskrivelser + uplanlagte workers", ov.unscheduled.map((w) => w.name))
// dobbelt-kørsel-værn: aktivering afvises, hvis samme job stadig står i crontab
fs.writeFileSync(process.env.ACR_CRONTAB_FILE, after + "*/3 * * * * curl -s -X POST http://localhost:7331/api/internal/a-worker -H 'x-worker-secret: testsecret' > /dev/null 2>&1\n")
ok(throwsMsg(() => E.setSchedulerEnabled(true, "t"), /İKİ KEZ/), "aktivering afvises, hvis jobbet også står i crontab (dobbelt kørsel)")
fs.writeFileSync(process.env.ACR_CRONTAB_FILE, after)
const rb = E.migrateRollback("t")
ok(fs.readFileSync(process.env.ACR_CRONTAB_FILE, "utf8") === original && !E.tickInstalled() && E.loadConfig().enabled === false && rb.restored, "tilbagerulning: gammel crontab tilbage, tick fjernet, planlægger slået fra")

// J) Sundhed (hjerteslag, fejl i træk)
E.saveConfig({ ...E.loadConfig(), enabled: true }, "t")
fs.writeFileSync(`${process.env.ACR_STATE}/heartbeat`, new Date(Date.now() - 10 * 60000).toISOString())
ok(E.health().some((h) => h.key === "cron:tick" && h.severity === "bad"), "gammelt hjerteslag giver rød advarsel")
fs.writeFileSync(`${process.env.ACR_STATE}/heartbeat`, new Date().toISOString())
fs.writeFileSync(`${process.env.ACR_STATE}/state/${E.loadConfig().jobs[0].id}.json`, JSON.stringify({ consecutiveFailures: 3, lastRun: { message: "boom" } }))
ok(E.health().some((h) => h.key.startsWith("cron:") && h.severity === "bad" && /3 kez/.test(h.message)), "3 fejl i træk giver rød advarsel")

server.close()
fs.rmSync(T, { recursive: true, force: true })
console.log(fail === 0 ? "ALLE TESTS OK" : `${fail} FEJL`)
process.exit(fail === 0 ? 0 : 1)
