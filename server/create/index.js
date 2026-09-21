import * as db from "../db.js";
import { invalidateModel, loadModel } from "../nl/model.js";
import { loadDesign, invalidateDesign, fingerprint, toErd } from "./design.js";
import { cleanOps, newId } from "./ops.js";
import { compileOps, migrationSql } from "./compile.js";
import { checkNewIdent, OpError } from "./validate.js";
import { advise as runAdvisor } from "./advisor.js";
import { apply as runApply } from "./apply.js";
import { interpret as understand } from "./understand.js";
import { splitChanges } from "../nl/candidates.js";
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

/** Read one request against the draft as it stands, and report honestly what the compiler then made of it. */
async function interpretOne(request, rawOps, focus) {
  const before = await view(rawOps);
  const read = await understand(request, before.baseline, before.compiled.draft, before.compiled.ops, focus);
  const after = read.ok ? (await view(read.ops)).payload : before.payload;
  // An op the compiler refuses is reported, not silently dropped.
  const refused = after.broken.filter((b) => read.added?.includes(b.id));
  const reply = { ...read.reply };
  if (refused.length && refused.length === read.added.length) {
    // Nothing survived the compiler, so "Staged: …" would be wrong. Say what stopped it instead.
    reply.text = `I understood that, but it cannot be staged: ${refused[0].reason}.`;
    reply.notes = refused.slice(1).map((b) => `${b.reason}.`);
  } else if (refused.length) reply.notes = [...(reply.notes ?? []), ...refused.map((b) => `I could not stage part of that: ${b.reason}.`)];
  const draft = { ...after, ops: after.ops.filter((o) => !refused.some((b) => b.id === o.id)) };
  return { read, reply, draft, ok: read.ok && (read.added.length === 0 || refused.length < read.added.length) };
}

export async function interpret(body) {
  const request = String(body?.request ?? "").trim();
  if (!request) throw fail(400, "Say what you want to build or change");
  if (request.length > 900) throw fail(400, "Keep the request under 900 characters");
  const started = performance.now();
  // A message may hold several changes. Each is read in turn against the draft the previous one left, so
  // "create …, then index it" works, and what one was about carries to the next ("… and make it required").
  const pieces = splitChanges(request);
  let ops = body?.ops, focus = {}, last = null;
  const parts = [], usage = { requests: 0, input_tokens: 0, output_tokens: 0 };
  for (const [i, piece] of pieces.entries()) {
    const one = await interpretOne(piece, ops, focus);
    last = one;
    ops = one.draft.ops;
    if (one.ok && one.read.subject?.table) focus = one.read.subject;
    for (const k of Object.keys(usage)) usage[k] += one.read.usage?.[k] ?? 0;
    parts.push({
      request: piece, ok: one.ok, text: one.reply.text, notes: one.reply.notes ?? [], added: one.read.added ?? [],
      suggestions: one.read.suggestions ?? [], clarify: one.read.clarify, askInstead: one.read.askInstead, pendingDatabase: one.read.pendingDatabase, focus: one.read.focus,
      judgments: (one.read.judgments ?? []).map((j) => (pieces.length > 1 ? { ...j, key: `${i}:${j.key}`, group: piece } : j)),
    });
  }
  const common = {
    added: parts.flatMap((p) => p.added), suggestions: parts.flatMap((p) => p.suggestions).slice(0, 6), judgments: parts.flatMap((p) => p.judgments),
    pendingDatabase: parts.find((p) => p.pendingDatabase)?.pendingDatabase, askInstead: parts.find((p) => p.askInstead)?.askInstead,
    focus: parts.findLast((p) => p.focus)?.focus, usage, model: last.read.model, ms: Math.round(performance.now() - started), draft: last.draft,
  };
  if (parts.length === 1) return { ok: parts[0].ok, reply: { text: parts[0].text, notes: parts[0].notes }, clarify: parts[0].clarify, ...common };

  // Several changes: one line each, so a part that was not understood is as visible as the parts that were.
  const done = parts.filter((p) => p.ok).length;
  const strip = (t) => t.replace(/\s*Nothing has touched the database yet\. Review it on the right, then press Apply\.$/, "");
  return {
    ok: done > 0,
    reply: {
      text: done === parts.length ? `I took that as ${parts.length} changes and staged all of them. Nothing has touched the database yet. Review them on the right, then press Apply.`
        : done ? `I took that as ${parts.length} changes. ${done} ${done === 1 ? "is" : "are"} staged; ${parts.length - done} I could not do, and nothing of ${parts.length - done === 1 ? "it" : "them"} was applied. Nothing has touched the database yet.`
        : `I took that as ${parts.length} changes, and could not do any of them.`,
      parts: parts.map((p) => ({ request: p.request, ok: p.ok, text: strip(p.text), notes: p.notes })),
      notes: [],
    },
    ...common,
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
  invalidateDesign(); // whether undo is still possible depends on the schema as it is right now
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
