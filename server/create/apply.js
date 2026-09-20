import { withTransaction, connectionInfo } from "../db.js";
import { invalidateModel } from "../nl/model.js";
import { loadDesign, fingerprint } from "./design.js";
import { compileOps } from "./compile.js";
import * as seed from "./seed.js";
import * as history from "./history.js";
import { summarizeOps } from "./wording.js";

const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

/**
 * Run a draft as one transaction. Everything the browser sent is re-derived here: the ops are replayed on
 * the live design, so the SQL that runs is the SQL this server compiled, never text from the request.
 */
export async function apply(ops, { confirm, fingerprint: expected, dryRun = false } = {}) {
  const baseline = await loadDesign();
  if (expected && expected !== fingerprint(baseline)) throw fail(409, "The database changed since this draft was previewed. Review the refreshed draft, then apply again.");
  const compiled = compileOps(baseline, ops);
  if (compiled.broken.length) throw fail(400, `${compiled.broken.length} change${compiled.broken.length === 1 ? "" : "s"} in the draft no longer fit: ${compiled.broken[0].reason}`);
  if (!compiled.statements.length) throw fail(400, "There is nothing to apply");
  if (!dryRun && compiled.confirmPhrase && confirm !== compiled.confirmPhrase) throw fail(400, `Type the database name (${compiled.confirmPhrase}) to confirm the destructive changes`);

  const results = [];
  let current = null;
  const started = performance.now();
  try {
    await withTransaction(async (exec) => {
      // Seeding needs the design as it stands once the statements before it have run.
      for (const [index, statement] of compiled.statements.entries()) {
        current = { index, sql: statement.sql };
        const t0 = performance.now();
        const rowCount = statement.seed ? await seed.run(exec, compiled.draft, statement.seed) : (await exec(statement.sql)).rowCount;
        results.push({ index, rowCount: rowCount ?? null, ms: Math.round(performance.now() - t0) });
      }
    }, { dryRun });
  } catch (err) {
    if (!err.code && err.status !== 400) throw err;
    // Reported as a result, not an HTTP error: the caller needs to know which statement failed.
    return { ok: false, dryRun, failed: { ...current, error: err.message, code: err.code, hint: err.hint, detail: err.detail } };
  }
  const ms = Math.round(performance.now() - started);
  if (dryRun) return { ok: true, dryRun: true, results, ms };

  invalidateModel();
  const after = await loadDesign();
  const entry = await history.append(history.databaseKey(connectionInfo()), {
    summary: summarizeOps(compiled.ops), ops: compiled.ops, sql: compiled.statements.map((s) => s.sql),
    inverseOps: compiled.inverse, fingerprintAfter: fingerprint(after),
  }).catch(() => null); // a read-only project folder must not turn a committed migration into an error
  return { ok: true, dryRun: false, results, ms, historyId: entry?.id ?? null, fingerprint: fingerprint(after) };
}
