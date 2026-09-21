// Exercises Undo and a failing migration against a real Postgres, through the app's own API.
// "Undone" means the schema dump is identical to the one taken before, and no rows were lost.
//
//   node scripts/creator-undo-live.mjs [http://127.0.0.1:4477] [docker container = pgx-test]
//
// The app must be connected to that container's server. A scratch database is created and dropped.
import { execFileSync } from "node:child_process";

const base = (process.argv[2] ?? "http://127.0.0.1:4477") + "/api";
const container = process.argv[3] ?? "pgx-test";
const DB = "creator_undo_check", ROLE = "undo_check_reader";
const call = async (path, body) => (await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const psql = (db, sql) => execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", db, "-Atc", sql], { encoding: "utf8" }).trim();
const dump = () => execFileSync("docker", ["exec", container, "pg_dump", "-U", "postgres", "-s", "--no-owner", DB], { encoding: "utf8" })
  .split("\n").filter((l) => l && !/^(--|SET |SELECT pg_catalog|\\)/.test(l)).join("\n");
const rows = () => psql(DB, "select coalesce(string_agg(relname || '=' || n_live_tup, ',' order by relname), '') from pg_stat_user_tables");

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n       ${detail}` : ""}`); if (!ok) failures++; };
const T = (b, ...args) => (args.length ? { base: b, args } : { base: b });

async function apply(ops, { confirm } = {}) {
  const draft = await call("/create/draft/compile", { ops });
  if (draft.error) throw new Error(draft.error);
  if (draft.broken.length) return { ok: false, broken: draft.broken, draft };
  const trial = await call("/create/apply", { ops: draft.ops, fingerprint: draft.fingerprint, dryRun: true });
  const real = await call("/create/apply", { ops: draft.ops, fingerprint: draft.fingerprint, confirm: confirm ? draft.confirmPhrase : undefined });
  return { ...real, trial, draft };
}

const status = await call("/status");
if (!status.connected) throw new Error("Connect the app to the scratch server first");
const home = status.connection.database;
try { psql("postgres", `drop database if exists ${DB}`); psql("postgres", `drop role if exists ${ROLE}`); } catch { /* first run */ }

try {
  await call("/create/database", { name: DB });
  console.log(`scratch database ${DB} on ${container}\n`);

  // ---- a baseline with data in it
  const baseline = await apply([
    { kind: "create_enum", name: "order_status", values: ["pending", "paid", "cancelled"] },
    { kind: "create_table", name: "customers", columns: [{ name: "name", type: T("text"), nullable: false, archetype: "person_name" }, { name: "email", type: T("text"), nullable: false, unique: true, archetype: "email" }, { name: "country", type: T("text"), archetype: "country" }] },
    { kind: "create_table", name: "orders", columns: [{ name: "customer_id", ref: { table: "public.customers", onDelete: "restrict" }, nullable: false }, { name: "status", type: { enum: "public.order_status" }, nullable: false }, { name: "quantity", type: T("integer"), nullable: false, archetype: "quantity", check: "positive" }, { name: "unit_price", type: T("numeric", 12, 2), nullable: false, archetype: "money" }, { name: "placed_at", type: T("timestamptz"), nullable: false }] },
    { kind: "seed", tables: [], rows: 30, seedValue: 5 },
  ]);
  check("baseline applied with 60 rows", baseline.ok === true, JSON.stringify(baseline.failed ?? baseline.broken ?? ""));
  psql(DB, "analyze");
  const schema0 = dump(), rows0 = rows();

  // ---- 1. a wide migration, then undo it
  const wide = [
    { kind: "add_column", table: "public.customers", column: { name: "phone", type: T("text") } },
    { kind: "rename_column", table: "public.customers", column: "name", name: "full_name" },
    { kind: "set_not_null", table: "public.customers", column: "country" },
    { kind: "set_default", table: "public.customers", column: "country", default: { kind: "string", value: "Unknown" } },
    { kind: "add_unique", table: "public.customers", columns: ["full_name", "email"] },
    { kind: "add_index", table: "public.orders", columns: ["placed_at"] },
    { kind: "create_enum", name: "order_channel", values: ["web", "phone"] },
    { kind: "add_column", table: "public.orders", column: { name: "channel", type: { enum: "public.order_channel" }, nullable: false, default: { kind: "enum_label", value: "web" } } },
    { kind: "add_generated_column", table: "public.orders", name: "line_total", template: "multiply", columns: ["quantity", "unit_price"] },
    { kind: "add_generated_column", table: "public.orders", name: "is_bulk", template: "when", condition: { column: "quantity", test: "gt", value: 50 } },
    { kind: "set_fk_action", table: "public.orders", name: "orders_customer_id_fkey", onDelete: "cascade" },
    { kind: "create_view", name: "paid_orders", table: "public.orders", flags: [], filter: { column: "status", test: "eq", value: { label: "paid" } } },
    { kind: "create_role", name: ROLE }, { kind: "grant", role: ROLE, privileges: ["SELECT"], allIn: "public" },
    { kind: "rename_table", table: "public.orders", name: "purchases" },
  ];
  const forward = await apply(wide);
  check(`a ${wide.length}-change migration applies (${forward.draft?.statements.length} statements)`, forward.ok === true, JSON.stringify(forward.failed ?? forward.broken ?? ""));
  check("the trial run before it left no trace and agreed with the real run", forward.trial?.ok === true);
  const schema1 = dump();
  check("the schema really changed", schema1 !== schema0);

  let history = await call("/create/history");
  check("History offers undo for it", history[0]?.undoable === true, history[0]?.reason ?? "");
  const inverse = await call("/create/undo", { id: history[0].id });
  check(`undo stages ${inverse.ops?.length} inverse changes`, Array.isArray(inverse.ops) && inverse.ops.length > 0, inverse.error ?? "");
  const compiled = await call("/create/draft/compile", { ops: inverse.ops });
  check("the undo is flagged destructive and asks for the database name (it drops columns that may hold data)", compiled.level === "destructive" && compiled.confirmPhrase === DB);
  const refused = await call("/create/apply", { ops: compiled.ops, fingerprint: compiled.fingerprint });
  check("without the name typed, the server refuses it", Boolean(refused.error) && /Type the database name/.test(refused.error), refused.error ?? JSON.stringify(refused));
  const back = await apply(inverse.ops, { confirm: true });
  check("undo applies", back.ok === true, JSON.stringify(back.failed ?? back.broken ?? ""));
  const schema2 = dump();
  check("after undo the schema dump is identical to the original", schema2 === schema0, schema2 === schema0 ? "" : diffLines(schema0, schema2));
  psql(DB, "analyze");
  check("and no rows were lost", rows() === rows0, `${rows0} → ${rows()}`);
  check("the role is gone again", psql("postgres", `select count(*) from pg_roles where rolname='${ROLE}'`) === "0");

  // ---- 2. a migration that fails half way
  const before = dump(), historyBefore = (await call("/create/history")).length;
  const failing = [
    { kind: "add_column", table: "public.customers", column: { name: "nickname", type: T("text") } },
    { kind: "add_index", table: "public.orders", columns: ["placed_at"] },
    { kind: "add_unique", table: "public.orders", columns: ["status"] }, // 30 rows, 3 values: must fail
    { kind: "add_column", table: "public.orders", column: { name: "note", type: T("text") } },
  ];
  const broke = await apply(failing);
  check("the trial run catches the failure before anything is applied", broke.trial?.ok === false && broke.trial.failed?.index === 2, JSON.stringify(broke.trial?.failed ?? broke.trial));
  check("applied anyway, it fails on the same statement and names it", broke.ok === false && broke.failed?.index === 2 && /UNIQUE \("status"\)/.test(broke.failed.sql) && broke.failed.code === "23505", JSON.stringify(broke.failed));
  check("the two statements before it were rolled back: schema unchanged", dump() === before);
  check("nothing was logged for the failed migration", (await call("/create/history")).length === historyBefore);

  // ---- 3. what cannot be undone says so
  const lossy = await apply([{ kind: "drop_column", table: "public.customers", column: "country" }], { confirm: true });
  history = await call("/create/history");
  check("a migration that deleted data is applied but not offered for undo", lossy.ok === true && history[0].undoable === false && /deleted data/.test(history[0].reason), history[0]?.reason);

  // ---- 4. undo is withdrawn when the database has moved on
  const small = await apply([{ kind: "add_column", table: "public.customers", column: { name: "vip", type: T("boolean"), nullable: false, default: { kind: "bool", value: false } } }]);
  history = await call("/create/history");
  check("a fresh migration is undoable", small.ok === true && history[0].undoable === true, history[0]?.reason ?? "");
  const undoOps = (await call("/create/undo", { id: history[0].id })).ops;
  const previewed = await call("/create/draft/compile", { ops: undoOps });
  psql(DB, "alter table customers add column changed_elsewhere int"); // someone changes the schema outside the app
  history = await call("/create/history");
  check("History withdraws the offer once the schema has changed elsewhere", history[0].undoable === false && /changed since/.test(history[0].reason ?? ""), history[0]?.reason ?? "still undoable");
  const stale = await call("/create/apply", { ops: previewed.ops, fingerprint: previewed.fingerprint, confirm: previewed.confirmPhrase ?? undefined });
  check("and applying the undo previewed before that change is refused", Boolean(stale.error) && /changed since/.test(stale.error), stale.error ?? JSON.stringify(stale).slice(0, 200));
} finally {
  await call("/switch-database", { database: home }).catch(() => {});
  try { psql("postgres", `drop database if exists ${DB}`); psql("postgres", `drop role if exists ${ROLE}`); } catch (err) { console.log("cleanup:", err.message.split("\n")[0]); }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

function diffLines(a, b) {
  const A = new Set(a.split("\n")), B = new Set(b.split("\n"));
  return [...[...A].filter((l) => !B.has(l)).map((l) => `- ${l}`), ...[...B].filter((l) => !A.has(l)).map((l) => `+ ${l}`)].slice(0, 12).join("\n       ");
}
