import { ask, choice, noul } from "../jev.js";
import { identCandidates, numberCandidates, tableIdent, singularize } from "../nl/candidates.js";
import { ARCHETYPES, archetypeByName, columnFromArchetype } from "./archetypes.js";
import { BLUEPRINTS, blueprintById, entitiesOf, instantiate } from "./blueprints/index.js";
import { newId } from "./ops.js";
import { safeName } from "./validate.js";
import { typeLabel } from "./types.js";
import { stagedReply, noBlueprintReply, describeOp, DECLINES } from "./wording.js";

// Natural language → ops, with Jev. Jev returns judgments, never text, so the shape is always:
// code finds the candidates (phrases in the request, tables, columns, archetypes, blueprints),
// Jev selects among them, and code builds the ops. Two requests per message: the first routes the
// request and classifies its phrases, the second asks everything the chosen kind of change needs.

const NONE = "__none__";
const NEW = "__new__";
const STATED = 0.6;    // something the request says
const INFERRED = 0.85; // something the request only implies, or anything destructive
const OPTIONAL = 0.75; // an optional part of a blueprint: measured at ≥ 0.89 when asked for, ≤ 0.59 when not
const MAX_TABLES = 150;
const MAX_FIELDS = 16;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ranked = (answer) => Object.entries(answer?.probabilities ?? {}).map(([value, p]) => ({ value, p })).sort((a, b) => b.p - a.p);
const top = (answer) => ranked(answer)[0] ?? { value: null, p: 0 };

const OPS = {
  design_domain: "Design a whole database or system for some business or purpose, with several tables at once. Examples: 'build me a database for a vet clinic', 'I need an online store', 'schema for a blog'.",
  new_database: "Create a new, empty database on the server. Examples: 'create a database called shop', 'new db named testing'.",
  create_table: "Create one or more specific new tables, usually naming their fields. Examples: 'create a table called invoices with number and amount', 'add a suppliers table'.",
  add_columns: "Add one or more new columns or fields to a table that already exists. Examples: 'add a phone number to customers', 'patients also need date of birth and allergies'.",
  change_column: "Change how an existing column behaves: the type of data it holds, whether it is required or optional, or whether its values must be unique. Examples: 'make email required', 'phone should be optional', 'change price to a decimal', 'change quantity to a big whole number', 'turn notes into json', 'emails must be unique'.",
  rename_thing: "Give an existing table or column a different name. Examples: 'rename clients to customers', 'call the fullname column name instead'.",
  remove_thing: "Delete an existing table or column. Examples: 'drop the legacy table', 'remove the fax column from contacts', 'get rid of notes'.",
  relate_tables: "Connect two tables that exist: one belongs to the other, or they are many-to-many. Examples: 'orders belong to customers', 'each post has one author', 'posts can have many tags'.",
  add_index: "Add an index to make lookups faster. Examples: 'index orders by created_at', 'add an index on email'.",
  seed_data: "Fill tables with sample, fake or test rows. Examples: 'add 50 fake rows', 'fill it with sample data', 'seed the customers table'.",
  access: "Roles, permissions or row-level security: create a role, grant or revoke access, restrict which rows someone sees. Examples: 'create a read-only role', 'let analysts read orders', 'users should only see their own rows'.",
  advise: "Review or critique the existing design and suggest improvements. Examples: 'review my schema', 'what should I improve', 'any problems with this design'.",
  data_question: "A question about the data stored in the tables, not a change to their structure. Examples: 'how many orders last month', 'show me the top customers'.",
  other: "None of the above: not a request about this database.",
};

const SPAN_ROLES = {
  table_name: "The name of a table: a kind of thing the database stores, such as customers, invoices or appointments. It may be a table to create or one that exists.",
  field_name: "The complete name of exactly one column or field of a table, such as email, due date or first name.",
  fragment: "Only part of a longer name that appears in the request, or several names run together. Example: 'date' inside 'date of birth'.",
  example_value: "One of the allowed values of a field, such as 'pending', 'paid' or 'admin'.",
  role_name: "The name of a database role, user or group that gets permissions, such as analyst or app_readonly.",
  database_name: "The name of a whole database to create.",
  [NONE]: "None of these: a word describing the business, a purpose, or filler.",
};

const SIMPLE_TYPES = {
  text: [{ base: "text" }, "free text of any length"],
  integer: [{ base: "integer" }, "a whole number"],
  bigint: [{ base: "bigint" }, "a very large whole number"],
  decimal: [{ base: "numeric" }, "a number with decimals"],
  money: [{ base: "numeric", args: [12, 2] }, "an amount of money"],
  boolean: [{ base: "boolean" }, "yes or no, true or false"],
  date: [{ base: "date" }, "a calendar date without a time"],
  timestamp: [{ base: "timestamptz" }, "a date together with a time"],
  uuid: [{ base: "uuid" }, "a UUID"],
  json: [{ base: "jsonb" }, "JSON, structured free-form data"],
};

function describeTable(t) {
  const names = t.columns.slice(0, 14).map((c) => c.name).join(", ");
  return truncate(`${t.comment ? t.comment + ". " : ""}Columns: ${names}${t.columns.length > 14 ? ", …" : ""}`, 300);
}

/** New tables go where the existing ones live: the schema holding the most tables, else public. */
export function defaultSchema(design) {
  const counts = new Map();
  for (const t of Object.values(design.tables)) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return busiest ?? (design.schemas.includes("public") ? "public" : design.schemas[0] ?? "public");
}

/** Labels are what Jev sees for a table: the bare name unless two schemas share it. */
function labelTables(design) {
  const entries = Object.entries(design.tables).slice(0, MAX_TABLES);
  const counts = new Map();
  for (const [, t] of entries) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return entries.map(([id, t]) => ({ id, table: t, label: counts.get(t.name) > 1 ? id : t.name }));
}

class Reading {
  constructor() { this.judgments = []; this.usage = { requests: 0, input_tokens: 0, output_tokens: 0 }; this.model = null; }
  async ask(state, questions) {
    const response = await ask(state, questions);
    this.usage.requests++;
    this.usage.input_tokens += response.usage?.input_tokens ?? 0;
    this.usage.output_tokens += response.usage?.output_tokens ?? 0;
    this.model = response.model ?? this.model;
    return response.answers ?? {};
  }
  choice(key, title, answer, { applied = true, labels = {}, bar = STATED } = {}) {
    const [first, ...rest] = ranked(answer);
    if (!first) return { value: null, p: 0, ok: false };
    const ok = first.p >= bar;
    this.judgments.push({ key, title, value: labels[first.value] ?? first.value, p: first.p, applied: applied && ok,
      alternatives: rest.filter((a) => a.p >= 0.05).slice(0, 3).map((a) => ({ label: labels[a.value] ?? a.value, p: a.p })) });
    return { value: first.value, p: first.p, ok };
  }
  noul(key, title, answer, { value = "yes", bar = STATED, quietBelow = 0.3 } = {}) {
    const p = answer?.noul ?? 0;
    if (p >= quietBelow) this.judgments.push({ key, title, value, p, applied: p >= bar, alternatives: [] });
    return { p, ok: p >= bar };
  }
  rule(key, title, value) { this.judgments.push({ key, title, value, p: 1, applied: true, alternatives: [], rule: true }); }
}

// ---------------------------------------------------------------------------
// Stage 1: what kind of change, about which table, and what each phrase is.
// ---------------------------------------------------------------------------
// Two question sets, sent as two parallel requests. What exists in the database must not colour how the
// wording is read: with the tables of an online store in the state, "a database for a vet clinic" was
// judged to be an online store. So only the questions that are *about* the tables see them.
function tableQuestions(tables) {
  const tableOptions = Object.fromEntries(tables.map((t) => [t.label, describeTable(t.table)]));
  const q = {
    op: choice("A user typed `request` into a tool that designs and changes a Postgres database. The tables that exist are listed in `tables`. What is the user asking for?", OPS),
    target: choice("Which single existing table in `tables` does `request` change, add to, or ask about?", {
      ...tableOptions,
      [NEW]: "No existing table: the request is about tables that do not exist yet.",
      [NONE]: "The request does not single out one table.",
    }),
  };
  for (const t of tables) q[`uses:${t.label}`] = noul(`Does \`request\` mention or involve the existing table "${t.label}"?`);
  return q;
}

function wordingQuestions(spans) {
  const q = {
    bp: choice("Which kind of system does `request` ask to have a database designed for?", {
      ...Object.fromEntries(BLUEPRINTS.map((b) => [b.id, b.describe])),
      [NONE]: "Some other kind of system, or the request does not ask for a whole database design.",
    }),
  };
  for (const b of BLUEPRINTS) q[`bpfit:${b.id}`] = noul(`Would a database for this purpose fit what \`request\` describes? Purpose: ${b.describe}`);
  spans.forEach((s, i) => { q[`span:${i}`] = choice(`In \`request\`, what is the phrase "${s.text}"?`, SPAN_ROLES); });
  return q;
}

/** Keep the longest accepted phrase of each run: once "first name" is a field, "first" and "name" are not. */
function dropOverlaps(accepted) {
  const kept = [];
  for (const s of [...accepted].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (!kept.some((k) => k.run === s.run && s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Shared pieces of stage 2
// ---------------------------------------------------------------------------
function fieldQuestions(q, fields) {
  const archetypes = Object.fromEntries(Object.entries(ARCHETYPES).map(([id, a]) => [id, a.describe]));
  fields.forEach((f, i) => {
    if (!archetypeByName(f.ident)) q[`arch:${i}`] = choice(`In \`request\`, "${f.text}" is a field of a database table. What kind of information does it hold?`, archetypes);
    q[`req:${i}`] = noul(`Does \`request\` say that "${f.text}" is required, mandatory, or must always be filled in?`);
    q[`uniq:${i}`] = noul(`Does \`request\` say that "${f.text}" must be unique, or that no two records may share it?`);
  });
}

function valueQuestions(q, values, fields) {
  if (!fields.length) return;
  values.forEach((v, i) => {
    q[`val:${i}`] = choice(`In \`request\`, "${v.text}" is given as an allowed value. Which field is it a value of?`, {
      ...Object.fromEntries(fields.map((f, n) => [`f${n}`, `The field "${f.text}"`])), [NONE]: "None of these fields.",
    });
  });
}

/** Column specs (and the enums they need) from the answers about `fields`. */
function buildFields(reading, answers, fields, values, tableName, schema) {
  const columns = [], enums = [], weak = [];
  const valuesOf = fields.map(() => []);
  values.forEach((v, i) => {
    const pick = top(answers[`val:${i}`]);
    if (pick.value?.startsWith("f") && pick.p >= STATED) valuesOf[Number(pick.value.slice(1))].push(v.ident);
  });
  fields.forEach((f, i) => {
    const byRule = archetypeByName(f.ident);
    let archetype = byRule, sure = true;
    if (byRule) reading.rule(`arch:${i}`, `${f.ident} is`, byRule.replace(/_/g, " "));
    else {
      const a = reading.choice(`arch:${i}`, `${f.ident} is`, answers[`arch:${i}`], { labels: Object.fromEntries(Object.keys(ARCHETYPES).map((k) => [k, k.replace(/_/g, " ")])) });
      archetype = a.ok ? a.value : "plain_text";
      sure = a.ok;
    }
    const overrides = {};
    if (reading.noul(`req:${i}`, `${f.ident} required`, answers[`req:${i}`]).ok) overrides.nullable = false;
    if (reading.noul(`uniq:${i}`, `${f.ident} unique`, answers[`uniq:${i}`]).ok) overrides.unique = true;
    const column = columnFromArchetype(safeName(f.ident), archetype, overrides);
    if (valuesOf[i].length >= 2) {
      const typeName = `${singularize(tableName)}_${column.name}`;
      enums.push({ id: newId(), kind: "create_enum", schema, name: typeName, values: valuesOf[i] });
      Object.assign(column, { type: { enum: `${schema}.${typeName}` }, nullable: false, default: { kind: "enum_label", value: valuesOf[i][0] }, check: undefined, unique: undefined });
      reading.rule(`enum:${i}`, `${f.ident} values`, valuesOf[i].join(", "));
    }
    if (!sure) weak.push(column.name);
    columns.push(column);
  });
  return { columns, enums, weak };
}

/** Add columns to a table: folded into its create_table op while the table is still only a draft. */
function addColumns(ops, baseline, tableId, columns) {
  const staged = !Object.hasOwn(baseline.tables, tableId) && ops.find((o) => o.kind === "create_table" && `${o.schema}.${o.name}` === tableId);
  if (staged) {
    // A reference can only be folded in when the table it points at is created earlier in the draft.
    const at = ops.indexOf(staged);
    const tooEarly = (c) => c.ref && ops.findIndex((o) => o.kind === "create_table" && `${o.schema}.${o.name}` === c.ref.table) > at;
    const taken = new Set(staged.columns.map((c) => c.name));
    const fresh = columns.filter((c) => !taken.has(c.name));
    staged.columns.push(...fresh.filter((c) => !tooEarly(c)));
    const rest = fresh.filter(tooEarly).map((column) => ({ id: newId(), kind: "add_column", table: tableId, column }));
    ops.push(...rest);
    return [staged, ...rest];
  }
  const added = columns.map((column) => ({ id: newId(), kind: "add_column", table: tableId, column }));
  ops.push(...added);
  return added;
}

/**
 * A change to a table that only exists in the draft is made to its create_table op, so the migration
 * stays one clean CREATE TABLE instead of a CREATE followed by ALTERs. Returns a sentence, or null when
 * the table is live (or the change is not one that folds) and the op should be staged as it is.
 */
function foldIntoStaged(ops, baseline, op) {
  if (!op.table || Object.hasOwn(baseline.tables, op.table)) return null;
  const create = ops.find((o) => o.kind === "create_table" && `${o.schema}.${o.name}` === op.table);
  if (!create) return null;
  const later = ops.slice(ops.indexOf(create) + 1);
  const column = create.columns.find((c) => c.name === op.column);
  const touched = (o) => o.table === op.table || o.refTable === op.table;
  switch (op.kind) {
    case "set_not_null": if (!column) return null; column.nullable = false; return `${create.name}.${column.name} is now required in the draft.`;
    case "drop_not_null": if (!column) return null; column.nullable = true; return `${create.name}.${column.name} is now optional in the draft.`;
    case "add_unique": { const c = op.columns.length === 1 && create.columns.find((x) => x.name === op.columns[0]); if (!c) return null; c.unique = true; return `${create.name}.${c.name} is now unique in the draft.`; }
    case "alter_column_type": if (!column || column.ref) return null; Object.assign(column, { type: op.type, check: undefined, default: undefined, archetype: undefined }); return `${create.name}.${column.name} is now ${typeLabel(op.type)} in the draft.`;
    case "drop_column":
      if (!column || later.some((o) => touched(o) && (o.column === op.column || o.columns?.includes(op.column)))) return null;
      create.columns.splice(create.columns.indexOf(column), 1);
      return `Removed ${column.name} from ${create.name} in the draft.`;
    case "rename_column":
      if (!column) return null;
      for (const o of later) if (touched(o)) { if (o.column === op.column) o.column = op.name; if (o.columns) o.columns = o.columns.map((n) => (n === op.column ? op.name : n)); }
      if (create.pk) create.pk = create.pk.map((n) => (n === op.column ? op.name : n));
      column.name = op.name;
      return `Renamed ${create.name}.${op.column} to ${op.name} in the draft.`;
    case "rename_table": {
      const next = `${create.schema}.${op.name}`;
      for (const o of ops) {
        if (o.table === op.table) o.table = next;
        if (o.refTable === op.table) o.refTable = next;
        if (o.tables) o.tables = o.tables.map((t) => (t === op.table ? next : t));
        if (o.column?.ref?.table === op.table) o.column.ref.table = next;
        for (const c of o.columns ?? []) if (c.ref?.table === op.table) c.ref.table = next;
      }
      const was = create.name;
      create.name = op.name;
      return `Renamed ${was} to ${op.name} in the draft.`;
    }
    case "drop_table": {
      if (ops.some((o) => o !== create && (touched(o) || o.column?.ref?.table === op.table || o.columns?.some?.((c) => c.ref?.table === op.table)))) return null;
      ops.splice(ops.indexOf(create), 1);
      return `Removed ${create.name} from the draft. It was never created, so nothing is lost.`;
    }
    default: return null;
  }
}

const fkColumn = (design, id) => `${singularize(design.tables[id]?.name ?? id.split(".").pop())}_id`;

function relationOps(design, a, b, kind, onDelete) {
  if (kind === "many_to_many") {
    const [x, y] = [a, b].sort();
    const tx = design.tables[x], ty = design.tables[y];
    return [{
      id: newId(), kind: "create_table", schema: tx.schema, name: `${singularize(tx.name)}_${ty.name}`,
      columns: [{ name: fkColumn(design, x), ref: { table: x, onDelete: "cascade" }, nullable: false }, { name: fkColumn(design, y), ref: { table: y, onDelete: "cascade" }, nullable: false }],
      pk: [fkColumn(design, x), fkColumn(design, y)], conventions: { id: false, timestamps: false, fkIndex: true },
    }];
  }
  const [child, parent] = kind === "a_has_b_id" ? [a, b] : [b, a];
  return [{ child, column: { name: fkColumn(design, parent), ref: { table: parent, onDelete }, nullable: onDelete === "set_null" } }];
}

const REL = (a, b) => ({
  a_has_b_id: `Each ${a} record belongs to, or points at, one ${b} record. ${a} holds the reference. Example wording: '${a} belong to ${b}', 'each ${a} has one ${b}', '${b} have many ${a}'.`,
  b_has_a_id: `Each ${b} record belongs to, or points at, one ${a} record. ${b} holds the reference. Example wording: '${b} belong to ${a}', 'each ${b} has one ${a}', '${a} have many ${b}'.`,
  many_to_many: `Many-to-many: one ${a} can have many ${b} and one ${b} can have many ${a}.`,
  [NONE]: "The request states no direct relationship between these two.",
});
const ON_DELETE_OPTIONS = {
  restrict: "Nothing is said about deleting, or the parent must not be deleted while children exist.",
  cascade: "The request says the children are deleted together with their parent.",
  set_null: "The request says children stay but lose their link when the parent is deleted.",
};

// ---------------------------------------------------------------------------
// interpret
// ---------------------------------------------------------------------------
/**
 * @param request   what the user typed
 * @param baseline  the live design
 * @param draft     the design with the current ops applied
 * @param current   the current (clean) ops
 * → { ok, reply, ops (the new full list), added (op ids), suggestions, judgments, pendingDatabase?, focus?, usage, model }
 */
export async function interpret(request, baseline, draft, current) {
  const reading = new Reading();
  const ops = structuredClone(current);
  const tables = labelTables(draft);
  const byLabel = new Map(tables.map((t) => [t.label, t]));
  const spans = identCandidates(request).map((s, order) => ({ ...s, order }));
  const state = { request, tables: Object.fromEntries(tables.map((t) => [t.label, describeTable(t.table)])) };
  const done = (extra) => ({ ok: true, ops, added: [], suggestions: [], judgments: reading.judgments, usage: reading.usage, model: reading.model, ...extra });
  const decline = (text, extra) => done({ ok: false, reply: { text }, ops: current, ...extra });

  const [aboutTables, aboutWording] = await Promise.all([reading.ask(state, tableQuestions(tables)), reading.ask({ request }, wordingQuestions(spans))]);
  const first = { ...aboutTables, ...aboutWording };
  const op = reading.choice("op", "Kind of change", first.op, { labels: Object.fromEntries(Object.keys(OPS).map((k) => [k, k.replace(/_/g, " ")])) });
  if (!op.ok) {
    const [a, b] = ranked(first.op);
    return decline("I wasn't sure what kind of change that is. Try saying it more directly, for example:", {
      clarify: [a, b].filter(Boolean).map((o) => OPS[o.value].match(/'([^']+)'/)?.[1]).filter(Boolean),
    });
  }
  if (op.value === "other") return decline(DECLINES.other);
  if (op.value === "data_question") return decline(DECLINES.data_question, { askInstead: request });
  if (op.value === "advise") return done({ reply: { text: "I reviewed the draft as it stands. The findings are in the Advisor tab, most with a one-click fix." }, focus: "advisor" });

  const roles = spans.map((s, i) => ({ ...s, role: top(first[`span:${i}`]) })).filter((s) => s.role.p >= STATED);
  const of = (role) => dropOverlaps(roles.filter((s) => s.role.value === role));
  const tableSpans = of("table_name"), fieldSpans = of("field_name").slice(0, MAX_FIELDS), valueSpans = of("example_value");
  for (const s of [...tableSpans, ...fieldSpans, ...valueSpans, ...of("role_name"), ...of("database_name")]) {
    reading.judgments.push({ key: `span:${s.order}`, title: `"${s.text}" is`, value: s.role.value.replace(/_/g, " "), p: s.role.p, applied: true, alternatives: [] });
  }
  const target = reading.choice("target", "Table", first.target, { labels: { [NEW]: "a new table", [NONE]: "no single table" }, applied: !["design_domain", "new_database", "create_table"].includes(op.value) });
  const targetTable = target.ok && byLabel.get(target.value);
  const mentioned = tables.filter((t) => (first[`uses:${t.label}`]?.noul ?? 0) >= STATED);
  const existingByIdent = (ident) => tables.find((t) => [ident, tableIdent(ident), singularize(ident)].includes(t.table.name));

  // -- a new database ------------------------------------------------------
  if (op.value === "new_database") {
    const name = (of("database_name")[0] ?? tableSpans[0])?.ident;
    if (!name) return decline(DECLINES.no_names);
    return done({ reply: { text: `I can create the database "${name}" on this server and switch to it. That happens straight away, not as part of the draft.` }, pendingDatabase: { name } });
  }

  // -- a whole domain ------------------------------------------------------
  if (op.value === "design_domain") {
    const bp = reading.choice("bp", "Design", first.bp, { labels: { ...Object.fromEntries(BLUEPRINTS.map((b) => [b.id, b.title])), [NONE]: "none I have" } });
    const blueprint = bp.ok && bp.value !== NONE ? blueprintById(bp.value) : null;
    const fits = blueprint && reading.noul(`bpfit:${blueprint.id}`, "Fits the request", first[`bpfit:${blueprint.id}`]).ok;
    const schema = defaultSchema(draft);
    if (!blueprint || !fits) {
      const generic = tableSpans.filter((s) => !existingByIdent(s.ident)).map((s) => tableIdent(s.ident)).filter((n) => !Object.hasOwn(draft.tables, `${schema}.${n}`));
      const made = generic.map((name) => ({ id: newId(), kind: "create_table", schema, name: safeName(name), columns: [columnFromArchetype("name", "title")], conventions: { id: true, timestamps: true, fkIndex: true } }));
      ops.push(...made);
      return done({ ok: made.length > 0, reply: { text: noBlueprintReply(BLUEPRINTS.map((b) => b.title), generic) }, added: made.map((o) => o.id) });
    }
    const all = entitiesOf(blueprint, new Set(blueprint.optional.map((o) => o.id)));
    const known = (s) => all.find((e) => [e.table, ...(e.aliases ?? [])].some((n) => n === tableIdent(s.ident) || n === s.ident));
    // A word that names the domain itself ("blog", "store", "clinic") is not one of its tables.
    const domainWords = new Set(`${blueprint.id} ${blueprint.title} database system app platform site`.toLowerCase().split(/[^a-z]+/).flatMap((w) => [w, singularize(w), tableIdent(w)]));
    const unknown = tableSpans.filter((s) => !known(s) && !s.ident.split("_").every((w) => domainWords.has(w)));
    const q = {};
    for (const o of blueprint.optional) q[`opt:${o.id}`] = noul(`Does \`request\` ask for this, or clearly need it: ${o.describe}?`);
    unknown.forEach((s, i) => {
      q[`ent:${i}`] = choice(`\`request\` asks for a ${blueprint.title.toLowerCase()} database and mentions "${s.text}". In that design, which of these is "${s.text}" the user's word for?`, {
        ...Object.fromEntries(blueprint.entities.map((e) => [e.id, `${e.table}: ${e.describe}`])),
        __extra__: "Something else the database should also store, which none of these covers.", [NONE]: "Not a thing to store: it describes the business itself.",
      });
    });
    const second = Object.keys(q).length ? await reading.ask({ request }, q) : {};
    const optional = new Set(blueprint.optional.filter((o) => reading.noul(`opt:${o.id}`, `Include ${o.id}`, second[`opt:${o.id}`], { bar: OPTIONAL }).ok).map((o) => o.id));
    const renames = {}, extras = [];
    for (const s of tableSpans) {
      const e = known(s);
      if (e && e.table !== tableIdent(s.ident)) { renames[e.id] = safeName(tableIdent(s.ident)); reading.rule(`alias:${s.order}`, `"${s.text}" names`, e.table); }
      for (const o of blueprint.optional) if (e && o.entities.some((x) => x.id === e.id)) optional.add(o.id);
    }
    unknown.forEach((s, i) => {
      // Mapping the user's word onto an entity is an inference, so it needs the higher bar.
      const pick = reading.choice(`ent:${i}`, `"${s.text}" names`, second[`ent:${i}`], { labels: { __extra__: "an extra table", [NONE]: "nothing to store" }, bar: INFERRED });
      if (!pick.ok) return;
      if (pick.value === "__extra__") extras.push(safeName(tableIdent(s.ident)));
      else if (pick.value !== NONE && !renames[pick.value]) renames[pick.value] = safeName(tableIdent(s.ident));
    });
    const { ops: made, skipped } = instantiate(blueprint, { optional, renames, schema, existing: new Set(Object.keys(draft.tables)) });
    for (const name of extras) if (!Object.hasOwn(draft.tables, `${schema}.${name}`)) made.push({ id: newId(), kind: "create_table", schema, name, columns: [columnFromArchetype("name", "title")], conventions: { id: true, timestamps: true, fkIndex: true } });
    const taken = new Set(Object.keys(draft.enums));
    const fresh = made.filter((o) => o.kind !== "create_enum" || !taken.has(`${o.schema}.${o.name}`));
    if (!fresh.some((o) => o.kind === "create_table")) {
      return decline(`Everything in my ${blueprint.title.toLowerCase()} design is already here (${skipped.join(", ")}). Ask for a specific addition instead.`,
        { suggestions: blueprint.optional.filter((o) => !optional.has(o.id)).map((o) => ({ label: `Add ${o.entities.map((e) => e.table).join(" and ")}`, say: `also add ${o.entities.map((e) => e.table).join(" and ")} to the ${blueprint.title.toLowerCase()} design` })) });
    }
    ops.push(...fresh);
    const notes = [];
    if (skipped.length) notes.push(`${skipped.join(", ")} already exist${skipped.length === 1 ? "s" : ""}, so I left ${skipped.length === 1 ? "it" : "them"} as ${skipped.length === 1 ? "it is" : "they are"} and linked to ${skipped.length === 1 ? "it" : "them"}.`);
    if (extras.length) notes.push(`${extras.join(", ")} ${extras.length === 1 ? "is" : "are"} not part of my ${blueprint.title.toLowerCase()} design, so ${extras.length === 1 ? "it starts" : "they start"} with just a name. Tell me the fields.`);
    const left = blueprint.optional.filter((o) => !optional.has(o.id));
    return done({
      reply: { text: stagedReply(fresh, { blueprint }), notes }, added: fresh.map((o) => o.id),
      suggestions: left.map((o) => ({ label: `Also add ${o.entities.map((e) => e.table).join(" and ")}`, say: `also add ${o.entities.map((e) => e.table).join(" and ")} to the ${blueprint.title.toLowerCase()} design` })),
    });
  }

  // -- new tables ----------------------------------------------------------
  if (op.value === "create_table") {
    const fresh = tableSpans.filter((s) => !existingByIdent(s.ident)).slice(0, 4);
    if (!fresh.length) return decline(tableSpans.length ? `${tableSpans.map((s) => existingByIdent(s.ident).label).join(", ")} already exist${tableSpans.length === 1 ? "s" : ""}. To add fields, say "add … to ${existingByIdent(tableSpans[0].ident).label}".` : DECLINES.no_names);
    const names = [...new Set(fresh.map((s) => safeName(tableIdent(s.ident))))].filter((n) => !Object.hasOwn(draft.tables, `${defaultSchema(draft)}.${n}`));
    if (!names.length) return decline(`${fresh.map((s) => tableIdent(s.ident)).join(", ")} already exist${fresh.length === 1 ? "s" : ""} in the draft.`);
    const parents = [...new Set([...tableSpans.filter((s) => existingByIdent(s.ident)).map((s) => existingByIdent(s.ident).label), ...mentioned.map((t) => t.label)])].slice(0, 3);
    const q = {};
    fieldQuestions(q, fieldSpans);
    valueQuestions(q, valueSpans, fieldSpans);
    if (names.length > 1) fieldSpans.forEach((f, i) => { q[`owner:${i}`] = choice(`\`request\` describes several new tables. Which one does the field "${f.text}" belong to?`, Object.fromEntries(names.map((n) => [n, `The table ${n}`]))); });
    const parties = [...names, ...parents];
    const pairs = [];
    for (let a = 0; a < parties.length; a++) for (let b = a + 1; b < parties.length; b++) if (a < names.length && pairs.length < 15) pairs.push([parties[a], parties[b]]);
    pairs.forEach(([a, b], i) => {
      q[`rel:${i}`] = choice(`According to \`request\`, how are "${a}" and "${b}" related?`, REL(a, b));
      q[`ondel:${i}`] = choice(`What does \`request\` say should happen to linked records when a "${a}" or "${b}" record is deleted?`, ON_DELETE_OPTIONS);
    });
    const second = Object.keys(q).length ? await reading.ask({ request }, q) : {};

    const schema = defaultSchema(draft);
    const owners = fieldSpans.map((f, i) => (names.length === 1 ? names[0] : (() => { const o = reading.choice(`owner:${i}`, `${f.ident} belongs to`, second[`owner:${i}`]); return o.ok ? o.value : names[0]; })()));
    const made = [], allEnums = [], weak = [];
    for (const name of names) {
      const mine = fieldSpans.map((f, i) => ({ f, i })).filter(({ i }) => owners[i] === name);
      const sub = Object.fromEntries(Object.entries(second).map(([k, v]) => [k, v]));
      const remap = (prefix) => mine.forEach(({ i }, n) => { sub[`${prefix}:${n}`] = second[`${prefix}:${i}`]; });
      ["arch", "req", "uniq"].forEach(remap);
      const myValues = valueSpans.map((v, vi) => ({ v, pick: top(second[`val:${vi}`]) })).filter(({ pick }) => pick.value?.startsWith("f") && mine.some(({ i }) => i === Number(pick.value.slice(1))));
      myValues.forEach(({ pick }, n) => { sub[`val:${n}`] = { probabilities: { [`f${mine.findIndex(({ i }) => i === Number(pick.value.slice(1)))}`]: pick.p } }; });
      const built = buildFields(reading, sub, mine.map(({ f }) => f), myValues.map(({ v }) => v), name, schema);
      allEnums.push(...built.enums);
      weak.push(...built.weak.map((c) => `${name}.${c}`));
      made.push({ id: newId(), kind: "create_table", schema, name, columns: built.columns.length ? built.columns : [columnFromArchetype("name", "title")], conventions: { id: true, timestamps: true, fkIndex: true } });
    }
    const idOfParty = (party) => (names.includes(party) ? `${schema}.${party}` : byLabel.get(party).id);
    const suggestions = [], later = [];
    // Relations are worked out against a design that already contains the new tables.
    const preview = structuredClone(draft);
    for (const o of made) preview.tables[`${schema}.${o.name}`] = { schema, name: o.name, columns: [], fks: [] };
    pairs.forEach(([a, b], i) => {
      const rel = reading.choice(`rel:${i}`, `${a} ↔ ${b}`, second[`rel:${i}`], { labels: { a_has_b_id: `${a} → ${b}`, b_has_a_id: `${b} → ${a}`, many_to_many: "many to many", [NONE]: "not related" }, bar: STATED });
      if (rel.value === NONE || !rel.value) return;
      const del = top(second[`ondel:${i}`]);
      const onDelete = del.value !== "restrict" && del.p >= INFERRED ? del.value : "restrict";
      const built = relationOps(preview, idOfParty(a), idOfParty(b), rel.value, onDelete);
      const sure = rel.p >= (rel.value === "many_to_many" ? INFERRED : STATED);
      for (const r of built) {
        if (!sure) { suggestions.push({ label: r.kind ? describeOp(r) : `Link ${r.child.split(".").pop()} to ${r.column.ref.table.split(".").pop()}`, relation: r }); continue; }
        later.push(r);
      }
    });
    const place = (r, list) => {
      if (r.kind) return list.push(r);
      const host = made.find((o) => `${schema}.${o.name}` === r.child);
      if (host) { if (!host.columns.some((c) => c.name === r.column.name)) host.columns.unshift(r.column); } else list.push({ id: newId(), kind: "add_column", table: r.child, column: r.column });
    };
    const tail = [];
    later.forEach((r) => place(r, tail));
    // A table must exist before another can reference it.
    made.sort((x, y) => Number(x.columns.some((c) => c.ref?.table === `${schema}.${y.name}`)) - Number(y.columns.some((c) => c.ref?.table === `${schema}.${x.name}`)));
    const added = [...allEnums, ...made, ...tail];
    ops.push(...added);
    const notes = [];
    if (!fieldSpans.length) notes.push("You didn't name any fields, so I started with a name column. Tell me what else it should store.");
    if (weak.length) notes.push(`I wasn't sure what kind of value ${weak.join(", ")} hold${weak.length === 1 ? "s" : ""}, so ${weak.length === 1 ? "it is" : "they are"} plain text for now. Change the type in the Changes tab if that's wrong.`);
    return done({
      reply: { text: stagedReply(added), notes }, added: added.map((o) => o.id),
      suggestions: suggestions.map((s) => ({ label: s.label, ops: s.relation.kind ? [s.relation] : [{ id: newId(), kind: "add_column", table: s.relation.child, column: s.relation.column }] })),
    });
  }

  // -- everything below works on tables that exist (live or staged) --------
  if (op.value === "relate_tables") {
    const parties = [...new Set([...tableSpans.map((s) => existingByIdent(s.ident)?.label).filter(Boolean), ...mentioned.map((t) => t.label)])].slice(0, 4);
    if (parties.length < 2) return decline("To link tables I need two that exist. Name both, for example: \"orders belong to customers\".");
    const pairs = [];
    for (let a = 0; a < parties.length; a++) for (let b = a + 1; b < parties.length; b++) pairs.push([parties[a], parties[b]]);
    const q = {};
    pairs.forEach(([a, b], i) => {
      q[`rel:${i}`] = choice(`According to \`request\`, how are "${a}" and "${b}" related?`, REL(a, b));
      q[`ondel:${i}`] = choice(`What does \`request\` say should happen to linked records when a "${a}" or "${b}" record is deleted?`, ON_DELETE_OPTIONS);
    });
    const second = await reading.ask({ request }, q);
    const added = [], suggestions = [];
    pairs.forEach(([a, b], i) => {
      const rel = reading.choice(`rel:${i}`, `${a} ↔ ${b}`, second[`rel:${i}`], { labels: { a_has_b_id: `${a} → ${b}`, b_has_a_id: `${b} → ${a}`, many_to_many: "many to many", [NONE]: "not related" } });
      if (!rel.value || rel.value === NONE) return;
      const del = top(second[`ondel:${i}`]);
      const onDelete = del.value !== "restrict" && del.p >= INFERRED ? del.value : "restrict";
      for (const r of relationOps(draft, byLabel.get(a).id, byLabel.get(b).id, rel.value, onDelete)) {
        const sure = rel.p >= (rel.value === "many_to_many" ? INFERRED : STATED);
        if (r.kind) { if (sure) { ops.push(r); added.push(r); } else suggestions.push({ label: describeOp(r), ops: [r] }); continue; }
        if (draft.tables[r.child].columns.some((c) => c.name === r.column.name)) {
          const fk = { id: newId(), kind: "add_fk", table: r.child, columns: [r.column.name], refTable: r.column.ref.table, onDelete };
          if (sure) { ops.push(fk); added.push(fk); } else suggestions.push({ label: describeOp(fk), ops: [fk] });
        } else if (sure) added.push(...addColumns(ops, baseline, r.child, [r.column]));
        else suggestions.push({ label: `Link ${r.child.split(".").pop()} to ${r.column.ref.table.split(".").pop()}`, ops: [{ id: newId(), kind: "add_column", table: r.child, column: r.column }] });
      }
    });
    if (!added.length) return decline(suggestions.length ? DECLINES.nothing : "I couldn't tell how those tables are related. Say which one belongs to which.", { suggestions });
    const links = added.filter((o) => o.kind === "create_table" && Object.hasOwn(draft.tables, `${o.schema}.${o.name}`));
    const text = links.length === added.length
      ? `${links.map((o) => `${o.name} now ${o.columns.filter((c) => c.ref).length > 1 ? "has its references" : `points at ${o.columns.findLast((c) => c.ref).ref.table.split(".").pop()} through ${o.columns.findLast((c) => c.ref).name}`}`).join("; ")} in the draft.`
      : stagedReply(added);
    return done({ reply: { text }, added: added.map((o) => o.id), suggestions });
  }

  if (op.value === "seed_data") {
    if (!tables.length) return decline("There are no tables to fill yet. Create some first.");
    const numbers = numberCandidates(request);
    const q = { seed_all: noul("Does `request` ask to fill every table, or the whole database, rather than particular tables?") };
    numbers.forEach((n, i) => { q[`rows:${i}`] = noul(`In \`request\`, is "${n.phrase}" the number of rows to create?`); });
    for (const t of tables.slice(0, 60)) q[`seed:${t.label}`] = noul(`Does \`request\` ask to put sample rows into the table "${t.label}" specifically?`);
    const second = await reading.ask(state, q);
    const n = numbers.map((c, i) => ({ c, p: second[`rows:${i}`]?.noul ?? 0 })).sort((a, b) => b.p - a.p)[0];
    const rows = n && n.p >= STATED ? Math.min(1000, Math.max(1, Math.round(n.c.value))) : 25;
    if (n) reading.noul("rows", "Rows per table", { noul: n.p }, { value: String(n.c.value) });
    const named = tables.filter((t) => reading.noul(`seed:${t.label}`, `Fill ${t.label}`, second[`seed:${t.label}`]).ok);
    const everything = !named.length || reading.noul("seed_all", "Fill every table", second.seed_all).ok;
    const seedOp = { id: newId(), kind: "seed", tables: everything ? [] : named.map((t) => t.id), rows, seedValue: (Date.now() % 100_000) + 1 };
    ops.push(seedOp);
    return done({ reply: { text: stagedReply([seedOp]), notes: ["Tables are filled parents first, so every reference points at a real row. The data is plausible, not real."] }, added: [seedOp.id] });
  }

  if (op.value === "access") return (await import("./access.js")).interpretAccess({ reading, request, state, draft, tables, schema: defaultSchema(draft), spans: { roles: of("role_name"), tables: tableSpans }, targetTable, mentioned, ops, done, decline });

  // The remaining kinds all change one existing table.
  if (!targetTable) return decline(DECLINES.no_target);
  const t = targetTable;
  const noColumn = `I couldn't match that to a column of ${t.label}. It has: ${t.table.columns.slice(0, 30).map((c) => c.name).join(", ")}.`;
  const columnOptions = Object.fromEntries(t.table.columns.slice(0, 120).map((c) => [c.name, `${typeLabel(c.type)}${c.nullable ? "" : ", required"}`]));

  if (op.value === "add_columns") {
    const fields = fieldSpans.filter((f) => !t.table.columns.some((c) => c.name === f.ident));
    if (!fields.length) return decline(fieldSpans.length ? `${t.label} already has ${fieldSpans.map((f) => f.ident).join(", ")}.` : DECLINES.no_names);
    const q = {};
    fieldQuestions(q, fields);
    valueQuestions(q, valueSpans, fields);
    const second = await reading.ask({ request }, q);
    const built = buildFields(reading, second, fields, valueSpans, t.table.name, t.table.schema);
    const staged = !Object.hasOwn(baseline.tables, t.id);
    // A required column cannot be added to a table that already holds rows unless it has a default.
    const relaxed = [];
    if (!staged) for (const c of built.columns) if (c.nullable === false && !c.default && baseline.tables[t.id]?.estRows !== 0) { c.nullable = true; relaxed.push(c.name); }
    ops.push(...built.enums);
    const added = [...built.enums, ...addColumns(ops, baseline, t.id, built.columns)];
    const notes = [];
    if (relaxed.length) notes.push(`${relaxed.join(", ")} would normally be required, but ${t.label} may already hold rows that have no value for ${relaxed.length === 1 ? "it" : "them"}. I left ${relaxed.length === 1 ? "it" : "them"} optional: fill the existing rows, then ask me to make ${relaxed.length === 1 ? "it" : "them"} required.`);
    if (built.weak.length) notes.push(`I wasn't sure what kind of value ${built.weak.join(", ")} hold${built.weak.length === 1 ? "s" : ""}, so ${built.weak.length === 1 ? "it is" : "they are"} plain text for now.`);
    return done({ reply: { text: staged ? `Added ${built.columns.map((c) => c.name).join(", ")} to the ${t.label} table in the draft.` : stagedReply(added), notes }, added: added.map((o) => o.id) });
  }

  const q = { col: choice(`Which column of the table "${t.label}" does \`request\` refer to?`, { ...columnOptions, [NONE]: "None of these columns, or the request is about the whole table." }) };
  if (op.value === "change_column") {
    q.change = choice("What change does `request` ask for?", {
      make_required: "The column must always have a value (required, mandatory, not null).",
      make_optional: "The column may be left empty (optional, nullable).",
      make_unique: "No two rows may share a value in this column.",
      change_type: "The column should hold a different type of data.",
      remove_default: "The column should no longer have a default value.",
    });
    q.newtype = choice("If `request` asks to change what type of data a column holds, which type does it ask for?", { ...Object.fromEntries(Object.entries(SIMPLE_TYPES).map(([k, [, d]]) => [k, d])), [NONE]: "It does not ask for a type." });
  }
  if (op.value === "rename_thing" || op.value === "remove_thing") {
    q.what = choice(`Does \`request\` want to ${op.value === "rename_thing" ? "rename" : "delete"} the whole table "${t.label}", or one of its columns?`, { table: "The whole table.", column: "One column of the table." });
  }
  const fresh = spans.filter((s) => s.ident !== t.table.name && !t.table.columns.some((c) => c.name === s.ident) && !existingByIdent(s.ident));
  if (op.value === "rename_thing") {
    q.newname = choice("Which phrase in `request` is the new name to use?", { ...Object.fromEntries(fresh.map((s) => [`s${s.order}`, `"${s.text}"`])), [NONE]: "None of these." });
  }
  if (op.value === "add_index") {
    for (const c of t.table.columns.slice(0, 60)) q[`icol:${c.name}`] = noul(`Does \`request\` ask for an index on the column "${c.name}" of "${t.label}"?`);
    q.iuniq = noul("Does `request` ask for the index to be unique, or for values to be unique?");
  }
  const second = await reading.ask({ request }, q);
  const destructive = op.value === "remove_thing";
  const bar = destructive ? INFERRED : STATED;
  const stage = (made, sure = true) => {
    if (made.length === 1) {
      const folded = foldIntoStaged(ops, baseline, made[0]);
      if (folded) return done({ reply: { text: folded }, added: [] });
    }
    if (!sure) return decline(DECLINES.nothing, { suggestions: made.map((o) => ({ label: describeOp(o), ops: [o] })) });
    ops.push(...made);
    return done({ reply: { text: stagedReply(made), notes: destructive ? ["This deletes data. Applying it will ask you to type the database name."] : [] }, added: made.map((o) => o.id) });
  };

  if (op.value === "add_index") {
    const columns = t.table.columns.filter((c) => reading.noul(`icol:${c.name}`, `Index ${c.name}`, second[`icol:${c.name}`]).ok).map((c) => c.name).slice(0, 4);
    if (!columns.length) return decline(noColumn);
    return stage([{ id: newId(), kind: "add_index", table: t.id, columns, unique: reading.noul("iuniq", "Unique", second.iuniq, { bar: INFERRED }).ok }]);
  }

  const what = q.what ? reading.choice("what", "Applies to", second.what, { bar }) : { value: "column", ok: true, p: 1 };
  const col = reading.choice("col", "Column", second.col, { labels: { [NONE]: "no column" }, applied: what.value !== "table", bar });
  const sure = op.p >= bar && target.p >= bar;

  if (op.value === "remove_thing") {
    if (what.value === "table") return stage([{ id: newId(), kind: "drop_table", table: t.id }], sure && what.ok);
    if (!col.value || col.value === NONE) return decline(noColumn);
    return stage([{ id: newId(), kind: "drop_column", table: t.id, column: col.value }], sure && what.ok && col.ok);
  }
  if (op.value === "rename_thing") {
    const pick = reading.choice("newname", "New name", second.newname, { labels: { ...Object.fromEntries(fresh.map((s) => [`s${s.order}`, s.ident])), [NONE]: "not found" } });
    const span = pick.ok && fresh.find((s) => `s${s.order}` === pick.value);
    if (!span) return decline("I couldn't find the new name in your message. Say it like: \"rename clients to customers\".");
    if (what.value === "table") return stage([{ id: newId(), kind: "rename_table", table: t.id, name: safeName(tableIdent(span.ident)) }], what.ok);
    if (!col.ok || col.value === NONE) return decline(noColumn);
    return stage([{ id: newId(), kind: "rename_column", table: t.id, column: col.value, name: safeName(span.ident) }]);
  }
  // change_column
  if (!col.ok || col.value === NONE) return decline(noColumn);
  const change = reading.choice("change", "Change", second.change, { labels: { make_required: "required", make_optional: "optional", make_unique: "unique", change_type: "new type", remove_default: "no default" } });
  if (!change.ok) return decline("I found the column but not what to change about it. Say, for example: \"make it required\", \"make it optional\", \"must be unique\" or \"change it to a date\".");
  const base = { id: newId(), table: t.id, column: col.value };
  if (change.value === "make_required") return stage([{ ...base, kind: "set_not_null" }]);
  if (change.value === "make_optional") return stage([{ ...base, kind: "drop_not_null" }]);
  if (change.value === "remove_default") return stage([{ ...base, kind: "drop_default" }]);
  if (change.value === "make_unique") return stage([{ id: base.id, kind: "add_unique", table: t.id, columns: [col.value] }]);
  const newtype = reading.choice("newtype", "New type", second.newtype, { labels: { [NONE]: "not stated" } });
  if (!newtype.ok || newtype.value === NONE) return decline("I couldn't tell which type you want. Say, for example: \"change it to a whole number\", \"to a date\" or \"to money\".");
  return stage([{ ...base, kind: "alter_column_type", type: SIMPLE_TYPES[newtype.value][0] }]);
}
