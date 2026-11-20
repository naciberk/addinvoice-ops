import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PSQL = (opt("psql") ?? (process.getuid?.() === 0 ? "sudo -u postgres psql" : "psql")).split(" ");
const q = (s) => `"${s.replace(/"/g, '""')}"`;
function psql(db, sql, extraArgs = [], env = {}) {
  return execFileSync(PSQL[0], [...PSQL.slice(1), "-X", "-At", "-F", "	", "-v", "ON_ERROR_STOP=1", "-d", db, ...extraArgs, "-c", sql], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28
  }).trim();
}
const rows = (db, sql) => {
  const out = psql(db, sql);
  return out ? out.split("\n").map((l) => l.split("	")) : [];
};
function loadMeta(db) {
  const cols = rows(db, `select table_name, column_name, data_type from information_schema.columns where table_schema='public' and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE') order by table_name, ordinal_position`);
  const pks = rows(db, `select tc.table_name, kcu.column_name from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name and kcu.table_schema=tc.table_schema where tc.constraint_type='PRIMARY KEY' and tc.table_schema='public' order by tc.table_name, kcu.ordinal_position`);
  const fkRows = rows(db, `select cl.relname, a.attname, cf.relname, af.attname from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_class cf on cf.oid=c.confrelid join pg_namespace n on n.oid=cl.relnamespace join lateral unnest(c.conkey, c.confkey) as k(ck, fk) on true join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.ck join pg_attribute af on af.attrelid=c.confrelid and af.attnum=k.fk where c.contype='f' and n.nspname='public' and array_length(c.conkey,1)=1`);
  const tables = /* @__PURE__ */ new Map();
  for (const [t, c, ty] of cols) {
    const m = tables.get(t) ?? { name: t, cols: [], hasCompanyId: false, pk: [] };
    m.cols.push({ name: c, type: ty });
    if (c === "company_id") m.hasCompanyId = true;
    tables.set(t, m);
  }
  for (const [t, c] of pks) tables.get(t)?.pk.push(c);
  return { tables, fks: fkRows.map(([src, srcCol, dst, dstCol]) => ({ src, srcCol, dst, dstCol })) };
}
function plan(meta, companyId) {
  const where = /* @__PURE__ */ new Map();
  const kind = /* @__PURE__ */ new Map();
  for (const t of meta.tables.values()) if (t.hasCompanyId) {
    where.set(t.name, `${q("company_id")} = '${companyId}'`);
    kind.set(t.name, "tenant");
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of meta.fks) {
      if (f.src === "companies" || where.has(f.src) || !where.has(f.dst) || f.src === f.dst) continue;
      if (!meta.tables.has(f.src) || kind.get(f.dst) === "reference") continue;
      where.set(f.src, `${q(f.srcCol)} IN (SELECT ${q(f.dstCol)} FROM ${q(f.dst)} WHERE ${where.get(f.dst)})`);
      kind.set(f.src, "child");
      changed = true;
    }
  }
  const refs = /* @__PURE__ */ new Map();
  for (const f of meta.fks) {
    if (!where.has(f.src) || where.has(f.dst) || f.src === f.dst || f.dst === "companies") continue;
    const sub = `SELECT ${q(f.srcCol)} FROM ${q(f.src)} WHERE ${where.get(f.src)} AND ${q(f.srcCol)} IS NOT NULL`;
    refs.set(f.dst, [...refs.get(f.dst) ?? [], `${q(f.dstCol)} IN (${sub})`]);
  }
  refs.set("companies", [...refs.get("companies") ?? [], `${q("id")} = '${companyId}'`]);
  for (const [t, parts] of refs) {
    where.set(t, parts.join(" OR "));
    kind.set(t, "reference");
  }
  return { where, kind };
}
function order(names, fks) {
  const set = new Set(names);
  const deps = new Map(names.map((n) => [n, /* @__PURE__ */ new Set()]));
  for (const f of fks) if (set.has(f.src) && set.has(f.dst) && f.src !== f.dst) deps.get(f.src).add(f.dst);
  const out = [];
  const left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)].every((d) => !left.has(d)));
    const pick = ready.length ? ready : [[...left][0]];
    for (const n of pick.sort()) {
      out.push(n);
      left.delete(n);
    }
  }
  return out;
}
function exportCmd() {
  const who = args[1];
  if (!who) throw new Error("\u015Firket id veya slug ver");
  const db = opt("db", "addinvoice_db");
  if (!/^[A-Za-z0-9_.-]+$/.test(who)) throw new Error("ge\xE7ersiz \u015Firket kimli\u011Fi");
  const found = rows(db, `select id, slug, name from companies where id='${who}' or slug='${who}'`);
  if (found.length !== 1) throw new Error(`\u015Firket bulunamad\u0131: ${who}`);
  const [companyId, slug, name] = found[0];
  const meta = loadMeta(db);
  const { where, kind } = plan(meta, companyId);
  const names = order([...where.keys()], meta.fks);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
  const out = opt("out") ?? `/var/backups/addinvoice-companies/${slug}-${stamp}`;
  fs.mkdirSync(out, { recursive: true });
  fs.chmodSync(out, 448);
  try {
    execFileSync("chown", ["postgres:postgres", out]);
  } catch {
  }
  const manifestTables = [];
  for (const t of names) {
    const m = meta.tables.get(t);
    const w = where.get(t);
    const n = Number(psql(db, `select count(*) from ${q(t)} where ${w}`));
    const colList = m.cols.map((c) => q(c.name)).join(", ");
    let file = null;
    if (n > 0) {
      file = `${t}.csv`;
      psql(db, `\\copy (select ${colList} from ${q(t)} where ${w}) to '${path.join(out, file)}' with (format csv, header true)`);
    }
    manifestTables.push({ name: t, kind: kind.get(t), columns: m.cols.map((c) => c.name), rows: n, file, where: w });
  }
  const fingerprint = crypto.createHash("sha256").update(names.map((t) => `${t}:` + meta.tables.get(t).cols.map((c) => `${c.name}/${c.type}`).join(",")).join("|")).digest("hex");
  const manifest = { tool: "company-backup/1", createdAt: (/* @__PURE__ */ new Date()).toISOString(), sourceDb: db, company: { id: companyId, slug, name }, schemaFingerprint: fingerprint, withFiles: false, tables: manifestTables };
  if (flag("with-files")) {
    const root = path.resolve(process.env.UPLOAD_PATH || "./uploads");
    const dir = path.join(root, slug);
    if (fs.existsSync(dir)) {
      execFileSync("tar", ["czf", path.join(out, "uploads.tar.gz"), "-C", root, slug]);
      manifest.withFiles = true;
    } else console.warn(`! uploads klas\xF6r\xFC yok: ${dir} (dosyas\u0131z yedek)`);
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  const total = manifestTables.reduce((s, t) => s + t.rows, 0);
  console.log(`\u2714 ${name} (${slug}) \u2192 ${out}
  ${manifestTables.filter((t) => t.rows > 0).length} tablo, ${total} sat\u0131r${manifest.withFiles ? ", dosyalar dahil" : ""}`);
}
function importCmd() {
  const dir = path.resolve(args[1] ?? "");
  const target = opt("target-db");
  if (!target) throw new Error("--target-db ver (ge\xE7ici/bo\u015F bir veritaban\u0131; canl\u0131ya --replace-company ile dikkatle)");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const meta = loadMeta(target);
  for (const t of manifest.tables) {
    const m = meta.tables.get(t.name);
    if (!m) throw new Error(`hedefte tablo yok: ${t.name} (\xF6nce \u015Femay\u0131 uygula: prisma db push)`);
    const missing = t.columns.filter((c) => !m.cols.some((x) => x.name === c));
    if (missing.length) throw new Error(`hedefte kolon yok: ${t.name}.${missing.join(",")}`);
  }
  const lines = ["SET session_replication_role = replica;"];
  if (flag("replace-company")) {
    lines.push(`-- --replace-company: \u015Firketin mevcut sat\u0131rlar\u0131 \xF6nce silinir`);
    for (const t of [...manifest.tables].reverse().filter((t2) => t2.kind !== "reference")) lines.push(`DELETE FROM ${q(t.name)} WHERE ${t.where};`);
  }
  for (const t of manifest.tables) {
    if (!t.file) continue;
    const cols = t.columns.map(q).join(", ");
    lines.push(`CREATE TEMP TABLE _imp AS SELECT ${cols} FROM ${q(t.name)} WITH NO DATA;`);
    lines.push(`\\copy _imp FROM '${path.join(dir, t.file)}' WITH (FORMAT csv, HEADER true)`);
    lines.push(`INSERT INTO ${q(t.name)} (${cols}) SELECT ${cols} FROM _imp${t.kind === "reference" ? " ON CONFLICT DO NOTHING" : ""};`);
    lines.push(`DROP TABLE _imp;`);
  }
  const script = path.join(dir, "import.sql");
  fs.writeFileSync(script, lines.join("\n") + "\n");
  try {
    execFileSync("chown", ["postgres:postgres", script]);
  } catch {
  }
  execFileSync(PSQL[0], [...PSQL.slice(1), "-X", "-v", "ON_ERROR_STOP=1", "-1", "-d", target, "-f", script], { stdio: "inherit" });
  if (flag("with-files") && fs.existsSync(path.join(dir, "uploads.tar.gz"))) {
    const up = opt("uploads-dir");
    if (!up) throw new Error("--with-files i\xE7in --uploads-dir ver");
    fs.mkdirSync(up, { recursive: true });
    execFileSync("tar", ["xzf", path.join(dir, "uploads.tar.gz"), "-C", up]);
    console.log(`\u2714 dosyalar \u2192 ${up}/${manifest.company.slug}`);
  }
  console.log(`\u2714 i\xE7e aktar\u0131ld\u0131 \u2192 ${target}. Do\u011Frula: company-backup.ts verify ${dir} --target-db ${target}`);
}
function verifyCmd() {
  const dir = path.resolve(args[1] ?? "");
  const target = opt("target-db");
  if (!target) throw new Error("--target-db ver");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  let bad = 0;
  for (const t of manifest.tables) {
    const n = Number(psql(target, `select count(*) from ${q(t.name)} where ${t.where}`));
    const ok = n === t.rows;
    if (!ok) {
      bad++;
      console.log(`\u2718 ${t.name}: yedekte ${t.rows}, hedefte ${n}`);
    }
  }
  console.log(bad === 0 ? `\u2714 ${manifest.tables.length} tablonun sat\u0131r say\u0131lar\u0131 ayn\u0131` : `\u2718 ${bad} tabloda fark var`);
  process.exitCode = bad === 0 ? 0 : 1;
}
try {
  if (cmd === "export") exportCmd();
  else if (cmd === "import") importCmd();
  else if (cmd === "verify") verifyCmd();
  else console.log("kullan\u0131m: export <\u015Firket> | import <dizin> --target-db X | verify <dizin> --target-db X  (ba\u015Fl\u0131ktaki a\xE7\u0131klamaya bak)");
} catch (e) {
  console.error("\u2718", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
