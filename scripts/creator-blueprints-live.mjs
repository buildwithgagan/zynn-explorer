// Dry-runs every blueprint (all options on) plus sample data against the connected database, through the
// app's own API. Nothing is committed. Usage: node scripts/creator-blueprints-live.mjs [http://127.0.0.1:4477]
import { BLUEPRINTS, instantiate } from "../server/create/blueprints/index.js";

const base = (process.argv[2] ?? "http://127.0.0.1:4477") + "/api";
const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

const status = await (await fetch(base + "/status")).json();
if (!status.connected) throw new Error("Connect the app to a scratch database first");
console.log(`database: ${status.connection.database}`);
let failed = 0;
for (const b of BLUEPRINTS) {
  const { ops } = instantiate(b, { optional: new Set(b.optional.map((o) => o.id)) });
  ops.push({ kind: "seed", tables: [], rows: 30, seedValue: 11 });
  const draft = await post("/create/draft/compile", { ops });
  const result = draft.error ? draft : await post("/create/apply", { ops: draft.ops, fingerprint: draft.fingerprint, dryRun: true });
  const ok = result.ok && !draft.broken.length;
  if (!ok) failed++;
  const tables = draft.erd?.tables.filter((t) => t.state === "added").length;
  console.log(`${ok ? "ok  " : "FAIL"} ${b.id.padEnd(18)} ${tables} tables, ${draft.statements?.length} statements, ${result.results?.at(-1)?.rowCount ?? "-"} rows` +
    (ok ? "" : `\n     ${JSON.stringify(result.failed ?? result.error ?? draft.broken)}`));
}
process.exit(failed ? 1 : 0);
