import * as db from "../db.js";
import { invalidateModel, loadModel } from "../nl/model.js";
import { loadDesign, fingerprint, toErd } from "./design.js";
import { cleanOps, newId } from "./ops.js";
import { compileOps, migrationSql } from "./compile.js";
import { checkNewIdent, OpError } from "./validate.js";
import { advise as runAdvisor } from "./advisor.js";
import { apply as runApply } from "./apply.js";
import { interpret as understand } from "./understand.js";
import { describeOp, CONVENTIONS } from "./wording.js";
import { BLUEPRINTS } from "./blueprints/index.js";
import { TYPES } from "./types.js";
import * as history from "./history.js";
import { schemaSql, migrationFiles, tar } from "./export.js";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Known category values per text column, from pg_stats. Best effort: the advisor works without them. */
async function knownValues() {
  try {
    const model = await loadModel();
    const out = {};
    for (const t of model.tables.values()) for (const c of t.columns) if (c.kind === "text" && c.values?.length) (out[t.id] ??= {})[c.name] = c.values;
    return out;
  } catch {
    return {};
  }
}

/** Everything the page needs to show a draft. Also how an untrusted draft from the browser is validated: by replaying it. */
async function view(rawOps) {
  const baseline = await loadDesign();
  const compiled = compileOps(baseline, cleanOps(rawOps));
  const findings = runAdvisor(compiled.draft, await knownValues());
  return {
    baseline, compiled,
    payload: {
      database: baseline.database,
      ops: compiled.ops.map((op) => ({ ...op, label: describeOp(op) })),
      broken: compiled.broken,
      decisions: compiled.ops.filter((o) => o.kind === "create_table").map((o) => ({
        opId: o.id, table: o.name, items: Object.entries(CONVENTIONS).map(([key, c]) => ({ key, ...c, value: o.conventions[key] })),
      })),
      erd: toErd(baseline, compiled.draft, compiled.renames),
      statements: compiled.statements, sql: migrationSql(compiled.statements), notes: compiled.notes,
      level: compiled.level, confirmPhrase: compiled.confirmPhrase, fingerprint: fingerprint(baseline),
      findings, enums: Object.keys(compiled.draft.enums), roles: Object.keys(compiled.draft.roles), types: Object.keys(TYPES),
      empty: !Object.keys(baseline.tables).length,
    },
  };
}

export async function compile(body) {
  return (await view(body?.ops)).payload;
}

export async function interpret(body) {
  const request = String(body?.request ?? "").trim();
  if (!request) throw fail(400, "Say what you want to build or change");
  if (request.length > 600) throw fail(400, "Keep the request under 600 characters");
  const started = performance.now();
  const before = await view(body?.ops);
  const read = await understand(request, before.baseline, before.compiled.draft, before.compiled.ops);
  const after = read.ok ? (await view(read.ops)).payload : before.payload;
  // An op the compiler refuses is reported, not silently dropped.
  const refused = after.broken.filter((b) => read.added?.includes(b.id));
  const reply = { ...read.reply };
  if (refused.length && refused.length === read.added.length) {
    // Nothing survived the compiler, so "Staged: …" would be wrong. Say what stopped it instead.
    reply.text = `I understood that, but it cannot be staged: ${refused[0].reason}.`;
    reply.notes = refused.slice(1).map((b) => `${b.reason}.`);
  } else if (refused.length) reply.notes = [...(reply.notes ?? []), ...refused.map((b) => `I could not stage part of that: ${b.reason}.`)];
  return {
    ok: read.ok && (read.added.length === 0 || refused.length < read.added.length), reply,
    added: read.added, suggestions: (read.suggestions ?? []).slice(0, 6), clarify: read.clarify, askInstead: read.askInstead,
    pendingDatabase: read.pendingDatabase, focus: read.focus, judgments: read.judgments,
    usage: read.usage, model: read.model, ms: Math.round(performance.now() - started),
    draft: { ...after, ops: after.ops.filter((o) => !refused.some((b) => b.id === o.id)) },
  };
}

export async function apply(body) {
  return runApply(cleanOps(body?.ops), { confirm: body?.confirm, fingerprint: body?.fingerprint, dryRun: Boolean(body?.dryRun) });
}

export async function createDatabase(body) {
  const name = String(body?.name ?? "").trim();
  try { checkNewIdent(name, "database name"); } catch (err) { if (err instanceof OpError) throw fail(400, err.message); throw err; }
  await db.createDatabase(name);
  invalidateModel();
  return db.switchDatabase(name);
}

export async function advise(body) {
  return { findings: (await view(body?.ops)).payload.findings };
}

export async function seed(body) {
  const ops = [...cleanOps(body?.ops), { id: newId(), kind: "seed", tables: body?.tables ?? [], rows: body?.rows ?? 25, seedValue: (Date.now() % 100_000) + 1 }];
  return (await view(ops)).payload;
}

export async function listHistory() {
  const live = fingerprint(await loadDesign());
  const entries = await history.list(history.databaseKey(db.connectionInfo()));
  return entries.map((e, i) => ({
    id: e.id, at: e.at, summary: e.summary, statements: e.sql?.length ?? 0, sql: (e.sql ?? []).join("\n\n"),
    undoable: Boolean(e.inverseOps) && i === 0 && e.fingerprintAfter === live,
    reason: !e.inverseOps ? "It deleted data or added an enum value, which cannot be reversed" : i !== 0 ? "Only the latest migration can be undone" : e.fingerprintAfter !== live ? "The database has changed since" : undefined,
  }));
}

export async function undo(body) {
  const entry = await history.get(history.databaseKey(db.connectionInfo()), String(body?.id ?? ""));
  if (!entry?.inverseOps) throw fail(400, "That migration cannot be undone");
  return { ops: cleanOps(entry.inverseOps) };
}

const STARTERS = {
  ecommerce: "Build me a database for an online store", blog_cms: "Design a database for a blog with tags and comments",
  crm: "I need a CRM database", saas_multitenant: "Design a multi-tenant SaaS database", booking_clinic: "Build me a database for a vet clinic",
  inventory: "Design an inventory database with suppliers and warehouses", lms: "Build a database for an online course platform",
  helpdesk: "I need a helpdesk ticketing database", hr: "Design an HR database with employees and leave requests",
  finance_ledger: "Build a double-entry accounting ledger",
};

export function starters() {
  return BLUEPRINTS.map((b) => ({ id: b.id, title: b.title, say: STARTERS[b.id] ?? `Design a database for ${b.title.toLowerCase()}` }));
}

/** The schema as it stands, and every migration applied from here, as files to take elsewhere. */
export async function exportSql() {
  const design = await loadDesign();
  const files = migrationFiles(await history.list(history.databaseKey(db.connectionInfo())), design.database);
  return {
    database: design.database,
    schema: { name: `${design.database}_schema.sql`, content: schemaSql(design) },
    migrations: files.map((f) => f.name),
    archive: files.length ? { name: `${design.database}_migrations.tar`, base64: Buffer.from(tar(files)).toString("base64") } : null,
  };
}
