import { ask, choice, noul } from "../jev.js";
import { identCandidates, numberCandidates, tableIdent, singularize, valueLists, mentionsNegation } from "../nl/candidates.js";
import { ARCHETYPES, archetypeByName, columnFromArchetype } from "./archetypes.js";
import { BLUEPRINTS, blueprintById, entitiesOf, instantiate } from "./blueprints/index.js";
import { newId } from "./ops.js";
import { safeName } from "./validate.js";
import { typeLabel, defaultLabel, GENERATED } from "./types.js";
import { stagedReply, noBlueprintReply, describeOp, DECLINES } from "./wording.js";

// Natural language → ops, with Jev. Jev returns judgments, never text, so the shape is always:
// code finds the candidates (phrases in the request, tables, columns, archetypes, blueprints),
// Jev selects among them, and code builds the ops. Two requests per message: the first routes the
// request and classifies its phrases, the second asks everything the chosen kind of change needs.

const NONE = "__none__";
const NEW = "__new__";
const STATED = 0.6;    // something the request says
const INFERRED = 0.85; // something the request only implies, or anything destructive
const COMBINATION = 0.5; // a column in a unique combination: measured 0.71–0.92 for members, ≤ 0.41 for the rest, over six requests on two databases
const OPTIONAL = 0.75; // an optional part of a blueprint: measured at ≥ 0.89 when asked for, ≤ 0.59 when not
const MAX_TABLES = 150;
const MAX_FIELDS = 16;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ranked = (answer) => Object.entries(answer?.probabilities ?? {}).map(([value, p]) => ({ value, p })).sort((a, b) => b.p - a.p);
const top = (answer) => ranked(answer)[0] ?? { value: null, p: 0 };

const OPS = {
  design_domain: "Design a whole database or system for some business or purpose, with several tables at once. Examples: 'build me a database for a vet clinic', 'I need an online store', 'schema for a blog'.",
  new_database: "Create a new, empty database on the server. Examples: 'create a database called shop', 'new db named testing'.",
  create_table: "Create one or more specific new tables, usually naming their fields. Examples: 'create a table called invoices with number and amount', 'add a suppliers table', 'create a roles table with name and description', 'a permissions table'.",
  add_columns: "Add one or more new columns or fields to a table that already exists. Examples: 'add a phone number to customers', 'patients also need date of birth and allergies'.",
  change_column: "Change how an existing column behaves: the type of data it holds, whether it is required or optional, whether its values must be unique, or what value it gets by default. Examples: 'failed login count should default to 0', 'status defaults to active', 'expires at should default to 30 days from now', 'make email required', 'phone should be optional', 'change price to a decimal', 'change quantity to a big whole number', 'turn notes into json', 'emails must be unique', 'billing email does not need to be unique'.",
  rename_thing: "Give an existing table or column a different name. Examples: 'rename clients to customers', 'call the fullname column name instead'.",
  remove_thing: "Delete an existing table or column itself (not just the rows in it). Examples: 'drop the legacy table', 'remove the fax column from contacts', 'get rid of notes'.",
  relate_tables: "Create a new link between two tables that exist but are not linked yet: one belongs to the other, or they are many-to-many. Examples: 'orders belong to customers', 'each post has one author', 'posts can have many tags'.",
  computed_column: "Add a column whose value is always calculated from other columns of the same row (optionally with a fixed number or a condition), so it never has to be filled in. Examples: 'add a line total to order items that is quantity times unit price', 'full name should be first name plus last name', 'add a duration that is ends at minus starts at', 'add a lowercase version of email called email lower', 'add a gross price that is price times 1.2', 'add an is large flag that is true when quantity is over 100', 'shipping fee is 0 when total is over 50, otherwise 5'.",
  create_view: "Create a view: a saved way of looking at one table, worked out fresh every time it is read. It shows the table's rows with an extra yes/no column from a test, or only the rows that pass a test. The test may compare with now or today. Examples: 'create a view of sessions with an is expired flag that is true when expires at is before now', 'create a view called active subscriptions showing subscriptions where status is active', 'a view of overdue invoices: invoices where due date is before today'.",
  drop_view: "Delete a view. Examples: 'drop the active subscriptions view', 'remove the view sessions live'.",
  unique_together: "Several columns of one table must be unique in combination: a row may repeat each value, but not the same combination. Examples: 'one membership per user per organization', 'provider and provider user id together must be unique', 'plan names must be unique within a product', 'a user can review a product only once'. Also changing or removing such a rule: 'memberships should be unique per organization, user and role instead', 'plan names no longer need to be unique within a product'.",
  on_delete: "Change what happens to linked rows when the row they belong to is deleted: delete them too, keep them and clear the link, or block the deletion. Examples: 'when a user is deleted keep their audit events', 'deleting a customer should delete their orders too', 'do not allow deleting a plan that has subscriptions'.",
  add_index: "Add an index to make lookups faster. Examples: 'index orders by created_at', 'add an index on email'.",
  change_rows: "Change the data itself, not the structure: delete some rows, empty a table of its rows, change a value in existing rows, or add one row. The table and its columns stay as they are. Examples: 'empty the sessions table', 'delete all the sample data', 'delete sessions where expires at is before now', 'set every trialing subscription to active', 'set seat limit to 10 on plans', 'add a product called Explorer with slug explorer'.",
  seed_data: "Fill tables with sample, fake or test rows. Examples: 'add 50 fake rows', 'fill it with sample data', 'seed the customers table'.",
  access: "Database-level access: Postgres roles and privileges for the people or services that connect to the database, or row-level security. Examples: 'create a read-only role called analyst', 'let the reporting role read orders', 'revoke delete from the app role', 'users should only see their own rows'. Not this: tables that store an application's own users, roles or permissions.",
  advise: "Review or critique the existing design and suggest improvements. Examples: 'review my schema', 'what should I improve', 'any problems with this design'.",
  export_schema: "Get the schema or its migrations out as SQL files, to use somewhere else. Examples: 'export the schema', 'give me the sql for this database', 'download the migrations', 'I need a schema.sql file'.",
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

/**
 * "invoice numbers must be unique" talks about the field `number` again; it is not a second field.
 * A phrase is a restatement when, with the table's own name and a plural ending taken off, it is another field.
 */
function dropRestatements(fields, tableNames) {
  const names = new Set(fields.map((f) => f.ident));
  const prefixes = tableNames.flatMap((t) => [singularize(t), t]);
  return fields.filter((f) => {
    const forms = [f.ident, ...prefixes.filter((p) => f.ident.startsWith(p + "_")).map((p) => f.ident.slice(p.length + 1))];
    return !forms.flatMap((x) => [x, singularize(x)]).some((x) => x !== f.ident && names.has(x));
  });
}

// Words that carry a sentence rather than name something. A leftover made only of these is not worth reporting.
const CONNECTIVE = new Set(`deleted delete deletes removed kept keep cleared link links linked belongs belong each every too also when their its his her
them they must be been is are was unique required optional mandatory together once only again same other another own per within without
true false yes no flag version kind sort thing things stuff etc so that this these those which who whose what where then than there here
say says said mean means meant like such plus well just really very quite please thanks`.split(/\s+/));

/** Whether every occurrence of `text` in the request sits inside a bracketed list. */
function inBrackets(request, text) {
  const outside = request.replace(/\([^()]*\)/g, " ");
  return !new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(outside);
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
function buildFields(reading, answers, fields, values, tableName, schema, lists, refFor = () => null, existingEnums = {}) {
  const columns = [], enums = [], weak = [];
  const valuesOf = fields.map(() => []);
  const listedValues = new Set();
  for (const list of lists ?? []) {
    const at = fields.findIndex((f) => list.fields.includes(f.ident));
    if (at < 0) continue;
    valuesOf[at] = [...list.values];
    list.values.forEach((v) => listedValues.add(v));
  }
  values.forEach((v, i) => {
    if (listedValues.has(v.ident)) return;
    const pick = top(answers[`val:${i}`]);
    if (pick.value?.startsWith("f") && pick.p >= STATED) valuesOf[Number(pick.value.slice(1))].push(v.ident);
  });
  fields.forEach((f, i) => {
    // "customer id" on a table next to a customers table is a reference, not a piece of text.
    const parent = /_id$/.test(f.ident) && refFor(f.ident.slice(0, -3));
    if (parent) {
      const required = reading.noul(`req:${i}`, `${f.ident} required`, answers[`req:${i}`]).ok;
      reading.rule(`ref:${i}`, `${f.ident} points at`, parent.label);
      columns.push({ name: f.ident, ref: { table: parent.id, onDelete: "restrict" }, nullable: !required });
      return;
    }
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
      const same = existingEnums?.[`${schema}.${typeName}`];
      if (!same || same.values.join() !== valuesOf[i].join()) enums.push({ id: newId(), kind: "create_enum", schema, name: typeName, values: valuesOf[i] });
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
  // A column that is itself still only staged ("add a nickname to customers and make it required") is changed where it is staged.
  const adding = op.table && ops.find((o) => o.kind === "add_column" && o.table === op.table && o.column.name === (op.column ?? op.columns?.[0]) && !o.column.ref);
  if (adding) {
    const c = adding.column, where = `${op.table.split(".").pop()}.${c.name}`;
    switch (op.kind) {
      case "set_not_null": c.nullable = false; return `${where} will be added as required.`;
      case "drop_not_null": c.nullable = true; return `${where} will be added as optional.`;
      case "add_unique": if (op.columns.length !== 1) return null; c.unique = true; return `${where} will be added as unique.`;
      case "alter_column_type": Object.assign(c, { type: op.type, check: undefined, default: undefined, archetype: undefined }); return `${where} will be added as ${typeLabel(op.type)}.`;
      case "set_default": c.default = op.default; return `${where} will be added with the default ${defaultLabel(op.default)}.`;
      case "drop_column": ops.splice(ops.indexOf(adding), 1); return `Took ${where} back out of the draft.`;
      default: break;
    }
  }
  if (!op.table || Object.hasOwn(baseline.tables, op.table)) return null;
  const create = ops.find((o) => o.kind === "create_table" && `${o.schema}.${o.name}` === op.table);
  if (!create) return null;
  const later = ops.slice(ops.indexOf(create) + 1);
  const column = create.columns.find((c) => c.name === op.column);
  const touched = (o) => o.table === op.table || o.refTable === op.table;
  switch (op.kind) {
    case "set_not_null": if (!column) return null; column.nullable = false; return `${create.name}.${column.name} is now required in the draft.`;
    case "set_default": if (!column || column.ref) return null; column.default = op.default; return `${create.name}.${column.name} now defaults to ${defaultLabel(op.default)} in the draft.`;
    case "drop_default": if (!column?.default) return null; delete column.default; return `${create.name}.${column.name} no longer has a default in the draft.`;
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
      // Enum types staged for this table go with it, unless something else in the draft uses them.
      const used = new Set(ops.flatMap((o) => [...(o.columns ?? []), o.column].filter(Boolean).map((c) => c.type?.enum)).filter(Boolean));
      for (const id of create.columns.map((c) => c.type?.enum).filter(Boolean)) {
        const at = ops.findIndex((o) => o.kind === "create_enum" && `${o.schema}.${o.name}` === id);
        if (at >= 0 && !used.has(id)) ops.splice(at, 1);
      }
      return `Removed ${create.name} from the draft. It was never created, so nothing is lost.`;
    }
    default: return null;
  }
}

const fkColumn = (design, id) => `${singularize(design.tables[id]?.name ?? id.split(".").pop())}_id`;

function relationOps(design, a, b, kind, onDelete) {
  if (kind === "many_to_many") {
    // Named the way it was said: "users can have many roles" → user_roles.
    const [x, y] = [a, b];
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
/**
 * `focus` is what the previous request in the same message was about: { table, column }. It lets "… and make it required"
 * stand on its own. What this request was about comes back as `subject`, for the next one. (`focus` in a reply is a tab.)
 */
export async function interpret(request, baseline, draft, current, focus = {}) {
  const about = { table: focus.table, column: undefined };
  const reading = new Reading();
  const ops = structuredClone(current);
  const tables = labelTables(draft);
  const byLabel = new Map(tables.map((t) => [t.label, t]));
  const spans = identCandidates(request).map((s, order) => ({ ...s, order }));
  const state = { request, tables: Object.fromEntries(tables.map((t) => [t.label, describeTable(t.table)])) };
  const done = (extra) => ({ ok: true, ops, added: [], suggestions: [], judgments: reading.judgments, usage: reading.usage, model: reading.model, subject: about, ...extra });
  const decline = (text, extra) => done({ ok: false, reply: { text }, ops: current, ...extra });

  const [aboutTables, aboutWording] = await Promise.all([reading.ask(state, tableQuestions(tables)), reading.ask({ request }, wordingQuestions(spans))]);
  const first = { ...aboutTables, ...aboutWording };
  let op = reading.choice("op", "Kind of change", first.op, { labels: Object.fromEntries(Object.keys(OPS).map((k) => [k, k.replace(/_/g, " ")])) });
  // "Unique" with a scope (within a product, per user, together, only once) is a combination, not one column. When Jev
  // splits between exactly those two readings, the wording settles it.
  const [top1, top2] = ranked(first.op);
  if (top2 && new Set([top1.value, top2.value]).size === 2 && [top1.value, top2.value].every((v) => ["unique_together", "change_column"].includes(v))
    && top1.p + top2.p >= INFERRED && /\b(within|per|together|combination|combined|only once|for each|in each|at most one|one .+ per)\b/i.test(request) && /\b(unique|once|one|duplicate|per)\b/i.test(request)) {
    op = { value: "unique_together", p: top1.p + top2.p, ok: true };
    reading.rule("op:scope", "Scope words", "a combination, not one column");
  }
  // "Create a table … it can have many …" splits Jev between creating and linking. Both readings are about tables and
  // relations, so either is accepted here, and a fact decides further down: does every table named exist?
  if (top2 && [top1.value, top2.value].every((v) => ["relate_tables", "create_table"].includes(v)) && top1.value !== top2.value && top1.p + top2.p >= INFERRED) {
    op = { value: "relate_tables", p: top1.p + top2.p, ok: true };
  }
  if (!op.ok) {
    const [a, b] = ranked(first.op);
    return decline("I wasn't sure what kind of change that is. Try saying it more directly, for example:", {
      clarify: [a, b].filter(Boolean).map((o) => OPS[o.value].match(/'([^']+)'/)?.[1]).filter(Boolean),
    });
  }
  if (op.value === "other") return decline(DECLINES.other);
  if (op.value === "data_question") return decline(DECLINES.data_question, { askInstead: request });
  if (op.value === "export_schema") return done({ reply: { text: "The files are in the History tab: schema.sql is the whole schema as it stands now and runs on an empty database; the migrations download has one numbered file per change applied from this page. Sample data is noted in them but not reproduced." }, focus: "history" });
  if (op.value === "advise") return done({ reply: { text: "I reviewed the draft as it stands. The findings are in the Advisor tab, most with a one-click fix." }, focus: "advisor" });

  const existingByIdent = (ident) => tables.find((t) => [ident, tableIdent(ident), singularize(ident)].includes(t.table.name));
  // Values listed in brackets after a name are read by rule; Jev is not asked to guess what "password reset" is.
  const lists = valueLists(request);
  const listed = new Set(lists.flatMap((l) => l.values));
  const roles = spans
    .filter((s) => listed.has(s.ident) || !listed.size || !inBrackets(request, s.text)) // a fragment of a listed value is nothing
    // Whether a phrase names a table that exists is a fact, so it is not asked.
    .map((s) => ({ ...s, role: listed.has(s.ident) ? { value: "example_value", p: 1 } : existingByIdent(s.ident) ? { value: "table_name", p: 1 } : top(first[`span:${s.order}`]) }))
    .filter((s) => s.role.p >= STATED);
  const of = (role) => dropOverlaps(roles.filter((s) => s.role.value === role));
  // What a confident-looking answer can hide: a phrase that was given no role at all and so went nowhere. When a request
  // builds or extends a table, those phrases are named, so a dropped field is visible instead of silent.
  const unusedNote = (tableLabel, alsoUsed = []) => {
    const touches = (a, b) => a.run === b.run && a.start < b.end && b.start < a.end;
    // A phrase confidently judged to be nothing, or a fragment, was understood as unusable, which is exactly what to report.
    const understood = roles.filter((r) => ![NONE, "fragment"].includes(r.role.value));
    const leftover = dropOverlaps(spans.filter((s) => ![...understood, ...alsoUsed].some((r) => touches(r, s)) && !listed.has(s.ident) && !(listed.size && inBrackets(request, s.text))))
      .filter((s) => !existingByIdent(s.ident) && !s.ident.split("_").every((w) => CONNECTIVE.has(w) || w.length < 2)).slice(0, 5);
    if (!leftover.length) return null;
    const quoted = leftover.map((s) => `"${s.text}"`);
    const listing = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
    return `I didn't use ${listing}. If ${leftover.length === 1 ? "that was" : "those were"} meant as ${leftover.length === 1 ? "a field" : "fields"}, say ${leftover.length === 1 ? "it" : "them"} again on ${leftover.length === 1 ? "its" : "their"} own: "add … to ${tableLabel}".`;
  };
  const tableSpans = of("table_name"), valueSpans = of("example_value");
  const fieldSpans = dropRestatements(of("field_name"), tableSpans.map((s) => tableIdent(s.ident))).slice(0, MAX_FIELDS);
  for (const s of [...tableSpans, ...fieldSpans, ...valueSpans, ...of("role_name"), ...of("database_name")]) {
    reading.judgments.push({ key: `span:${s.order}`, title: `"${s.text}" is`, value: s.role.value.replace(/_/g, " "), p: s.role.p, applied: true, alternatives: [] });
  }
  const target = reading.choice("target", "Table", first.target, { labels: { [NEW]: "a new table", [NONE]: "no single table" }, applied: !["design_domain", "new_database", "create_table"].includes(op.value) });
  let targetTable = target.ok && byLabel.get(target.value);
  // "… and make it required": no table is named, so the request continues with the table the previous one was about.
  if (!targetTable && focus.table && !tableSpans.some((s) => existingByIdent(s.ident))) {
    targetTable = tables.find((x) => x.id === focus.table) ?? null;
    if (targetTable) reading.rule("target:carried", "Table", `${targetTable.label} (carried over)`);
  }
  if (targetTable) about.table = targetTable.id;
  const mentioned = tables.filter((t) => (first[`uses:${t.label}`]?.noul ?? 0) >= STATED);

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

  // "create a table called tags with name. notes can have many tags …" talks about a relation, but one end does not
  // exist yet. Whether a named table exists is a fact, so code settles it: this creates a table (and links it).
  if (op.value === "relate_tables" && tableSpans.some((s) => !existingByIdent(s.ident)) && /\b(create|add|new|build|make)\b[^.]*\btables?\b/i.test(request)) {
    op = { ...op, value: "create_table" };
    reading.rule("op:new-table", "Kind of change", "create table (one of the tables named does not exist yet)");
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
    // Asked per table, not as a choice between them: "members have a name … each class has a name" gives both a name.
    if (names.length > 1) fieldSpans.forEach((f, i) => names.forEach((n) => { q[`has:${i}:${n}`] = noul(`\`request\` describes several new tables. According to it, does the table "${n}" have the field "${f.text}"?`); }));
    const parties = [...names, ...parents];
    const pairs = [];
    for (let a = 0; a < parties.length; a++) for (let b = a + 1; b < parties.length; b++) if (a < names.length && pairs.length < 15) pairs.push([parties[a], parties[b]]);
    pairs.forEach(([a, b], i) => {
      q[`rel:${i}`] = choice(`According to \`request\`, how are "${a}" and "${b}" related?`, REL(a, b));
      q[`ondel:${i}`] = choice(`What does \`request\` say should happen to linked records when a "${a}" or "${b}" record is deleted?`, ON_DELETE_OPTIONS);
    });
    const second = Object.keys(q).length ? await reading.ask({ request }, q) : {};

    const schema = defaultSchema(draft);
    const owners = fieldSpans.map((f, i) => {
      if (names.length === 1) return [names[0]];
      const scored = names.map((n) => ({ n, p: second[`has:${i}:${n}`]?.noul ?? 0 })).sort((a, b) => b.p - a.p);
      const yes = scored.filter((x) => x.p >= STATED);
      for (const x of yes) reading.noul(`has:${i}:${x.n}`, `${x.n} has ${f.ident}`, { noul: x.p });
      // Nothing cleared the bar: it still belongs somewhere, so it goes to the likeliest table rather than being dropped.
      return (yes.length ? yes : scored.slice(0, 1)).map((x) => x.n);
    });
    const made = [], allEnums = [], weak = [];
    for (const name of names) {
      const mine = fieldSpans.map((f, i) => ({ f, i })).filter(({ i }) => owners[i].includes(name));
      const sub = Object.fromEntries(Object.entries(second).map(([k, v]) => [k, v]));
      const remap = (prefix) => mine.forEach(({ i }, n) => { sub[`${prefix}:${n}`] = second[`${prefix}:${i}`]; });
      ["arch", "req", "uniq"].forEach(remap);
      const myValues = valueSpans.map((v, vi) => ({ v, pick: top(second[`val:${vi}`]) })).filter(({ pick }) => pick.value?.startsWith("f") && mine.some(({ i }) => i === Number(pick.value.slice(1))));
      myValues.forEach(({ pick }, n) => { sub[`val:${n}`] = { probabilities: { [`f${mine.findIndex(({ i }) => i === Number(pick.value.slice(1)))}`]: pick.p } }; });
      const built = buildFields(reading, sub, mine.map(({ f }) => f), myValues.map(({ v }) => v), name, schema, lists, (stem) => existingByIdent(stem), draft.enums);
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
    about.table = `${schema}.${names.at(-1)}`;
    const unused = unusedNote(names[0]);
    if (unused) notes.push(unused);
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

  if (op.value === "on_delete") {
    // Every link between the tables the request touches is a candidate; code lists them, Jev picks one.
    const involved = new Set([...mentioned.map((m) => m.id), ...tableSpans.map((s) => existingByIdent(s.ident)?.id), targetTable?.id].filter(Boolean));
    const links = tables.flatMap((child) => child.table.fks.map((fk) => ({ child, fk, parent: tables.find((p) => p.id === fk.refTable) })))
      .filter((l) => l.parent && (involved.has(l.child.id) || involved.has(l.parent.id))).slice(0, 40);
    if (!links.length) return decline("I couldn't find a link between the tables you mention. Name both tables, for example: \"when a user is deleted, delete their sessions too\".");
    const second = await reading.ask({ request }, {
      link: choice("`request` says what should happen to some rows when the row they belong to is deleted. Which link is it about?", {
        ...Object.fromEntries(links.map((l, i) => [`l${i}`, `Rows of "${l.child.label}" belong to a row of "${l.parent.label}" (through ${l.fk.columns.join(", ")}). The request is about what happens to the ${l.child.label} when their ${l.parent.label} row is deleted.`])),
        [NONE]: "None of these.",
      }),
      action: choice("According to `request`, what should happen to the linked rows when the row they belong to is deleted?", {
        cascade: "They are deleted too.",
        set_null: "They are kept, and only their link to the deleted row is cleared or emptied.",
        restrict: "The deletion is not allowed while such rows exist.",
      }),
    });
    const link = reading.choice("link", "Link", second.link, { labels: { ...Object.fromEntries(links.map((l, i) => [`l${i}`, `${l.child.label} → ${l.parent.label}`])), [NONE]: "none" } });
    const action = reading.choice("action", "On delete", second.action, { labels: { cascade: "delete them too", set_null: "keep, clear the link", restrict: "block the deletion" } });
    if (!link.ok || link.value === NONE) return decline("I couldn't tell which link you mean. Say it with both tables, for example: \"when a user is deleted, keep their audit events\".");
    if (!action.ok) return decline("I found the link but not what should happen. Say: delete them too, keep them, or block the deletion.");
    const { child, fk } = links[Number(link.value.slice(1))];
    if (fk.onDelete === action.value) return decline(`That is already how it works: ${describeOp({ kind: "set_fk_action", table: child.id, name: fk.name, onDelete: action.value }).replace(/ \(.*\)$/, "").replace(/^./, (c) => c.toLowerCase())}.`);
    const required = action.value === "set_null" ? fk.columns.filter((c) => !child.table.columns.find((x) => x.name === c)?.nullable) : [];
    // A table still in the draft carries its links inside its own CREATE TABLE.
    const holder = !Object.hasOwn(baseline.tables, child.id) && ops.flatMap((o) => (o.kind === "create_table" && `${o.schema}.${o.name}` === child.id ? o.columns : o.kind === "add_column" && o.table === child.id ? [o.column] : []))
      .find((c) => c.ref && c.name === fk.columns[0]);
    if (holder) {
      holder.ref.onDelete = action.value;
      if (required.length) holder.nullable = true;
      return done({ reply: { text: `In the draft, ${child.label}.${holder.name} now ${action.value === "cascade" ? "is deleted with" : action.value === "set_null" ? "is cleared when" : "blocks deleting"} its ${links[Number(link.value.slice(1))].parent.label} row${action.value === "set_null" ? " is deleted" : ""}.`, notes: required.length ? [`${holder.name} had to become optional, since a cleared link is an empty value.`] : [] }, added: [] });
    }
    const made = [...required.map((column) => ({ id: newId(), kind: "drop_not_null", table: child.id, column })), { id: newId(), kind: "set_fk_action", table: child.id, name: fk.name, onDelete: action.value }];
    ops.push(...made);
    return done({ reply: { text: stagedReply(made), notes: required.length ? [`${required.join(", ")} has to become optional first, since a cleared link is an empty value.`] : [] }, added: made.map((o) => o.id) });
  }

  if (op.value === "drop_view") {
    const views = Object.entries(draft.views ?? {}).slice(0, 80);
    if (!views.length) return decline("There are no views here to drop.");
    const named = views.filter(([, v]) => spans.some((sp) => sp.ident === v.name));
    let id = named.length === 1 ? named[0][0] : null;
    if (id) reading.rule("view", "View", draft.views[id].name);
    else {
      const second = await reading.ask({ request }, { view: choice("Which view does `request` ask to delete?", { ...Object.fromEntries(views.map(([vid, v]) => [vid, `The view ${v.name}`])), [NONE]: "None of these." }) });
      const pick = reading.choice("view", "View", second.view, { labels: { ...Object.fromEntries(views.map(([vid, v]) => [vid, v.name])), [NONE]: "none" }, bar: INFERRED });
      if (!pick.ok || pick.value === NONE) return decline(`I couldn't tell which view you mean. There ${views.length === 1 ? "is" : "are"}: ${views.map(([, v]) => v.name).join(", ")}.`);
      id = pick.value;
    }
    // A view that is still only in the draft is simply taken back out.
    const stagedAt = ops.findIndex((o) => o.kind === "create_view" && `${o.schema ?? draft.views[id].schema}.${o.name}` === id);
    if (stagedAt >= 0) { ops.splice(stagedAt, 1); return done({ reply: { text: `Took the view ${draft.views[id].name} back out of the draft.` }, added: [] }); }
    const made = [{ id: newId(), kind: "drop_view", view: id }];
    ops.push(...made);
    return done({ reply: { text: stagedReply(made), notes: ["A view stores nothing, so no data is lost."] }, added: [made[0].id] });
  }

  if (op.value === "change_rows" && !targetTable) {
    if (!tables.length) return decline("There are no tables here yet, so there are no rows to change.");
    const second = await reading.ask({ request }, {
      every: noul("Does `request` ask to remove the rows of every table, all the data, or all the sample data, rather than of particular tables?"),
    });
    if (!reading.noul("every", "Every table", second.every).ok) return decline(DECLINES.no_target);
    const made = [{ id: newId(), kind: "truncate_tables", tables: tables.filter((x) => Object.hasOwn(baseline.tables, x.id)).map((x) => x.id), withDependents: true, restartIdentity: true }];
    if (!made[0].tables.length) return decline("Every table here is still only in the draft, so there are no rows yet.");
    ops.push(...made);
    return done({ reply: { text: stagedReply(made), notes: ["This deletes every row of every table and restarts their numbering. The tables, views and roles stay. Applying it will ask you to type the database name."] }, added: [made[0].id] });
  }

  // The remaining kinds all change one existing table.
  if (!targetTable) return decline(DECLINES.no_target);
  const t = targetTable;
  const noColumn = `I couldn't match that to a column of ${t.label}. It has: ${t.table.columns.slice(0, 30).map((c) => c.name).join(", ")}.`;
  const columnOptions = Object.fromEntries(t.table.columns.slice(0, 120).map((c) => [c.name, `${typeLabel(c.type)}${c.nullable ? "" : ", required"}`]));

  if (op.value === "add_columns") {
    let fields = fieldSpans.filter((f) => !t.table.columns.some((c) => c.name === f.ident));
    if (!fields.length && !fieldSpans.length) {
      // Out of context "limit value" could be anything. Knowing the request adds columns to this table, ask again, plainly.
      const open = dropOverlaps(spans.filter((s) => !existingByIdent(s.ident) && !listed.has(s.ident) && !tableSpans.some((ts) => ts.run === s.run && s.start < ts.end && ts.start < s.end)));
      if (open.length) {
        const again = await reading.ask({ request }, Object.fromEntries(open.map((s) => [`col:${s.order}`, noul(`\`request\` asks to add one or more columns to the table "${t.label}". Is "${s.text}" the name of a column to add?`)])));
        fields = open.filter((s) => reading.noul(`col:${s.order}`, `"${s.text}" is a new column`, again[`col:${s.order}`]).ok && !t.table.columns.some((c) => c.name === s.ident));
      }
    }
    if (!fields.length) return decline(fieldSpans.length ? `${t.label} already has ${fieldSpans.map((f) => f.ident).join(", ")}.` : DECLINES.no_names);
    const q = {};
    fieldQuestions(q, fields);
    valueQuestions(q, valueSpans, fields);
    const second = await reading.ask({ request }, q);
    const built = buildFields(reading, second, fields, valueSpans, t.table.name, t.table.schema, lists, (stem) => { const p = existingByIdent(stem); return p && p.id !== t.id ? p : null; }, draft.enums);
    const staged = !Object.hasOwn(baseline.tables, t.id);
    // A required column cannot be added to a table that already holds rows unless it has a default.
    const relaxed = [];
    if (!staged) for (const c of built.columns) if (c.nullable === false && !c.default && baseline.tables[t.id]?.estRows !== 0) { c.nullable = true; relaxed.push(c.name); }
    ops.push(...built.enums);
    const added = [...built.enums, ...addColumns(ops, baseline, t.id, built.columns)];
    const notes = [];
    if (relaxed.length) notes.push(`${relaxed.join(", ")} would normally be required, but ${t.label} may already hold rows that have no value for ${relaxed.length === 1 ? "it" : "them"}. I left ${relaxed.length === 1 ? "it" : "them"} optional: fill the existing rows, then ask me to make ${relaxed.length === 1 ? "it" : "them"} required.`);
    if (built.columns.length === 1) about.column = built.columns[0].name;
    const unusedHere = unusedNote(t.label, fields);
    if (unusedHere) notes.push(unusedHere);
    if (built.weak.length) notes.push(`I wasn't sure what kind of value ${built.weak.join(", ")} hold${built.weak.length === 1 ? "s" : ""}, so ${built.weak.length === 1 ? "it is" : "they are"} plain text for now.`);
    return done({ reply: { text: staged ? `Added ${built.columns.map((c) => c.name).join(", ")} to the ${t.label} table in the draft.` : stagedReply(added), notes }, added: added.map((o) => o.id) });
  }

  // Reading one test on a column ("expires at is before now", "status is active", "phone is filled in"). Shared by
  // calculated columns and views; only a view may compare with the clock, because it is worked out when it is read.
  const TEST_OPTIONS = {
    gt: "More than, over, above, greater than, after, later than.", gte: "At least, or more, no less than, from … upwards, on or after.",
    lt: "Less than, under, below, before, earlier than.", lte: "At most, or less, no more than, up to, on or before.",
    eq: "Equals, is, is exactly.", neq: "Is not, differs from, anything but.", is_set: "Has a value, is filled in, is present, is known.", is_empty: "Is empty, is missing, is not set, is unknown.",
  };
  const conditionQuestions = (columnChoices, values, pickFrom) => ({
    ctest: choice("If `request` describes a test on a column, which test is it?", TEST_OPTIONS),
    ccol: choice(`If \`request\` describes a test, which column of "${t.label}" is tested?`, { ...columnChoices, [NONE]: "None of these." }),
    ccol2: choice(`If the test in \`request\` compares the tested column with another column of "${t.label}", which column is it compared with?`, { ...columnChoices, [NONE]: "It is compared with a fixed value, or with nothing." }),
    cval: choice("If the test in `request` compares a column with a fixed value, which value is it compared with?", pickFrom(values)),
  });
  // Which test a sentence describes is a matter of its wording, so code reads it. Longer phrases first: "no more than"
  // is not "more than". Jev's answer is kept only as a confident tiebreak when the wording says nothing.
  const TEST_WORDS = [
    ["is_empty", /\b(is|are|was|were)\s+(empty|missing|blank|unset|unknown)\b|\b(has|have|with)\s+no\b|\bwithout\s+an?\b|\bnot\s+(set|filled in|given|known)\b/i],
    ["is_set", /\b(filled in|has a value|have a value|is present|are present|is set|is known|is given|not empty|not blank)\b/i],
    ["gte", /\b(at least|or more|or later|no less than|not less than|on or after|from\b.+\bupwards|minimum of)\b/i],
    ["lte", /\b(at most|or less|or fewer|or earlier|no more than|not more than|on or before|up to|maximum of)\b/i],
    ["gt", /\b(over|above|more than|greater than|bigger than|larger than|higher than|longer than|later than|after|exceeds?|exceeding)\b/i],
    ["lt", /\b(under|below|less than|fewer than|smaller than|lower than|shorter than|earlier than|before)\b/i],
  ];
  const readCondition = (second, said, values, columnList, { clock = false, bar = STATED, onlyValue = null } = {}) => {
    const past = /\b(expired|overdue|in the past|has passed|have passed|lapsed|elapsed)\b/i.test(request), future = /\b(upcoming|in the future|not yet|still valid|still active)\b/i.test(request);
    const negated = mentionsNegation(request.replace(/\b(no longer|not yet|no more than|no less than|not more than|not less than|not empty|not blank|not set|not filled in|not given|not known)\b/gi, " "));
    const worded = TEST_WORDS.find(([, re]) => re.test(request))?.[0] ?? (clock && past ? "lt" : clock && future ? "gt" : null);
    const asked = ranked(second.ctest)[0];
    // No comparison word at all: "the cancelled orders" are those whose status IS cancelled, and "not" needs a "not".
    let test = worded ?? (asked && asked.p >= INFERRED && !["eq", "neq"].includes(asked.value) ? asked.value : negated ? "neq" : "eq");
    if (test === "eq" && negated) test = "neq";
    reading.rule("ctest", "Test", `${{ gt: "more than", gte: "at least", lt: "less than", lte: "at most", eq: "is", neq: "is not", is_set: "has a value", is_empty: "is empty" }[test]}${worded ? " (from the wording)" : asked && test === asked.value ? "" : " (no comparison word, so a plain \"is\")"}`);
    const unary = test === "is_set" || test === "is_empty";

    // The value compared with, read before the column: an allowed value belongs to exactly one column, and says which.
    const fixed = unary ? { ok: false } : reading.choice("cval", "Compared with", second.cval, { bar, labels: { ...Object.fromEntries(Object.keys(values).map((k) => [k, k.replace(/^[nes]:/, "")])), [NONE]: "not found" } });
    // When only one candidate value is left it is the one, whatever share of the probability it got.
    if (onlyValue && !unary) reading.rule("cval:only", "Compared with", `${onlyValue.label ?? onlyValue.text ?? onlyValue.number} (the only value left)`);
    const fixedValue = onlyValue && !unary ? onlyValue : fixed.ok && fixed.value !== NONE ? values[fixed.value]?.[0] : null;
    const owners = fixedValue?.label != null ? t.table.columns.filter((c) => draft.enums[c.type.enum]?.values.includes(fixedValue.label)) : [];
    let tested;
    if (said.length >= 1 && said.length <= 2) { tested = said[0].ident; reading.rule("ccol", "Tested column", tested); }
    else if (owners.length === 1) { tested = owners[0].name; reading.rule("ccol", "Tested column", `${tested} (the column that holds "${fixedValue.label}")`); }
    else {
      const c = reading.choice("ccol", "Tested column", second.ccol, { labels: { [NONE]: "not found" }, bar });
      if (!c.ok || c.value === NONE) return { error: `I couldn't tell which column the test is about. ${columnList}` };
      tested = c.value;
    }
    const condition = { column: tested, test };
    if (unary) return { condition };
    const column = t.table.columns.find((c) => c.name === tested);
    const isMoment = ["date", "timestamp", "timestamptz"].includes(column?.type.base);
    // Against the clock: said outright ("before now", "after today"), or implied by a word like "expired".
    if (clock && isMoment && said.length < 2 && (/\b(now|today|current (time|date)|right now|this moment)\b/i.test(request) || past || future)) {
      condition.value = { clock: column.type.base === "date" ? "today" : "now" };
      reading.rule("cval:clock", "Compared with", condition.value.clock);
      return { condition };
    }
    if (said.length === 2) { condition.value = { column: said[1].ident }; reading.rule("ccol2", "Compared with", said[1].ident); return { condition }; }
    if (fixedValue) { condition.value = fixedValue; return { condition }; }
    const other = reading.choice("ccol2", "Compared with column", second.ccol2, { labels: { [NONE]: "a fixed value" }, bar });
    if (other.ok && other.value !== NONE && other.value !== tested) { condition.value = { column: other.value }; return { condition }; }
    return { error: `I found the test but not what to compare with. I can compare with a number, one of the column's allowed values, yes or no, text in quotes, another column${clock ? ", or now and today" : ""}.` };
  };

  if (op.value === "change_rows") {
    if (!Object.hasOwn(baseline.tables, t.id)) return decline(`${t.label} is still only in the draft, so it has no rows yet. Apply the draft first.`);
    const usable = t.table.columns.filter((c) => c.type.base || c.type.enum).slice(0, 60);
    const columnChoices = Object.fromEntries(usable.map((c) => [c.name, typeLabel(c.type)]));
    const columnList = `${t.label} has: ${usable.map((c) => c.name).join(", ")}.`;
    const settable = usable.filter((c) => !c.identity && !c.generated);
    // A value written as words, read by the column it goes into. Null when the words do not fit that column.
    const valueFor = (column, words) => {
      const raw = String(words).trim().replace(/^["'“]|["'”]$/g, "").trim();
      if (!raw) return null;
      if (/^(empty|nothing|null|blank|none|unset)$/i.test(raw)) return { null: true };
      const e = draft.enums[column.type.enum];
      if (e) { const label = e.values.find((v) => v === raw || v === raw.toLowerCase().replace(/[^a-z0-9]+/g, "_")); return label ? { label } : null; }
      const base0 = column.type.base;
      if (["smallint", "integer", "bigint", "numeric", "real", "double precision"].includes(base0)) { const n = Number(raw.replace(/[,$€£]/g, "")); return Number.isFinite(n) && /\d/.test(raw) ? { number: n } : null; }
      if (base0 === "boolean") return /^(true|yes|on|enabled)$/i.test(raw) ? { bool: true } : /^(false|no|off|disabled)$/i.test(raw) ? { bool: false } : null;
      if (["date", "timestamp", "timestamptz"].includes(base0)) return /^(now|today|the current (time|date))$/i.test(raw) ? { clock: base0 === "date" ? "today" : "now" } : null;
      return ["text", "varchar"].includes(base0) ? { text: raw } : null;
    };
    const spoken = (c) => c.name.replace(/_/g, "[ _]");
    const numbers = numberCandidates(request);
    const quoted = [...request.matchAll(/"([^"]{1,80})"|'([^']{1,80})'|“([^”]{1,80})”/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const labels = usable.flatMap((c) => (draft.enums[c.type.enum]?.values ?? []).filter((v) => new RegExp(`\\b${v.replace(/_/g, "[ _-]")}\\b`, "i").test(request)));
    const values = {
      ...Object.fromEntries(numbers.map((n) => [`n:${n.value}`, [{ number: n.value }, `The number ${n.phrase}`]])),
      ...Object.fromEntries(labels.map((v) => [`e:${v}`, [{ label: v }, `The value "${v.replace(/_/g, " ")}"`]])),
      ...Object.fromEntries(quoted.map((x) => [`s:${x}`, [{ text: x }, `The text "${x}"`]])),
      true: [{ bool: true }, "True, yes"], false: [{ bool: false }, "False, no"],
    };
    const pickFrom = (set) => ({ ...Object.fromEntries(Object.entries(set).map(([k, [, d]]) => [k, d])), [NONE]: "None of these." });
    const second = await reading.ask({ request }, {
      rkind: choice(`\`request\` changes the rows of the table "${t.label}". How?`, {
        delete_some: "Delete only the rows that pass a test. Examples: 'delete sessions where expires at is before now', 'remove the cancelled subscriptions'.",
        empty: "Delete every row of the table, leaving it empty. Examples: 'empty the sessions table', 'clear out users', 'delete all rows'.",
        update: "Change a value in rows that already exist. Examples: 'set every trialing subscription to active', 'set seat limit to 10', 'mark all products as inactive'.",
        insert: "Add one new row. Examples: 'add a product called Explorer', 'insert a role named admin'.",
      }),
      dependents: noul("Does `request` say to also remove the rows of other tables that point at these, such as 'and everything that points at it', 'and everything related', 'with their sessions too'?"),
      ucol: choice(`If \`request\` changes a value in existing rows of "${t.label}", which column gets the new value?`, { ...Object.fromEntries(settable.map((c) => [c.name, typeLabel(c.type)])), [NONE]: "None of these." }),
      uval: choice("If `request` changes a value in existing rows, what is the NEW value they should have afterwards?", { ...pickFrom(values), now: "The current date and time", nothing: "Nothing: the value is cleared, emptied" }),
      ...conditionQuestions(columnChoices, values, pickFrom),
    });
    const kind = reading.choice("rkind", "Row change", second.rkind, { labels: { delete_some: "delete some rows", empty: "empty the table", update: "change a value", insert: "add a row" }, bar: STATED });
    if (!kind.ok) return decline("I couldn't tell whether to delete rows, empty the table, change a value, or add a row. Say it directly, for example: \"delete sessions where expires at is before now\".");
    const said = dropOverlaps(spans.filter((sp) => usable.some((c) => c.name === sp.ident))).sort((x, y) => x.run - y.run || x.start - y.start);
    const warn = "Applying it will ask you to type the database name. It cannot be undone.";

    if (kind.value === "empty") {
      const withDependents = reading.noul("dependents", "Including what points at it", second.dependents).ok;
      const made = [{ id: newId(), kind: "truncate_tables", tables: [t.id], withDependents, restartIdentity: true }];
      ops.push(...made);
      return done({ reply: { text: stagedReply(made), notes: [`Every row of ${t.label} is deleted and its numbering restarts. The table itself stays. ${warn}`] }, added: [made[0].id] });
    }

    if (kind.value === "insert") {
      // Values are read by rule: "called X" is the row's name, and "<column> <value>" gives that column its value.
      const given = [];
      const naming = settable.find((c) => ["name", "title", "label", "full_name", "subject"].includes(c.name));
      const called = /\b(?:called|named|titled)\s+("[^"]+"|'[^']+'|“[^”]+”|[^,]+?)(?=\s+(?:with|and|,)|,|$)/i.exec(request);
      if (called && naming) given.push({ column: naming, words: called[1] });
      for (const c of [...settable].sort((a, b) => b.name.length - a.name.length)) {
        if (given.some((g) => g.column === c)) continue;
        const m = new RegExp(`\\b${spoken(c)}\\s+(?:is\\s+|of\\s+|=\\s*|:\\s*|as\\s+)?("[^"]+"|'[^']+'|“[^”]+”|[^,]+?)(?=\\s+and\\s+|,|$)`, "i").exec(request.replace(called?.[0] ?? "\u0000", " "));
        if (m) given.push({ column: c, words: m[1] });
      }
      if (!given.length) return decline(`I couldn't find the values for the new row. Say them with their columns, for example: "add a row to ${t.label} with ${settable.slice(0, 2).map((c) => `${c.name.replace(/_/g, " ")} …`).join(" and ")}". ${columnList}`);
      const bad = given.filter((g) => !valueFor(g.column, g.words));
      if (bad.length) return decline(`"${bad[0].words.trim()}" is not something ${t.label}.${bad[0].column.name} (${typeLabel(bad[0].column.type)}) can hold.`);
      given.forEach((g) => reading.rule(`ival:${g.column.name}`, g.column.name, String(g.words).trim()));
      const made = [{ id: newId(), kind: "insert_row", table: t.id, values: given.map((g) => ({ column: g.column.name, value: valueFor(g.column, g.words) })) }];
      ops.push(...made);
      return done({ reply: { text: stagedReply(made) }, added: [made[0].id] });
    }

    if (kind.value === "update") {
      // "set <column> to <value>" is read by rule. Otherwise Jev picks the new value, and an allowed value names its own column.
      let column = null, value = null;
      const m = /\b(?:set|change|update|mark)\s+(?:the\s+|every\s+|all\s+|each\s+)?(.+?)\s+(?:to|as|=)\s+("[^"]+"|'[^']+'|“[^”]+”|.+?)(?=\s+(?:on|in|for|where|when|if)\b|$)/i.exec(request);
      const named = m && settable.find((c) => new RegExp(`^(?:${spoken(c)})(?:\\s+(?:of|on|in)\\b.*)?$`, "i").test(m[1].trim()));
      if (named && valueFor(named, m[2])) { column = named; value = valueFor(named, m[2]); reading.rule("set", `Set ${column.name} to`, m[2].trim()); }
      else {
        const pick = reading.choice("uval", "New value", second.uval, { labels: { ...Object.fromEntries(Object.keys(values).map((k) => [k, k.replace(/^[nes]:/, "")])), [NONE]: "not found" } });
        if (!pick.ok || pick.value === NONE) return decline(`I couldn't find the new value. Say it like: "set ${settable[0]?.name.replace(/_/g, " ") ?? "a column"} to … on ${t.label}". ${columnList}`);
        value = pick.value === "now" ? { clock: "now" } : pick.value === "nothing" ? { null: true } : values[pick.value][0];
        const owner = value.label != null ? settable.filter((c) => draft.enums[c.type.enum]?.values.includes(value.label)) : [];
        if (owner.length === 1) { column = owner[0]; reading.rule("ucol:label", "Column", `${column.name} (the column that holds "${value.label}")`); }
        else {
          const c = reading.choice("ucol", "Column", second.ucol, { labels: { [NONE]: "not found" } });
          if (!c.ok || c.value === NONE) return decline(`I couldn't tell which column to change. ${columnList}`);
          column = settable.find((x) => x.name === c.value);
        }
        if (value.clock && column.type.base === "date") value = { clock: "today" };
      }
      // Whether there is a test at all is said by the wording; which rows it picks is then read like any condition.
      const scoped = /\b(where|when|whose|if|only|that (are|is|have|has)|which (are|is))\b/i.test(request) || labels.filter((l) => l !== value.label).length > 0;
      const op2 = { id: newId(), kind: "update_rows", table: t.id, set: { column: column.name, value } };
      if (scoped) {
        const others = Object.fromEntries(Object.entries(values).filter(([, [v]]) => JSON.stringify(v) !== JSON.stringify(value)));
        // The column being set was named as such, so it is not also the column being tested unless it is named again.
        const testedBy = named ? said.filter((sp, i) => !(sp.ident === column.name && said.findIndex((x) => x.ident === column.name) === i)) : said;
        // "set every pending order to paid": with paid taken as the new value, pending is the only value left to test for.
        const left = Object.values(others).map(([v]) => v).filter((v) => v.label != null || v.number != null || v.text != null);
        const got = readCondition(second, testedBy, others, columnList, { clock: true, bar: INFERRED, onlyValue: left.length === 1 && !testedBy.length ? left[0] : null });
        if (got.error) return decline(`I found what to set, but not which rows. ${got.error}`);
        op2.filter = got.condition;
      }
      ops.push(op2);
      return done({ reply: { text: stagedReply([op2]), notes: [`${op2.filter ? "Only the matching rows change." : `Every row of ${t.label} changes: no test was given.`} The old values are not kept. ${warn}`] }, added: [op2.id] });
    }

    // delete_some: every part of the test must be read with the confidence a deletion deserves.
    const got = readCondition(second, said, values, columnList, { clock: true, bar: INFERRED });
    if (got.error) return decline(`To delete some rows I need the test that picks them. ${got.error}`);
    const made = [{ id: newId(), kind: "delete_rows", table: t.id, filter: got.condition }];
    ops.push(...made);
    return done({ reply: { text: stagedReply(made), notes: [`Only the matching rows are deleted; the count is on the right. ${warn}`] }, added: [made[0].id] });
  }

  if (op.value === "create_view") {
    const usable = t.table.columns.filter((c) => c.type.base || c.type.enum).slice(0, 60);
    const columnChoices = Object.fromEntries(usable.map((c) => [c.name, typeLabel(c.type)]));
    const columnList = `${t.label} has: ${usable.map((c) => c.name).join(", ")}.`;
    const numbers = numberCandidates(request);
    const quoted = [...request.matchAll(/"([^"]{1,80})"|'([^']{1,80})'|“([^”]{1,80})”/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const labels = usable.flatMap((c) => (draft.enums[c.type.enum]?.values ?? []).filter((v) => new RegExp(`\\b${v.replace(/_/g, "[ _-]")}\\b`, "i").test(request)));
    const values = {
      ...Object.fromEntries(numbers.map((n) => [`n:${n.value}`, [{ number: n.value }, `The number ${n.phrase}`]])),
      ...Object.fromEntries(labels.map((v) => [`e:${v}`, [{ label: v }, `The value "${v.replace(/_/g, " ")}"`]])),
      ...Object.fromEntries(quoted.map((x) => [`s:${x}`, [{ text: x }, `The text "${x}"`]])),
      true: [{ bool: true }, "True, yes"], false: [{ bool: false }, "False, no"],
    };
    const pickFrom = (set) => ({ ...Object.fromEntries(Object.entries(set).map(([k, [, d]]) => [k, d])), [NONE]: "None of these." });
    const fresh = dropOverlaps(spans.filter((sp) => !t.table.columns.some((c) => c.name === sp.ident) && !existingByIdent(sp.ident) && !labels.includes(sp.ident)));
    const nameChoices = Object.fromEntries(fresh.map((sp) => [`s${sp.order}`, `"${sp.text}"`]));
    const second = await reading.ask({ request }, {
      vkind: choice("`request` asks for a view of a table. What does the test in it do?", {
        flag: "It becomes an extra yes/no column: every row is shown, and the new column says whether the test holds for it.",
        filter: "It picks the rows: only rows for which the test holds are shown.",
      }),
      vname: choice("Which phrase in `request` is the name of the view itself?", { ...nameChoices, [NONE]: "The view is not given a name." }),
      fname: choice("Which phrase in `request` is the name of the new yes/no column?", { ...nameChoices, [NONE]: "There is no new column, or it is not named." }),
      ...conditionQuestions(columnChoices, values, pickFrom),
    });
    const kind = reading.choice("vkind", "The test", second.vkind, { labels: { flag: "adds a yes/no column", filter: "picks the rows" } });
    if (!kind.ok) return decline("I couldn't tell whether the test should become a yes/no column or pick the rows. Say \"with an is expired flag that is true when …\" or \"showing only … where …\".");
    const viewSpan = (() => { const v = reading.choice("vname", "View name", second.vname, { labels: { ...Object.fromEntries(fresh.map((sp) => [`s${sp.order}`, sp.ident])), [NONE]: "not named" } }); return v.ok && fresh.find((sp) => `s${sp.order}` === v.value); })();
    const flagSpan = kind.value === "flag" ? (() => { const v = reading.choice("fname", "New column", second.fname, { labels: { ...Object.fromEntries(fresh.map((sp) => [`s${sp.order}`, sp.ident])), [NONE]: "not named" } }); return v.ok && fresh.find((sp) => `s${sp.order}` === v.value && sp !== viewSpan); })() : null;
    const said = dropOverlaps(spans.filter((sp) => sp !== viewSpan && sp !== flagSpan && usable.some((c) => c.name === sp.ident))).sort((x, y) => x.run - y.run || x.start - y.start);
    const got = readCondition(second, said, values, columnList, { clock: true });
    if (got.error) return decline(got.error);

    // Names that were not given are made by rule, and said to be.
    const notes = [];
    const clockWord = /\bexpired\b/i.test(request) ? "expired" : /\boverdue\b/i.test(request) ? "overdue" : /\bupcoming\b/i.test(request) ? "upcoming" : null;
    const valueWord = got.condition.value?.label ?? (got.condition.test === "is_set" ? `has_${got.condition.column}` : got.condition.test === "is_empty" ? `no_${got.condition.column}` : null);
    const flagName = kind.value === "flag" ? safeName((flagSpan?.ident ?? (clockWord ? `is_${clockWord}` : valueWord ? (valueWord.startsWith("has_") || valueWord.startsWith("no_") ? valueWord : `is_${valueWord}`) : "")).replace(/^((?:is|has|can|was)_.+)_flag$/, "$1")) : null;
    if (kind.value === "flag" && !flagName) return decline("I need a name for the yes/no column. Say it like: \"with an is large flag that is true when quantity is over 100\".");
    if (kind.value === "flag" && !flagSpan) notes.push(`You didn't name the new column, so I called it ${flagName}.`);
    let viewName = viewSpan ? safeName(viewSpan.ident.replace(/_view$/, "")) : kind.value === "filter" && (clockWord ?? valueWord) ? `${clockWord ?? valueWord}_${t.table.name}` : `${t.table.name}_${kind.value === "flag" ? "status" : "selection"}`;
    if (viewName === t.table.name) viewName = `${viewName}_view`;
    if (!viewSpan) notes.push(`You didn't name the view, so I called it ${viewName}. Say "call it …" with your own name if you prefer.`);
    const made = [{ id: newId(), kind: "create_view", schema: t.table.schema, name: viewName, table: t.id, flags: kind.value === "flag" ? [{ name: flagName, condition: got.condition }] : [], ...(kind.value === "filter" ? { filter: got.condition } : {}) }];
    ops.push(...made);
    notes.push("A view stores nothing: it is worked out each time it is read, so a test against now or today is always current. Query it like a table, in Ask or in SQL.");
    return done({ reply: { text: stagedReply(made), notes }, added: [made[0].id] });
  }

  if (op.value === "computed_column") {
    const usable = t.table.columns.filter((c) => !c.generated && (c.type.base || c.type.enum)).slice(0, 60);
    const columnChoices = Object.fromEntries(usable.map((c) => [c.name, typeLabel(c.type)]));
    const fresh = dropOverlaps(spans.filter((s) => !t.table.columns.some((c) => c.name === s.ident) && !existingByIdent(s.ident)));
    if (!fresh.length) return decline(DECLINES.no_names);

    // Constants are found in code: numbers (a percentage becomes a fraction), quoted text, and the allowed values of this table's columns.
    const numbers = numberCandidates(request).map((n) => ({ ...n, percent: new RegExp(`${String(n.phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?(%|percent\\b|per cent\\b)`, "i").test(request) }));
    const quoted = [...request.matchAll(/"([^"]{1,80})"|'([^']{1,80})'|“([^”]{1,80})”/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const labels = usable.flatMap((c) => (draft.enums[c.type.enum]?.values ?? []).filter((v) => new RegExp(`\\b${v.replace(/_/g, "[ _-]")}\\b`, "i").test(request)));
    const values = {
      ...Object.fromEntries(numbers.map((n) => [`n:${n.value}`, [{ number: n.value }, `The number ${n.phrase}`]])),
      ...Object.fromEntries(labels.map((v) => [`e:${v}`, [{ label: v }, `The value "${v.replace(/_/g, " ")}"`]])),
      ...Object.fromEntries(quoted.map((q) => [`s:${q}`, [{ text: q }, `The text "${q}"`]])),
      true: [{ bool: true }, "True, yes"], false: [{ bool: false }, "False, no"],
    };
    const outcomes = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith("n:") || k.startsWith("s:")));
    const pickFrom = (set) => ({ ...Object.fromEntries(Object.entries(set).map(([k, [, d]]) => [k, d])), [NONE]: "None of these." });

    const second = await reading.ask({ request }, {
      formula: choice("`request` asks for a column whose value is calculated. What is the calculation?", {
        multiply: "A column multiplied by another column or by a fixed number: times, multiplied by, the product of, a percentage of.",
        add: "A column plus another column or a fixed number: plus, the sum of, added to.",
        subtract: "A column minus another column or a fixed number, or the time between two moments: minus, the difference, how long between, duration.",
        divide: "A column divided by another column or by a fixed number: divided by, per, a ratio, an average per item.",
        concat: "Two pieces of text joined together, such as a full name from a first and a last name.",
        lower: "The lowercase form of one text column.",
        condition: "A test on a column decides the value: yes or no, or one value when the test holds and another otherwise. Examples: 'is large when quantity is over 100', 'fee is 0 when total is over 50, otherwise 5', 'has phone when phone is filled in', 'is paid when status is paid'.",
        [NONE]: "A different kind of calculation.",
      }),
      first: choice(`Which existing column of "${t.label}" does the calculation read? If it reads two, give the first: for a subtraction the one subtracted from, for the time between two moments the later one.`, { ...columnChoices, [NONE]: "None of these." }),
      second: choice(`Which column of "${t.label}" is the second value in the calculation? For a subtraction it is the one taken away; for the time between two moments it is the earlier one.`, { ...columnChoices, [NONE]: "There is no second column." }),
      newname: choice("Which phrase in `request` is the name of the new, calculated column?", { ...Object.fromEntries(fresh.map((s) => [`s${s.order}`, `"${s.text}"`])), [NONE]: "None of these." }),
      konst: choice("If the calculation in `request` uses a fixed number, which number is it?", pickFrom(Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith("n:"))))),
      // Asked speculatively; only read when the calculation is a condition.
      ...conditionQuestions(columnChoices, values, pickFrom),
      cthen: choice("If `request` names the value the new column gets when the test holds, which is it?", { ...pickFrom(outcomes), [NONE]: "It is simply yes or no, or none of these." }),
      celse: choice("If `request` names the value the new column gets otherwise, when the test does not hold, which is it?", { ...pickFrom(outcomes), [NONE]: "No otherwise-value is given, or none of these." }),
    });
    const formula = reading.choice("formula", "Calculation", second.formula, { labels: { multiply: "a × b", add: "a + b", subtract: "a − b", divide: "a ÷ b", concat: "a joined with b", lower: "lowercase of a", condition: "a condition", [NONE]: "something else" } });
    if (!formula.ok || formula.value === NONE) return decline("I can calculate a column as one column times, plus, minus or divided by another column or a number, the time between two moments, two texts joined, the lowercase of a text, or a condition on a column. Anything else needs the SQL editor.");
    const name = reading.choice("newname", "New column", second.newname, { labels: { ...Object.fromEntries(fresh.map((s) => [`s${s.order}`, s.ident])), [NONE]: "not found" } });
    const span = name.ok && fresh.find((s) => `s${s.order}` === name.value);
    if (!span) return decline("I couldn't find what to call the new column. Say it like: \"add a line total to order items that is quantity times unit price\".");
    const columnList = `${t.label} has: ${usable.map((c) => c.name).join(", ")}.`;
    // Columns named outright are taken as said, in the order said.
    const said = dropOverlaps(spans.filter((s) => s !== span && usable.some((c) => c.name === s.ident))).sort((x, y) => x.run - y.run || x.start - y.start);
    const finish = (extra, notes = []) => {
      // "an is bulk flag" is the flag is_bulk: the word that says what kind of thing it is, is not part of its name.
      const made = [{ id: newId(), kind: "add_generated_column", table: t.id, name: safeName(span.ident.replace(/^((?:is|has|can|was)_.+)_flag$/, "$1")), ...extra }];
      ops.push(...made);
      return done({ reply: { text: stagedReply(made), notes: [...notes, "Postgres calculates it for every row, existing ones included, and keeps it current. It cannot be written to directly."] }, added: [made[0].id] });
    };

    if (formula.value === "condition") {
      // A calculated column must give the same answer every time it is worked out, so it cannot depend on the clock.
      if (/\b(today|now|current(ly)?|overdue|expired?|in the past|ago|yet|still|so far|upcoming)\b/i.test(request)) {
        return decline(`A calculated column is worked out once, when the row is written, so it cannot depend on today or now: a flag like "overdue" or "expired" would be frozen at the moment the row was last written. A view is worked out each time it is read, so ask for that instead.`, {
          suggestions: [{ label: `Make it a view of ${t.label}`, say: request.replace(/^\s*add\b/i, "create a view with").replace(new RegExp(`\\bto ${t.label.replace(/_/g, "[ _]")}\\b`, "i"), `of ${t.label.replace(/_/g, " ")}`) }],
        });
      }
      const got = readCondition(second, said, values, columnList);
      if (got.error) return decline(got.error);
      const condition = got.condition;
      // With nothing left to be an outcome, the column is simply yes or no.
      const spare = Object.keys(outcomes).filter((k) => JSON.stringify(outcomes[k][0]) !== JSON.stringify(condition.value));
      const extra = { template: "when", condition };
      if (spare.length) {
        const then = reading.choice("cthen", "When it holds", second.cthen, { labels: { ...Object.fromEntries(Object.keys(outcomes).map((k) => [k, k.slice(2)])), [NONE]: "yes / no" } });
        const otherwise = reading.choice("celse", "Otherwise", second.celse, { labels: { ...Object.fromEntries(Object.keys(outcomes).map((k) => [k, k.slice(2)])), [NONE]: "nothing" } });
        if (then.ok && then.value !== NONE) {
          extra.then = outcomes[then.value][0];
          if (otherwise.ok && otherwise.value !== NONE && otherwise.value !== then.value) extra.else = outcomes[otherwise.value][0];
        }
      }
      return finish(extra, extra.then && !extra.else ? ["No otherwise-value was given, so the column is empty when the test does not hold."] : []);
    }

    const arity = GENERATED[formula.value].arity;
    const names = said.map((x) => x.ident);
    const arithmetic = ["multiply", "add", "subtract", "divide"].includes(formula.value);
    // "a minus b" says its own order, and "subtract b from a" says it reversed. "The time between a and b" does not, so Jev decides that.
    const spoken = /\bminus\b|\bless\b|\bdivided by\b|\bover\b/i.test(request) ? "as_said" : /\b(subtract(ed|ing)?|take|taking)\b.*\bfrom\b/i.test(request) ? "reversed" : null;

    if (arithmetic && names.length < 2 && numbers.length) {
      // One column and a fixed number: "price times 1.2", "20 percent of price", "monthly price times 12".
      const col = names.length === 1 ? { ok: true, value: names[0], rule: true } : reading.choice("first", "Column", second.first, { labels: { [NONE]: "not found" } });
      if (col.rule) reading.rule("in:0", "Column", col.value);
      if (!col.ok || col.value === NONE) return decline(`I couldn't match the column to calculate from. ${columnList}`);
      let n = numbers.length === 1 ? numbers[0] : null;
      if (n) reading.rule("konst", "Fixed number", n.phrase);
      else {
        const k = reading.choice("konst", "Fixed number", second.konst, { labels: { ...Object.fromEntries(numbers.map((x) => [`n:${x.value}`, x.phrase])), [NONE]: "not found" } });
        n = k.ok && numbers.find((x) => `n:${x.value}` === k.value);
        if (!n) return decline("I couldn't tell which number the calculation uses. Say it with one number, for example: \"price times 1.2\".");
      }
      if (n.percent && formula.value !== "multiply") return decline(`"${n.phrase} percent" only makes sense as a share of something. Say it as a multiplication, for example "${col.value} times ${(1 + n.value / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}" to add ${n.phrase} percent, or "${n.phrase} percent of ${col.value}" for the share itself.`);
      const constant = n.percent ? n.value / 100 : n.value;
      // Order only matters for minus and divided by, and the sentence shows it: which came first, the number or the column?
      const colSpan = said[0]?.text ?? col.value.replace(/_/g, " ");
      const numberCameFirst = request.toLowerCase().indexOf(String(n.phrase).toLowerCase()) < request.toLowerCase().indexOf(colSpan.toLowerCase());
      const constantFirst = ["subtract", "divide"].includes(formula.value) && (spoken === "reversed" ? !numberCameFirst : numberCameFirst);
      return finish({ template: formula.value, columns: [col.value], constant: { number: constant }, ...(constantFirst ? { constantFirst: true } : {}) }, n.percent ? [`${n.phrase} percent is the fraction ${constant}.`] : []);
    }

    if (formula.value === "subtract" && spoken === "reversed") names.reverse();
    const byRule = names.length === arity && (!["subtract", "divide"].includes(formula.value) || spoken);
    if (byRule) names.forEach((c, i) => reading.rule(`in:${i}`, i ? "Second value" : "First value", c));
    const a = byRule ? { ok: true, value: names[0] } : reading.choice("first", "First value", second.first, { labels: { [NONE]: "not found" } });
    const b = arity === 2 ? (byRule ? { ok: true, value: names[1] } : reading.choice("second", "Second value", second.second, { labels: { [NONE]: "not found" } })) : null;
    if (!a.ok || a.value === NONE || (b && (!b.ok || b.value === NONE))) return decline(`I couldn't match the columns to calculate from. ${columnList}`);
    if (b && a.value === b.value) return decline(`Both values came out as ${a.value}. Name the two columns, for example "quantity times unit price".`);
    return finish({ template: formula.value, columns: b ? [a.value, b.value] : [a.value] }, formula.value === "divide" ? ["Where the divisor is zero the result is empty, rather than an error that would block the row."] : []);
  }

  if (op.value === "unique_together") {
    const describe = (c) => { const fk = t.table.fks.find((f) => f.columns.includes(c.name)); return fk ? `a reference to one row of "${tables.find((p) => p.id === fk.refTable)?.label ?? "another table"}"` : typeLabel(c.type); };
    const candidates = t.table.columns.filter((c) => !c.identity && !["created_at", "updated_at"].includes(c.name)).slice(0, 40);
    // Rules that already exist on this table can be changed or removed, not only added.
    const rules = t.table.uniques.filter((u) => u.columns.length > 1).slice(0, 12);
    if (rules.length) {
      const about = await reading.ask({ request }, {
        ruleact: choice(`The table "${t.label}" already has rules that make a combination of columns unique. What does \`request\` ask for?`, {
          new_rule: "A new, additional combination that must be unique. The existing rules are not mentioned.",
          change_rule: "An existing rule should cover different columns: a column is added to it, taken out of it, or the combination is replaced ('instead', 'as well', 'no longer by').",
          remove_rule: "An existing rule should stop applying, with nothing in its place ('no longer need to be unique', 'remove the rule', 'allow duplicates').",
        }),
        which: choice("Which existing rule is `request` about?", { ...Object.fromEntries(rules.map((u, i) => [`u${i}`, `The combination of ${u.columns.join(" and ")} must be unique`])), [NONE]: "None of these." }),
      });
      const act = reading.choice("ruleact", "Rule", about.ruleact, { labels: { new_rule: "a new rule", change_rule: "change a rule", remove_rule: "remove a rule" } });
      if (act.ok && act.value !== "new_rule") {
        const which = rules.length === 1 ? { ok: true, value: "u0" } : reading.choice("which", "Existing rule", about.which, { labels: { ...Object.fromEntries(rules.map((u, i) => [`u${i}`, u.columns.join(" + ")])), [NONE]: "none" }, bar: act.value === "remove_rule" ? INFERRED : STATED });
        if (!which.ok || which.value === NONE) return decline(`I couldn't tell which rule you mean. ${t.label} has: ${rules.map((u) => u.columns.join(" + ")).join("; ")}.`);
        const rule = rules[Number(which.value.slice(1))];
        // A rule that is still only in the draft is an op; edit or remove that op instead of dropping something that does not exist yet.
        const stagedAt = ops.findIndex((o) => o.kind === "add_unique" && o.table === t.id && o.columns.join() === rule.columns.join());
        let columns = null;
        if (act.value === "change_rule") {
          const after = await reading.ask({ request, current_rule: rule.columns }, Object.fromEntries(candidates.map((c) => [`after:${c.name}`,
            noul(`In the table "${t.label}" the combination \`current_rule\` must be unique, and \`request\` changes that rule. After the change, is the column "${c.name}" part of the combination?`)])));
          columns = candidates.filter((c) => reading.noul(`after:${c.name}`, `Afterwards includes ${c.name}`, after[`after:${c.name}`]).ok).map((c) => c.name);
          if (columns.length < 2) return decline(`After that change the rule would cover ${columns.length ? "only " + columns[0] : "no columns"}. A combination needs at least two; to drop the rule say "remove the rule".`);
          if (columns.join() === rule.columns.join()) return decline(`That is already the rule: ${rule.columns.join(" + ")} must be unique in ${t.label}.`);
        }
        if (stagedAt >= 0) {
          if (columns) ops[stagedAt].columns = columns; else ops.splice(stagedAt, 1);
          return done({ reply: { text: columns ? `In the draft, the rule on ${t.label} now covers ${columns.join(" + ")}.` : `Removed the rule on ${rule.columns.join(" + ")} from the draft.` }, added: [] });
        }
        const made = [{ id: newId(), kind: "drop_constraint", table: t.id, name: rule.name }, ...(columns ? [{ id: newId(), kind: "add_unique", table: t.id, columns }] : [])];
        ops.push(...made);
        return done({ reply: { text: stagedReply(made), notes: columns ? [`The old rule (${rule.columns.join(" + ")}) is removed and the new one added in the same transaction, so there is no moment without a rule.`] : [] }, added: made.map((o) => o.id) });
      }
    }
    // Columns named outright are taken as said ("provider and provider user id together"): the longest phrase wins, so
    // "provider user id" does not also count as "user id". Jev is asked only when the wording is indirect ("per user").
    const named = dropOverlaps(spans.filter((s) => candidates.some((c) => c.name === s.ident))).map((s) => s.ident);
    if (named.length >= 2) {
      named.forEach((c) => reading.rule(`ucol:${c}`, `Combination includes ${c}`, "named in the request"));
      const made = [{ id: newId(), kind: "add_unique", table: t.id, columns: candidates.map((c) => c.name).filter((c) => named.includes(c)) }];
      ops.push(...made);
      return done({ reply: { text: stagedReply(made) }, added: [made[0].id] });
    }
    const second = await reading.ask({ request }, Object.fromEntries(candidates.map((c) => [`ucol:${c.name}`,
      noul(`\`request\` says that some columns of the table "${t.label}" must be unique in combination. Is the column "${c.name}" (${describe(c)}) one of the columns in that combination?`)])));
    const columns = candidates.filter((c) => reading.noul(`ucol:${c.name}`, `Combination includes ${c.name}`, second[`ucol:${c.name}`], { bar: COMBINATION, quietBelow: 0.05 }).ok).map((c) => c.name);
    if (columns.length < 2) return decline(`I need at least two columns of ${t.label} for a combination${columns.length ? `, and only found ${columns[0]}` : ""}. It has: ${t.table.columns.map((c) => c.name).join(", ")}. For a single column, say "${columns[0] ?? "email"} must be unique".`);
    const made = [{ id: newId(), kind: "add_unique", table: t.id, columns }];
    ops.push(...made);
    return done({ reply: { text: stagedReply(made) }, added: [made[0].id] });
  }

  const q = { col: choice(`Which column of the table "${t.label}" does \`request\` refer to?`, { ...columnOptions, [NONE]: "None of these columns, or the request is about the whole table." }) };
  if (op.value === "change_column") {
    q.change = choice("What change does `request` ask for?", {
      make_required: "The column must always have a value (required, mandatory, not null).",
      make_optional: "The column may be left empty (optional, nullable).",
      make_unique: "No two rows may share a value in this column.",
      allow_duplicates: "The column does not need to be unique: several rows may share the same value.",
      change_type: "The column should hold a different type of data.",
      set_default: "The column should get a default value: the value used when none is given.",
      remove_default: "The column should no longer have a default value.",
    });
    // "unique and required" is two changes to one column. The main one is chosen above; these catch what rides along.
    q.also_required = noul("Does `request` say the column must always have a value (required, mandatory, not null)?");
    q.also_optional = noul("Does `request` say the column may be left empty (optional, nullable)?");
    q.also_unique = noul("Does `request` say that no two rows may share a value in this column (unique)?");
    q.newtype = choice("If `request` asks to change what type of data a column holds, which type does it ask for?", { ...Object.fromEntries(Object.entries(SIMPLE_TYPES).map(([k, [, d]]) => [k, d])), [NONE]: "It does not ask for a type." });
  }
  // Candidate default values are found in code: numbers, true/false, now/today, quoted text, and the labels of this table's enums.
  const defaults = {};
  if (op.value === "change_column") {
    numberCandidates(request).forEach((n) => { defaults[`n:${n.value}`] = [{ kind: "number", value: n.value }, `The number ${n.phrase}`]; });
    if (/\b(zero|none)\b/i.test(request) && !defaults["n:0"]) defaults["n:0"] = [{ kind: "number", value: 0 }, "The number zero"];
    defaults.true = [{ kind: "bool", value: true }, "True, yes, on, enabled"];
    defaults.false = [{ kind: "bool", value: false }, "False, no, off, disabled"];
    defaults.now = [{ kind: "now" }, "The current date and time, now, the moment the row is created"];
    defaults.today = [{ kind: "current_date" }, "Today's date"];
    // "30 days from now": a default worked out from the moment the row is created.
    for (const m of request.matchAll(/\b(\d{1,5}|an?|one)\s+(minute|hour|day|week|month|year)s?\s+(from now|from today|later|after|in the future|ahead|from creation|from when)/gi)) {
      const amount = /^\d/.test(m[1]) ? Number(m[1]) : 1, unit = m[2].toLowerCase() + "s";
      defaults[`in:${amount}:${unit}`] = [{ kind: "now_plus", amount, unit }, `${amount} ${unit} after the moment the row is created`];
    }
    defaults.uuid = [{ kind: "uuid" }, "A newly generated random UUID"];
    defaults.empty_json = [{ kind: "empty_json" }, "An empty JSON object"];
    for (const c of t.table.columns) for (const v of draft.enums[c.type.enum]?.values ?? []) if (new RegExp(`\\b${v.replace(/_/g, "[ _-]")}\\b`, "i").test(request)) defaults[`e:${v}`] = [{ kind: "enum_label", value: v }, `The value "${v.replace(/_/g, " ")}"`];
    for (const m of request.matchAll(/"([^"]{1,80})"|'([^']{1,80})'/g)) defaults[`s:${m[1] ?? m[2]}`] = [{ kind: "string", value: m[1] ?? m[2] }, `The text "${m[1] ?? m[2]}"`];
    q.defval = choice("If `request` asks for a column to get a default value, which value is it?", { ...Object.fromEntries(Object.entries(defaults).map(([k, [, d]]) => [k, d])), [NONE]: "It does not ask for a default, or the value is none of these." });
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
  let stage = (made, sure = true) => {
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
  let col = reading.choice("col", "Column", second.col, { labels: { [NONE]: "no column" }, applied: what.value !== "table", bar });
  // "make it required" after "add a phone number to customers": the column is the one just spoken about.
  if ((!col.ok || col.value === NONE) && focus.column && t.id === focus.table && t.table.columns.some((c) => c.name === focus.column) && /\b(it|its|that|this|them|those)\b/i.test(request) && !destructive) {
    col = { ok: true, value: focus.column, p: 1 };
    reading.rule("col:carried", "Column", `${focus.column} (carried over)`);
  }
  if (col.ok && col.value !== NONE) about.column = col.value;
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
  const change = reading.choice("change", "Change", second.change, { labels: { make_required: "required", make_optional: "optional", make_unique: "unique", allow_duplicates: "not unique", change_type: "new type", set_default: "default", remove_default: "no default" } });
  if (!change.ok) return decline("I found the column but not what to change about it. Say, for example: \"make it required\", \"make it optional\", \"must be unique\" or \"change it to a date\".");
  const base = { id: newId(), table: t.id, column: col.value };
  const column0 = t.table.columns.find((c) => c.name === col.value);
  const alreadyUnique = t.table.uniques.some((u) => u.columns.length === 1 && u.columns[0] === col.value);
  // Changes that ride along with the main one, when they would actually change something.
  const extras = [];
  if (change.value !== "make_required" && change.value !== "make_optional" && column0?.nullable && reading.noul("also_required", "Also required", second.also_required).ok) extras.push({ id: newId(), kind: "set_not_null", table: t.id, column: col.value });
  if (change.value !== "make_required" && change.value !== "make_optional" && !column0?.nullable && reading.noul("also_optional", "Also optional", second.also_optional).ok) extras.push({ id: newId(), kind: "drop_not_null", table: t.id, column: col.value });
  if (!["make_unique", "allow_duplicates"].includes(change.value) && !alreadyUnique && reading.noul("also_unique", "Also unique", second.also_unique).ok) extras.push({ id: newId(), kind: "add_unique", table: t.id, columns: [col.value] });
  if (extras.length) {
    const main = stage;
    // Stage the extras after the main change, each through the same path, so draft tables still fold them in.
    stage = (made, sure = true) => {
      const first = main(made, sure);
      if (!first.ok) return first;
      const texts = [first.reply.text];
      for (const extra of extras) { const r = main([extra]); if (r.ok) { texts.push(r.reply.text); first.added.push(...r.added); } }
      const folded = texts.every((x) => / in the draft\.$/.test(x));
      return { ...first, reply: { ...first.reply, text: folded ? texts.join(" ") : stagedReply(ops.filter((o) => first.added.includes(o.id))) } };
    };
  }
  if (change.value === "make_required") return stage([{ ...base, kind: "set_not_null" }]);
  if (change.value === "make_optional") return stage([{ ...base, kind: "drop_not_null" }]);
  if (change.value === "remove_default") return stage([{ ...base, kind: "drop_default" }]);
  if (change.value === "set_default") {
    const pick = reading.choice("defval", "Default value", second.defval, { labels: { ...Object.fromEntries(Object.entries(defaults).map(([k, [v]]) => [k, defaultLabel(v)])), [NONE]: "not found" } });
    if (!pick.ok || pick.value === NONE) return decline("I couldn't find the default value in your message. I can set a number, true or false, now, today, a time from now (\"30 days from now\"), a new UUID, an empty JSON object, one of the column's allowed values, or text in quotes.");
    const value = defaults[pick.value][0];
    const column = t.table.columns.find((c) => c.name === col.value);
    // Whether a value suits a column's type is checkable, so it is checked here rather than asked.
    const base0 = column.type.base;
    const fits = { number: ["smallint", "integer", "bigint", "numeric", "real", "double precision"], bool: ["boolean"], now: ["timestamptz", "timestamp"], now_plus: ["timestamptz", "timestamp", "date"], current_date: ["date"], uuid: ["uuid"], empty_json: ["jsonb", "json"], string: ["text", "varchar"] }[value.kind];
    const ok = value.kind === "enum_label" ? draft.enums[column.type.enum]?.values.includes(value.value) : fits.includes(base0);
    if (!ok) return decline(`${defaultLabel(value)} is not a value that ${t.label}.${column.name} (${typeLabel(column.type)}) can hold.`);
    return stage([{ ...base, kind: "set_default", default: value }]);
  }
  if (change.value === "allow_duplicates") {
    const staged = !Object.hasOwn(baseline.tables, t.id) && ops.find((o) => o.kind === "create_table" && `${o.schema}.${o.name}` === t.id);
    const column = staged ? staged.columns.find((c) => c.name === col.value) : null;
    if (column) {
      if (!column.unique) return decline(`${t.label}.${col.value} is not unique in the draft.`);
      column.unique = false;
      return done({ reply: { text: `${t.label}.${col.value} no longer has to be unique in the draft.` }, added: [] });
    }
    const rule = t.table.uniques.find((u) => u.columns.length === 1 && u.columns[0] === col.value);
    if (!rule) return decline(`${t.label}.${col.value} has no unique rule of its own to remove.`);
    return stage([{ id: newId(), kind: "drop_constraint", table: t.id, name: rule.name }]);
  }
  if (change.value === "make_unique") return stage([{ id: base.id, kind: "add_unique", table: t.id, columns: [col.value] }]);
  const newtype = reading.choice("newtype", "New type", second.newtype, { labels: { [NONE]: "not stated" } });
  if (!newtype.ok || newtype.value === NONE) return decline("I couldn't tell which type you want. Say, for example: \"change it to a whole number\", \"to a date\" or \"to money\".");
  return stage([{ ...base, kind: "alter_column_type", type: SIMPLE_TYPES[newtype.value][0] }]);
}
