import { quoteIdent, qualified, quoteLiteral } from "../db.js";
import { typeSql, typeLabel, sameType, isSafeWidening, CHECKS, ON_DELETE, PRIVILEGES, POLICY_COMMANDS, GENERATED, INTERVAL_UNITS, ARITHMETIC, TESTS, isNumericBase, isWholeBase, isTextBase } from "./types.js";
import {
  OpError, checkNewIdent, constraintName, relationNames, constraintNames, getTable, getColumn, referenceable, checkFkTypes,
} from "./validate.js";

// Replays ops on a clone of the live design. Each op is checked against the design as it stands when
// its turn comes, changes it, and yields its SQL, so the order the user built the draft in is always
// a valid order to execute. An op that no longer fits (its table was removed from the draft, say)
// is reported as broken and skipped; it never reaches SQL.
//
// SQL is assembled only from quoted identifiers, quoted literals and the whitelists in types.js.

const BIG_TABLE = 1_000_000;
const tableSql = (t) => qualified(t.schema, t.name);
const cols = (names) => names.map(quoteIdent).join(", ");
const idOf = (t) => `${t.schema}.${t.name}`;
// A table with no rows (new in this draft, or analysed and empty) cannot fail a new rule. -1 means never analysed.
const guard = (t, reason) => (t.estRows === 0 ? { level: "safe" } : { level: "caution", reason });

function enumSql(design) {
  return (id) => {
    const e = Object.hasOwn(design.enums, id) ? design.enums[id] : null;
    if (!e) throw new OpError(`The enum ${String(id).slice(0, 80)} does not exist at this point in the draft`);
    return qualified(e.schema, e.name);
  };
}

function defaultSql(design, column, ctx) {
  const d = column.default;
  if (!d) return null;
  switch (d.kind) {
    case "now": return "now()";
    case "now_plus": {
      if (!INTERVAL_UNITS.includes(d.unit)) throw new OpError("Unknown unit of time");
      if (!["timestamptz", "timestamp", "date"].includes(column.type.base)) throw new OpError(`${column.name} is ${typeLabel(column.type)}, which cannot hold a moment in time`);
      return `now() + interval '${Number(d.amount) | 0} ${d.unit}'`;
    }
    case "current_date": return "CURRENT_DATE";
    case "uuid":
      if (design.versionNum < 130000) throw new OpError("gen_random_uuid() needs Postgres 13 or newer");
      return "gen_random_uuid()";
    case "bool": return d.value ? "true" : "false";
    case "number": return String(Number(d.value));
    case "empty_json": return "'{}'::jsonb";
    case "string": return quoteLiteral(d.value);
    case "enum_label": {
      const e = column.type.enum && design.enums[column.type.enum];
      if (!e || !e.values.includes(d.value)) throw new OpError(`"${d.value}" is not a value of that enum`);
      if (ctx.newLabels.has(`${column.type.enum}\0${d.value}`)) throw new OpError(`"${d.value}" is added in this same draft. Postgres cannot use a new enum value until the change that adds it is applied: apply first, then set the default`);
      return quoteLiteral(d.value);
    }
    default: throw new OpError("That default cannot be set by Creator");
  }
}

/** Resolve a column spec from an op into a design column, plus the constraints it brings with it. */
function buildColumn(design, table, spec, ctx) {
  checkNewIdent(spec.name, "column name");
  if (table.columns.some((c) => c.name === spec.name)) throw new OpError(`${table.name} already has a column "${spec.name}"`);
  const column = { name: spec.name, nullable: spec.nullable !== false, default: spec.default ?? null, identity: null, generated: false, comment: spec.comment ?? null };
  if (spec.archetype) column.archetype = spec.archetype;
  const extra = { fk: null, unique: null, check: null };
  if (spec.ref) {
    const target = spec.ref.table === idOf(table) ? table : getTable(design, spec.ref.table);
    if (!target.pk || target.pk.columns.length !== 1) throw new OpError(`${target.name} needs a single-column primary key before another table can reference it`);
    const pkCol = getColumn(target, target.pk.columns[0]);
    column.type = structuredClone(pkCol.type);
    if (column.type.raw) throw new OpError(`${target.name}'s key has a type Creator cannot reproduce (${column.type.raw})`);
    if (spec.ref.onDelete === "set_null" && !column.nullable) throw new OpError(`"${spec.name}" is required, so it cannot be cleared when the ${target.name} row is deleted`);
    extra.fk = { name: constraintName(table.name, [spec.name], "fkey"), columns: [spec.name], refTable: idOf(target), refColumns: [...target.pk.columns], onDelete: spec.ref.onDelete, onUpdate: "no_action" };
  } else {
    column.type = spec.type;
    typeSql(column.type, enumSql(design));
  }
  if (spec.unique) extra.unique = { name: constraintName(table.name, [spec.name], "key"), columns: [spec.name] };
  if (spec.check) extra.check = { name: constraintName(table.name, [spec.name], "check"), template: spec.check, column: spec.name };
  return { column, extra };
}

function columnSql(design, column, ctx) {
  let sql = `${quoteIdent(column.name)} ${typeSql(column.type, enumSql(design))}`;
  if (column.identity) sql += " GENERATED ALWAYS AS IDENTITY";
  const def = defaultSql(design, column, ctx);
  if (def) sql += ` DEFAULT ${def}`;
  if (!column.nullable) sql += " NOT NULL";
  return sql;
}

const fkSql = (design, fk) => {
  const target = design.tables[fk.refTable];
  return `CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${cols(fk.columns)}) REFERENCES ${tableSql(target)} (${cols(fk.refColumns)}) ON DELETE ${ON_DELETE[fk.onDelete] ?? "RESTRICT"}`;
};
const checkSql = (k) => `CONSTRAINT ${quoteIdent(k.name)} CHECK (${CHECKS[k.template](quoteIdent(k.column))})`;
const indexCovers = (table, columns) => [table.pk, ...table.uniques, ...table.indexes].some((k) => k && columns.every((c, i) => k.columns[i] === c));

function addIndex(design, table, columns, unique, out, why) {
  const name = constraintName(table.name, columns, unique ? "key_idx" : "idx");
  if (relationNames(design, table.schema).has(name)) throw new OpError(`An index named ${name} already exists`);
  table.indexes.push({ name, columns: [...columns], unique, method: "btree" });
  const caution = table.estRows > BIG_TABLE;
  out.push({
    sql: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${tableSql(table)} (${cols(columns)});`,
    level: caution || unique ? "caution" : "safe",
    reason: caution ? `Building an index on about ${table.estRows.toLocaleString("en-US")} rows blocks writes to ${table.name} until it finishes` : unique && why !== "new" ? "Fails if existing rows hold duplicates" : why === "fk" ? "Index on a foreign key, so joins and deletes on the parent stay fast" : undefined,
  });
  return name;
}

const numberSql = (n) => (n < 0 ? `(${String(Number(n))})` : String(Number(n)));
const constantSql = (c) => (c.text != null ? quoteLiteral(c.text) : numberSql(c.number));

/**
 * SQL for one test on a column, with the columns it reads. `clock` allows comparing with now() / CURRENT_DATE, which only
 * something evaluated when it is read (a view) may do; a stored calculated column may not.
 */
function conditionSql(d, t, k, { clock = false, input = (name) => getColumn(t, name) } = {}) {
  const test = k && Object.hasOwn(TESTS, k.test ?? "") ? TESTS[k.test] : null;
  if (!test) throw new OpError("That condition is not one Creator can write");
  const a = input(k.column);
  const reads = [a.name];
  let right = null;
  if (!test.unary) {
    const v = k.value;
    if (!v) throw new OpError("The condition needs something to compare with");
    const ordered = isNumericBase(a.type.base) || ["date", "timestamp", "timestamptz", "interval"].includes(a.type.base);
    if (test.ordered && !ordered) throw new OpError(`"${test.words}" needs a number or a date, and ${a.name} is ${typeLabel(a.type)}`);
    if (v.clock != null) {
      if (!clock) throw new OpError("A stored calculated column cannot depend on now or today. A view can");
      if (!["date", "timestamp", "timestamptz"].includes(a.type.base)) throw new OpError(`${a.name} is ${typeLabel(a.type)}, which cannot be compared with ${v.clock}`);
      right = a.type.base === "date" ? "CURRENT_DATE" : "now()";
    } else if (v.column != null) {
      const b = input(v.column);
      if (!sameType(a.type, b.type) && !(isNumericBase(a.type.base) && isNumericBase(b.type.base))) throw new OpError(`${a.name} (${typeLabel(a.type)}) and ${b.name} (${typeLabel(b.type)}) cannot be compared`);
      if (b.name === a.name) throw new OpError("A column cannot be compared with itself");
      reads.push(b.name);
      right = quoteIdent(b.name);
    } else if (v.label != null) {
      const e = a.type.enum && d.enums[a.type.enum];
      if (!e?.values.includes(v.label)) throw new OpError(`"${v.label}" is not one of the values ${a.name} can hold`);
      if (test.ordered) throw new OpError("An allowed value can only be tested with is / is not");
      right = `${quoteLiteral(v.label)}::${qualified(e.schema, e.name)}`;
    } else if (v.bool != null) {
      if (a.type.base !== "boolean" || test.ordered) throw new OpError(`${a.name} is not a yes/no column`);
      right = v.bool ? "true" : "false";
    } else if (v.number != null) {
      if (!isNumericBase(a.type.base)) throw new OpError(`${a.name} is ${typeLabel(a.type)}, which cannot be compared with a number`);
      right = numberSql(v.number);
    } else if (v.text != null) {
      if (!isTextBase(a.type.base) || test.ordered) throw new OpError(`${a.name} is ${typeLabel(a.type)}, which cannot be compared with that text`);
      right = quoteLiteral(v.text);
    } else throw new OpError("The condition needs something to compare with");
  }
  return { sql: test.sql(quoteIdent(a.name), right), reads };
}

/** SQL for a value stored into `column`, checked against the column's type. */
function valueSql(d, t, column, v) {
  const c = getColumn(t, column);
  if (c.identity || c.generated) throw new OpError(`${t.name}.${c.name} is filled in by Postgres and cannot be set`);
  if (!v) throw new OpError(`A value for ${c.name} is needed`);
  const kind = typeLabel(c.type);
  if (v.null) { if (!c.nullable) throw new OpError(`${t.name}.${c.name} is required, so it cannot be emptied`); return "NULL"; }
  if (v.clock != null) {
    if (!["date", "timestamp", "timestamptz"].includes(c.type.base)) throw new OpError(`${c.name} is ${kind}, which cannot hold ${v.clock}`);
    return c.type.base === "date" ? "CURRENT_DATE" : "now()";
  }
  if (v.label != null) {
    const e = c.type.enum && d.enums[c.type.enum];
    if (!e?.values.includes(v.label)) throw new OpError(`"${v.label}" is not one of the values ${c.name} can hold${e ? ` (${e.values.join(", ")})` : ""}`);
    return `${quoteLiteral(v.label)}::${qualified(e.schema, e.name)}`;
  }
  if (v.bool != null) { if (c.type.base !== "boolean") throw new OpError(`${c.name} is ${kind}, not yes/no`); return v.bool ? "true" : "false"; }
  if (v.number != null) { if (!isNumericBase(c.type.base)) throw new OpError(`${c.name} is ${kind}, which cannot hold a number`); return numberSql(v.number); }
  if (v.text != null) {
    // Text may also be written into an enum column when it is one of its values.
    const e = c.type.enum && d.enums[c.type.enum];
    if (e) { const label = e.values.find((x) => x === v.text || x === v.text.toLowerCase().replace(/[^a-z0-9]+/g, "_")); if (!label) throw new OpError(`"${v.text}" is not one of the values ${c.name} can hold (${e.values.join(", ")})`); return `${quoteLiteral(label)}::${qualified(e.schema, e.name)}`; }
    if (!isTextBase(c.type.base)) throw new OpError(`${c.name} is ${kind}, which cannot hold text`);
    return quoteLiteral(v.text);
  }
  throw new OpError(`A value for ${c.name} is needed`);
}

const rowsWord = (t) => `rows of ${t.name}`;

/** The expression, result type and input columns of a calculated column. Built from templates, quoted names and literals only. */
function generatedExpression(d, t, op) {
  const input = (name) => {
    const c = getColumn(t, name);
    if (c.generated) throw new OpError("A calculated column cannot be built from another calculated column");
    return c;
  };
  if (op.template === "when") {
    const { sql: condition, reads } = conditionSql(d, t, op.condition, { input });
    if (!op.then) {
      if (op.else) throw new OpError("An otherwise-value needs a value for when the condition holds");
      return { sql: condition, type: { base: "boolean" }, reads };
    }
    if (op.else && (op.then.text != null) !== (op.else.text != null)) throw new OpError("Both outcomes must be numbers, or both text");
    const type = op.then.text != null ? { base: "text" } : { base: "numeric" };
    return { sql: `CASE WHEN ${condition} THEN ${constantSql(op.then)}${op.else ? ` ELSE ${constantSql(op.else)}` : ""} END`, type, reads };
  }

  const g = Object.hasOwn(GENERATED, op.template ?? "") ? GENERATED[op.template] : null;
  if (!g) throw new OpError("That calculation is not one Creator can write");
  if (op.constant) {
    if (!ARITHMETIC.includes(op.template) || op.constant.number == null) throw new OpError("Only times, plus, minus and divided by can use a fixed number");
    if (op.columns.length !== 1) throw new OpError("A calculation with a fixed number uses exactly one column");
    const a = input(op.columns[0]);
    if (!isNumericBase(a.type.base)) throw new OpError(`${a.name} is ${typeLabel(a.type)}, not a number`);
    const n = op.constant.number;
    if (op.template === "divide" && !op.constantFirst && n === 0) throw new OpError("Dividing by zero is not a calculation");
    const col = quoteIdent(a.name), k = numberSql(n);
    const sql = op.template === "divide" ? (op.constantFirst ? `${k}::numeric / NULLIF(${col}, 0)` : `(${col})::numeric / ${k}`) : g.sql(...(op.constantFirst ? [k, col] : [col, k]));
    const whole = isWholeBase(a.type.base) && Number.isInteger(n) && op.template !== "divide";
    return { sql, type: { base: whole ? "bigint" : "numeric" }, reads: [a.name] };
  }
  if (op.columns.length !== g.arity) throw new OpError(`That calculation needs ${g.arity} column${g.arity === 1 ? "" : "s"}`);
  const inputs = op.columns.map(input);
  const type = g.result(...inputs.map((c) => c.type.base));
  if (!type) throw new OpError(`${inputs.map((c) => `${c.name} (${typeLabel(c.type)})`).join(" and ")} cannot be combined that way`);
  return { sql: g.sql(...op.columns.map(quoteIdent)), type, reads: [...op.columns] };
}

function grantTargets(design, op) {
  if (op.allIn) {
    if (!design.schemas.includes(op.allIn)) throw new OpError(`Schema ${op.allIn} does not exist`);
    return { schema: op.allIn, tables: Object.values(design.tables).filter((t) => t.schema === op.allIn), on: `ALL TABLES IN SCHEMA ${quoteIdent(op.allIn)}` };
  }
  const t = getTable(design, op.table);
  return { schema: t.schema, tables: [t], on: tableSql(t) };
}

function needRole(design, name) {
  if (!Object.hasOwn(design.roles, name ?? "")) throw new OpError(`Role ${String(name).slice(0, 60)} does not exist at this point in the draft`);
  return name;
}

// One handler per op kind: (design, op, out, ctx) → inverse ops, or null when the change cannot be undone.
const STEPS = {
  create_schema(d, op, out) {
    checkNewIdent(op.name, "schema name");
    if (d.schemas.includes(op.name)) throw new OpError(`Schema ${op.name} already exists`);
    d.schemas.push(op.name);
    out.push({ sql: `CREATE SCHEMA ${quoteIdent(op.name)};`, level: "safe" });
    return null;
  },

  create_table(d, op, out, ctx) {
    checkNewIdent(op.name, "table name");
    if (!d.schemas.includes(op.schema)) throw new OpError(`Schema ${op.schema} does not exist`);
    if (relationNames(d, op.schema).has(op.name)) throw new OpError(`${op.schema} already has something named ${op.name}`);
    const table = { schema: op.schema, name: op.name, comment: op.comment ?? null, rls: false, estRows: 0, columns: [], pk: null, fks: [], uniques: [], checks: [], indexes: [], policies: [], grants: [] };
    if (op.conventions.id) {
      if (op.columns.some((c) => c.name === "id")) throw new OpError(`"id" is added automatically. Turn off the id convention to define it yourself`);
      table.pk = { name: constraintName(op.name, [], "pkey"), columns: ["id"] };
    }
    const built = [];
    if (op.conventions.id) built.push({ name: "id", type: { base: "bigint" }, nullable: false, default: null, identity: "always", generated: false, comment: null });
    table.columns = built;
    for (const spec of op.columns) {
      const { column, extra } = buildColumn(d, table, spec, ctx);
      table.columns.push(column);
      if (extra.fk) table.fks.push(extra.fk);
      if (extra.unique) table.uniques.push(extra.unique);
      if (extra.check) table.checks.push(extra.check);
    }
    if (op.conventions.timestamps) {
      for (const name of ["created_at", "updated_at"]) {
        if (!table.columns.some((c) => c.name === name)) table.columns.push({ name, type: { base: "timestamptz" }, nullable: false, default: { kind: "now" }, identity: null, generated: false, comment: null });
      }
    }
    if (!op.conventions.id && op.pk?.length) {
      for (const c of op.pk) getColumn(table, c).nullable = false;
      table.pk = { name: constraintName(op.name, [], "pkey"), columns: [...op.pk] };
    }
    if (!table.columns.length) throw new OpError("A table needs at least one column");
    d.tables[idOf(table)] = table;

    const lines = table.columns.map((c) => "  " + columnSql(d, c, ctx));
    if (table.pk) lines.push(`  CONSTRAINT ${quoteIdent(table.pk.name)} PRIMARY KEY (${cols(table.pk.columns)})`);
    for (const u of table.uniques) lines.push(`  CONSTRAINT ${quoteIdent(u.name)} UNIQUE (${cols(u.columns)})`);
    for (const k of table.checks) lines.push("  " + checkSql(k));
    for (const f of table.fks) lines.push("  " + fkSql(d, f));
    out.push({ sql: `CREATE TABLE ${tableSql(table)} (\n${lines.join(",\n")}\n);`, level: "safe" });
    if (op.conventions.fkIndex) {
      for (const f of [...table.fks]) if (!indexCovers(table, f.columns)) addIndex(d, table, f.columns, false, out, "fk");
    }
    if (table.comment) out.push({ sql: `COMMENT ON TABLE ${tableSql(table)} IS ${quoteLiteral(table.comment)};`, level: "safe" });
    if (!table.pk) ctx.notes.push(`${table.name} has no primary key, so its rows cannot be told apart or referenced.`);
    return [{ kind: "drop_table", table: idOf(table) }];
  },

  rename_table(d, op, out, ctx) {
    const t = getTable(d, op.table);
    checkNewIdent(op.name, "table name");
    if (relationNames(d, t.schema).has(op.name)) throw new OpError(`${t.schema} already has something named ${op.name}`);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} RENAME TO ${quoteIdent(op.name)};`, level: "caution", reason: "Anything that queries the old name stops working" });
    const oldName = t.name, newId = `${t.schema}.${op.name}`;
    delete d.tables[op.table];
    t.name = op.name;
    d.tables[newId] = t;
    for (const other of Object.values(d.tables)) for (const f of other.fks) if (f.refTable === op.table) f.refTable = newId;
    for (const v of Object.values(d.views ?? {})) { if (v.reads?.[op.table]) { v.reads[newId] = v.reads[op.table]; delete v.reads[op.table]; } if (v.spec?.table === op.table) v.spec.table = newId; }
    ctx.renames[newId] = ctx.renames[op.table] ?? op.table;
    delete ctx.renames[op.table];
    return [{ kind: "rename_table", table: newId, name: oldName }];
  },

  drop_table(d, op, out) {
    const t = getTable(d, op.table);
    const readers = Object.values(d.views ?? {}).filter((v) => Object.hasOwn(v.reads ?? {}, op.table));
    if (readers.length) throw new OpError(`The view${readers.length === 1 ? "" : "s"} ${readers.map((v) => v.name).join(", ")} read${readers.length === 1 ? "s" : ""} ${t.name}. Drop ${readers.length === 1 ? "it" : "them"} first`);
    const users = Object.values(d.tables).filter((o) => o !== t && o.fks.some((f) => f.refTable === op.table));
    if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} still reference${users.length === 1 ? "s" : ""} ${t.name}. Remove that relation, or drop ${users.length === 1 ? "that table" : "those tables"} first`);
    delete d.tables[op.table];
    out.push({ sql: `DROP TABLE ${tableSql(t)};`, level: "destructive", reason: `Deletes ${t.name} and every row in it` });
    return null;
  },

  set_comment(d, op, out) {
    const t = getTable(d, op.table);
    const target = op.column ? getColumn(t, op.column) : t;
    const previous = target.comment ?? "";
    target.comment = op.comment || null;
    const on = op.column ? `COLUMN ${tableSql(t)}.${quoteIdent(op.column)}` : `TABLE ${tableSql(t)}`;
    out.push({ sql: `COMMENT ON ${on} IS ${op.comment ? quoteLiteral(op.comment) : "NULL"};`, level: "safe" });
    return [{ kind: "set_comment", table: op.table, column: op.column, comment: previous }];
  },

  add_column(d, op, out, ctx) {
    const t = getTable(d, op.table);
    const { column, extra } = buildColumn(d, t, op.column, ctx);
    t.columns.push(column);
    const parts = [`ADD COLUMN ${columnSql(d, column, ctx)}`];
    if (extra.unique) { t.uniques.push(extra.unique); parts.push(`ADD CONSTRAINT ${quoteIdent(extra.unique.name)} UNIQUE (${cols(extra.unique.columns)})`); }
    if (extra.check) { t.checks.push(extra.check); parts.push("ADD " + checkSql(extra.check)); }
    if (extra.fk) { t.fks.push(extra.fk); parts.push("ADD " + fkSql(d, extra.fk)); }
    const needsValue = !column.nullable && !column.default && t.estRows !== 0;
    out.push({
      sql: `ALTER TABLE ${tableSql(t)}\n  ${parts.join(",\n  ")};`, level: needsValue ? "caution" : "safe",
      reason: needsValue ? `${t.name} may already hold rows, and a required column with no default cannot be filled in for them` : undefined,
    });
    if (extra.fk && op.index && !indexCovers(t, [column.name])) addIndex(d, t, [column.name], false, out, "fk");
    return [{ kind: "drop_column", table: op.table, column: column.name }];
  },

  add_generated_column(d, op, out) {
    const t = getTable(d, op.table);
    checkNewIdent(op.name, "column name");
    if (t.columns.some((c) => c.name === op.name)) throw new OpError(`${t.name} already has a column "${op.name}"`);
    if (d.versionNum < 120000) throw new OpError("Calculated columns need Postgres 12 or newer");
    const { sql: expression, type, reads } = generatedExpression(d, t, op);
    t.columns.push({ name: op.name, type, nullable: true, default: null, identity: null, generated: true, generatedAs: { template: op.template, columns: reads }, comment: null });
    const big = t.estRows > BIG_TABLE;
    out.push({
      sql: `ALTER TABLE ${tableSql(t)} ADD COLUMN ${quoteIdent(op.name)} ${typeSql(type, enumSql(d))} GENERATED ALWAYS AS (${expression}) STORED;`,
      level: big ? "caution" : "safe",
      reason: big ? `Every row of ${t.name} is rewritten to fill it in; writes wait until that finishes` : "Postgres keeps it up to date; it cannot be written to directly",
    });
    return [{ kind: "drop_column", table: op.table, column: op.name }];
  },

  drop_column(d, op, out) {
    const t = getTable(d, op.table);
    getColumn(t, op.column);
    if (t.pk?.columns.includes(op.column)) throw new OpError(`"${op.column}" is part of ${t.name}'s primary key`);
    const users = Object.values(d.tables).filter((o) => o.fks.some((f) => f.refTable === op.table && f.refColumns.includes(op.column)));
    if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} reference${users.length === 1 ? "s" : ""} ${t.name}.${op.column}`);
    const showing = Object.values(d.views ?? {}).filter((v) => v.reads?.[op.table]?.includes(op.column));
    if (showing.length) throw new OpError(`The view${showing.length === 1 ? "" : "s"} ${showing.map((v) => v.name).join(", ")} show${showing.length === 1 ? "s" : ""} ${t.name}.${op.column}. Drop ${showing.length === 1 ? "it" : "them"} first`);
    const computed = t.columns.filter((c) => c.generatedAs?.columns.includes(op.column));
    if (computed.length) throw new OpError(`${computed.map((c) => c.name).join(", ")} ${computed.length === 1 ? "is" : "are"} calculated from ${op.column}. Drop ${computed.length === 1 ? "that column" : "those"} first`);
    if (t.columns.length === 1) throw new OpError(`"${op.column}" is ${t.name}'s only column. Drop the table instead`);
    const uses = (k) => (k.columns ?? [k.column]).includes(op.column);
    t.columns = t.columns.filter((c) => c.name !== op.column);
    for (const key of ["fks", "uniques", "indexes"]) t[key] = t[key].filter((k) => !uses(k));
    t.checks = t.checks.filter((k) => k.column !== op.column && !(k.definition ?? "").includes(op.column));
    out.push({ sql: `ALTER TABLE ${tableSql(t)} DROP COLUMN ${quoteIdent(op.column)};`, level: "destructive", reason: `Deletes everything stored in ${t.name}.${op.column}` });
    return null;
  },

  rename_column(d, op, out) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    checkNewIdent(op.name, "column name");
    if (t.columns.some((o) => o.name === op.name)) throw new OpError(`${t.name} already has a column "${op.name}"`);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} RENAME COLUMN ${quoteIdent(op.column)} TO ${quoteIdent(op.name)};`, level: "caution", reason: "Anything that queries the old name stops working" });
    const swap = (list) => list.map((n) => (n === op.column ? op.name : n));
    c.name = op.name;
    for (const k of [t.pk, ...t.fks, ...t.uniques, ...t.indexes]) if (k) k.columns = swap(k.columns);
    for (const k of t.checks) if (k.column === op.column) k.column = op.name;
    for (const g of t.columns) if (g.generatedAs) g.generatedAs.columns = swap(g.generatedAs.columns);
    for (const o of Object.values(d.tables)) for (const f of o.fks) if (f.refTable === op.table) f.refColumns = swap(f.refColumns);
    return [{ kind: "rename_column", table: op.table, column: op.name, name: op.column }];
  },

  alter_column_type(d, op, out) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    const sql = typeSql(op.type, enumSql(d));
    if (sameType(c.type, op.type)) throw new OpError(`${t.name}.${c.name} is already ${typeLabel(c.type)}`);
    const linked = t.fks.some((f) => f.columns.includes(c.name)) || Object.values(d.tables).some((o) => o.fks.some((f) => f.refTable === op.table && f.refColumns.includes(c.name)));
    if (linked) throw new OpError(`${t.name}.${c.name} is part of a foreign key. Both sides must keep the same type`);
    const viewing = Object.values(d.views ?? {}).filter((v) => v.reads?.[op.table]?.includes(c.name));
    if (viewing.length) throw new OpError(`The view ${viewing[0].name} shows ${t.name}.${c.name}, and Postgres will not retype a column a view uses. Drop the view first`);
    if (t.columns.some((g) => g.generatedAs?.columns.includes(c.name))) throw new OpError(`${t.columns.find((g) => g.generatedAs?.columns.includes(c.name)).name} is calculated from ${c.name}. Drop that column first`);
    if (c.identity && !["smallint", "integer", "bigint"].includes(op.type.base)) throw new OpError("An identity column must stay a whole-number type");
    const safe = isSafeWidening(c.type, op.type);
    const previous = c.type;
    c.type = op.type;
    out.push({
      sql: `ALTER TABLE ${tableSql(t)} ALTER COLUMN ${quoteIdent(c.name)} TYPE ${sql} USING ${quoteIdent(c.name)}::${sql};`,
      level: safe ? "caution" : "destructive",
      reason: safe ? `Rewrites ${t.name}; writes wait until it finishes` : `Converting ${typeLabel(previous)} to ${typeLabel(op.type)} can lose or reject existing values`,
    });
    return previous.raw ? null : [{ kind: "alter_column_type", table: op.table, column: c.name, type: previous }];
  },

  set_not_null(d, op, out) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    if (!c.nullable) throw new OpError(`${t.name}.${c.name} is already required`);
    c.nullable = false;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ALTER COLUMN ${quoteIdent(c.name)} SET NOT NULL;`, ...guard(t, "Fails if any existing row has no value here") });
    return [{ kind: "drop_not_null", table: op.table, column: c.name }];
  },

  drop_not_null(d, op, out) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    if (c.nullable) throw new OpError(`${t.name}.${c.name} is already optional`);
    if (t.pk?.columns.includes(c.name)) throw new OpError("A primary key column is always required");
    c.nullable = true;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ALTER COLUMN ${quoteIdent(c.name)} DROP NOT NULL;`, level: "safe" });
    return [{ kind: "set_not_null", table: op.table, column: c.name }];
  },

  set_default(d, op, out, ctx) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    if (c.identity || c.generated) throw new OpError(`${c.name} is generated by Postgres and cannot take a default`);
    const previous = c.default;
    c.default = op.default;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${defaultSql(d, c, ctx)};`, level: "safe" });
    if (previous?.raw) return null;
    return [previous ? { kind: "set_default", table: op.table, column: c.name, default: previous } : { kind: "drop_default", table: op.table, column: c.name }];
  },

  drop_default(d, op, out) {
    const t = getTable(d, op.table);
    const c = getColumn(t, op.column);
    if (!c.default) throw new OpError(`${t.name}.${c.name} has no default`);
    const previous = c.default;
    c.default = null;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ALTER COLUMN ${quoteIdent(c.name)} DROP DEFAULT;`, level: "safe" });
    return previous.raw ? null : [{ kind: "set_default", table: op.table, column: c.name, default: previous }];
  },

  add_pk(d, op, out) {
    const t = getTable(d, op.table);
    if (t.pk) throw new OpError(`${t.name} already has a primary key`);
    if (!op.columns.length) throw new OpError("A primary key needs at least one column");
    for (const c of op.columns) getColumn(t, c).nullable = false;
    t.pk = { name: constraintName(t.name, [], "pkey"), columns: [...op.columns] };
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ADD CONSTRAINT ${quoteIdent(t.pk.name)} PRIMARY KEY (${cols(op.columns)});`, ...guard(t, "Fails if existing rows hold duplicates or empty values") });
    return [{ kind: "drop_constraint", table: op.table, name: t.pk.name }];
  },

  add_fk(d, op, out) {
    const t = getTable(d, op.table);
    const target = getTable(d, op.refTable);
    const refColumns = op.refColumns ?? target.pk?.columns;
    if (!refColumns?.length) throw new OpError(`${target.name} has no primary key to reference`);
    if (!op.columns.length || op.columns.length !== refColumns.length) throw new OpError("A foreign key needs the same number of columns on both sides");
    if (!referenceable(target, refColumns)) throw new OpError(`${target.name} (${refColumns.join(", ")}) is not a primary key or unique, so it cannot be referenced`);
    checkFkTypes(t, op.columns, target, refColumns);
    if (op.onDelete === "set_null" && op.columns.some((c) => !getColumn(t, c).nullable)) throw new OpError("SET NULL needs the referencing column to be optional");
    const name = constraintName(t.name, op.columns, "fkey");
    if (constraintNames(t).has(name)) throw new OpError(`${t.name} already has that relation`);
    const fk = { name, columns: [...op.columns], refTable: op.refTable, refColumns: [...refColumns], onDelete: op.onDelete, onUpdate: "no_action" };
    t.fks.push(fk);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ADD ${fkSql(d, fk)};`, ...guard(t, `Fails if a row in ${t.name} points at a ${target.name} that does not exist`) });
    const inverse = [{ kind: "drop_constraint", table: op.table, name }];
    if (op.index && !indexCovers(t, op.columns)) inverse.unshift({ kind: "drop_index", table: op.table, name: addIndex(d, t, op.columns, false, out, "fk") });
    return inverse;
  },

  set_fk_action(d, op, out) {
    const t = getTable(d, op.table);
    const fk = t.fks.find((f) => f.name === op.name);
    if (!fk) throw new OpError(`${t.name} has no link named "${String(op.name).slice(0, 60)}"`);
    const parent = getTable(d, fk.refTable);
    if (fk.onDelete === op.onDelete) throw new OpError(`Deleting a ${parent.name} row already ${op.onDelete === "cascade" ? "deletes" : op.onDelete === "set_null" ? "clears the link on" : "is blocked by"} its ${t.name}`);
    if (op.onDelete === "set_null" && fk.columns.some((c) => !getColumn(t, c).nullable)) throw new OpError(`${t.name}.${fk.columns.join(", ")} is required, so the link cannot be cleared. Make it optional first`);
    const previous = fk.onDelete;
    fk.onDelete = op.onDelete;
    const effect = { cascade: `Deleting a ${parent.name} row will now delete its ${t.name} rows too`, set_null: `Deleting a ${parent.name} row will now keep its ${t.name} rows and clear their link`, restrict: `A ${parent.name} row can no longer be deleted while ${t.name} rows point at it`, no_action: `A ${parent.name} row can no longer be deleted while ${t.name} rows point at it` }[op.onDelete];
    out.push({
      sql: `ALTER TABLE ${tableSql(t)}\n  DROP CONSTRAINT ${quoteIdent(fk.name)},\n  ADD ${fkSql(d, fk)};`,
      level: t.estRows === 0 && op.onDelete !== "cascade" ? "safe" : "caution", reason: `${effect}. The link is re-checked against existing rows`,
    });
    return ["restrict", "cascade", "set_null", "no_action"].includes(previous) ? [{ kind: "set_fk_action", table: op.table, name: op.name, onDelete: previous }] : null;
  },

  add_unique(d, op, out) {
    const t = getTable(d, op.table);
    if (!op.columns.length) throw new OpError("Pick at least one column");
    op.columns.forEach((c) => getColumn(t, c));
    const name = constraintName(t.name, op.columns, "key");
    if (constraintNames(t).has(name) || relationNames(d, t.schema).has(name)) throw new OpError(`${t.name} (${op.columns.join(", ")}) is already unique`);
    t.uniques.push({ name, columns: [...op.columns] });
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ADD CONSTRAINT ${quoteIdent(name)} UNIQUE (${cols(op.columns)});`, ...guard(t, "Fails if existing rows hold duplicates") });
    return [{ kind: "drop_constraint", table: op.table, name }];
  },

  add_check(d, op, out) {
    const t = getTable(d, op.table);
    getColumn(t, op.column);
    if (!op.template) throw new OpError("That rule is not one Creator can add");
    const k = { name: constraintName(t.name, [op.column], "check"), template: op.template, column: op.column };
    if (constraintNames(t).has(k.name)) throw new OpError(`${t.name}.${op.column} already has a rule`);
    t.checks.push(k);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ADD ${checkSql(k)};`, ...guard(t, "Fails if an existing row breaks the rule") });
    return [{ kind: "drop_constraint", table: op.table, name: k.name }];
  },

  drop_constraint(d, op, out) {
    const t = getTable(d, op.table);
    if (!constraintNames(t).has(op.name)) throw new OpError(`${t.name} has no constraint "${String(op.name).slice(0, 60)}"`);
    if (t.pk?.name === op.name) {
      const users = Object.values(d.tables).filter((o) => o.fks.some((f) => f.refTable === op.table));
      if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} reference${users.length === 1 ? "s" : ""} this primary key`);
      t.pk = null;
    }
    const unique = t.uniques.find((k) => k.name === op.name), fk = t.fks.find((k) => k.name === op.name), check = t.checks.find((k) => k.name === op.name);
    const users = unique ? Object.values(d.tables).filter((o) => o.fks.some((f) => f.refTable === op.table && f.refColumns.join() === unique.columns.join())) : [];
    if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} reference${users.length === 1 ? "s" : ""} these columns through this rule`);
    for (const key of ["fks", "uniques", "checks"]) t[key] = t[key].filter((k) => k.name !== op.name);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} DROP CONSTRAINT ${quoteIdent(op.name)};`, level: "caution", reason: unique ? `${t.name} may then repeat the same ${unique.columns.join(" + ")}` : "The rule stops being enforced" });
    // Undo re-creates the rule under Create's naming, so it is only offered where that gives the same name back.
    const again = unique ? { kind: "add_unique", table: op.table, columns: unique.columns, name: constraintName(t.name, unique.columns, "key") }
      : fk ? { kind: "add_fk", table: op.table, columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns, onDelete: fk.onDelete, index: false, name: constraintName(t.name, fk.columns, "fkey") }
      : check?.template ? { kind: "add_check", table: op.table, column: check.column, template: check.template, name: constraintName(t.name, [check.column], "check") } : null;
    if (!again || again.name !== op.name || !["restrict", "cascade", "set_null", "no_action", undefined].includes(again.onDelete)) return null;
    delete again.name;
    return [again];
  },

  add_index(d, op, out) {
    const t = getTable(d, op.table);
    if (!op.columns.length) throw new OpError("Pick at least one column");
    op.columns.forEach((c) => getColumn(t, c));
    if (!op.unique && indexCovers(t, op.columns)) throw new OpError(`${t.name} (${op.columns.join(", ")}) is already covered by an index`);
    return [{ kind: "drop_index", table: op.table, name: addIndex(d, t, op.columns, op.unique, out, t.estRows === 0 ? "new" : "") }];
  },

  drop_index(d, op, out) {
    const t = getTable(d, op.table);
    const i = t.indexes.find((x) => x.name === op.name);
    if (!i) throw new OpError(`${t.name} has no index "${String(op.name).slice(0, 60)}"`);
    t.indexes = t.indexes.filter((x) => x !== i);
    out.push({ sql: `DROP INDEX ${qualified(t.schema, i.name)};`, level: "caution", reason: "Queries that relied on it get slower" });
    return i.definition && !i.columns.length ? null : [{ kind: "add_index", table: op.table, columns: i.columns, unique: i.unique }];
  },

  create_view(d, op, out) {
    d.views ??= {};
    const t = getTable(d, op.table);
    const schema = op.schema ?? t.schema;
    checkNewIdent(op.name, "view name");
    if (!d.schemas.includes(schema)) throw new OpError(`Schema ${schema} does not exist`);
    if (relationNames(d, schema).has(op.name)) throw new OpError(`${schema} already has something named ${op.name}`);
    if (!op.flags.length && !op.filter) throw new OpError("A view needs a yes/no column or a test that picks its rows");
    const taken = new Set(t.columns.map((c) => c.name));
    const extra = op.flags.map((f) => {
      checkNewIdent(f.name, "column name");
      if (taken.has(f.name)) throw new OpError(`${t.name} already has a column "${f.name}"`);
      taken.add(f.name);
      return `  (${conditionSql(d, t, f.condition, { clock: true }).sql}) AS ${quoteIdent(f.name)}`;
    });
    const where = op.filter ? `\nWHERE ${conditionSql(d, t, op.filter, { clock: true }).sql}` : "";
    const id = `${schema}.${op.name}`;
    // The view lists every column of its table, so every one of them is something it depends on.
    d.views[id] = { schema, name: op.name, spec: { table: op.table, flags: op.flags, filter: op.filter ?? null }, reads: { [op.table]: t.columns.map((c) => c.name) } };
    out.push({
      sql: `CREATE VIEW ${qualified(schema, op.name)} AS\nSELECT\n${[...t.columns.map((c) => `  ${quoteIdent(c.name)}`), ...extra].join(",\n")}\nFROM ${tableSql(t)}${where};`,
      level: "safe", reason: "Worked out each time it is read, so it is always current. It stores nothing",
    });
    return [{ kind: "drop_view", view: id }];
  },

  drop_view(d, op, out) {
    const v = Object.hasOwn(d.views ?? {}, op.view ?? "") ? d.views[op.view] : null;
    if (!v) throw new OpError(`The view ${String(op.view).slice(0, 80)} does not exist at this point in the draft`);
    delete d.views[op.view];
    out.push({ sql: `DROP VIEW ${qualified(v.schema, v.name)};`, level: "caution", reason: "Anything that queries the view stops working. No data is lost" });
    return v.spec ? [{ kind: "create_view", schema: v.schema, name: v.name, table: v.spec.table, flags: v.spec.flags, filter: v.spec.filter ?? undefined }] : null;
  },

  create_enum(d, op, out) {
    checkNewIdent(op.name, "type name");
    if (!d.schemas.includes(op.schema)) throw new OpError(`Schema ${op.schema} does not exist`);
    const id = `${op.schema}.${op.name}`;
    if (Object.hasOwn(d.enums, id) || relationNames(d, op.schema).has(op.name)) throw new OpError(`${op.schema} already has something named ${op.name}`);
    const values = [...new Set(op.values.filter(Boolean))];
    if (values.length < 1) throw new OpError("An enum needs at least one value");
    d.enums[id] = { schema: op.schema, name: op.name, values };
    out.push({ sql: `CREATE TYPE ${qualified(op.schema, op.name)} AS ENUM (${values.map(quoteLiteral).join(", ")});`, level: "safe" });
    return [{ kind: "drop_enum", enum: id }];
  },

  add_enum_value(d, op, out, ctx) {
    const e = Object.hasOwn(d.enums, op.enum ?? "") ? d.enums[op.enum] : null;
    if (!e) throw new OpError(`The enum ${String(op.enum).slice(0, 80)} does not exist`);
    if (!op.value) throw new OpError("A value is required");
    if (e.values.includes(op.value)) throw new OpError(`${e.name} already has "${op.value}"`);
    if (d.versionNum < 120000 && !ctx.newEnums.has(op.enum)) throw new OpError("Adding an enum value inside a transaction needs Postgres 12 or newer");
    e.values.push(op.value);
    ctx.newLabels.add(`${op.enum}\0${op.value}`);
    out.push({ sql: `ALTER TYPE ${qualified(e.schema, e.name)} ADD VALUE ${quoteLiteral(op.value)};`, level: "caution", reason: "An enum value cannot be removed again" });
    return null;
  },

  drop_enum(d, op, out) {
    const e = Object.hasOwn(d.enums, op.enum ?? "") ? d.enums[op.enum] : null;
    if (!e) throw new OpError(`The enum ${String(op.enum).slice(0, 80)} does not exist`);
    const users = Object.values(d.tables).filter((t) => t.columns.some((c) => c.type.enum === op.enum));
    if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} still use${users.length === 1 ? "s" : ""} ${e.name}`);
    delete d.enums[op.enum];
    out.push({ sql: `DROP TYPE ${qualified(e.schema, e.name)};`, level: "destructive", reason: `Deletes the type ${e.name}` });
    return [{ kind: "create_enum", schema: e.schema, name: e.name, values: e.values }];
  },

  create_role(d, op, out) {
    checkNewIdent(op.name, "role name");
    if (Object.hasOwn(d.roles, op.name)) throw new OpError(`Role ${op.name} already exists`);
    d.roles[op.name] = { login: false };
    out.push({ sql: `CREATE ROLE ${quoteIdent(op.name)} NOLOGIN;`, level: "safe", reason: "Created without login. Give it a password in the SQL editor, or grant it to a login role" });
    return [{ kind: "drop_role", name: op.name }];
  },

  drop_role(d, op, out) {
    needRole(d, op.name);
    delete d.roles[op.name];
    for (const t of Object.values(d.tables)) t.grants = t.grants.filter((g) => g.role !== op.name);
    // Postgres will not drop a role that still holds a privilege, and a grant made here also gave it USAGE on the schema.
    // Revoke what it holds in this database, schema by schema. (Not DROP OWNED: that would also delete anything it owns.)
    for (const schema of d.schemas) {
      out.push({ sql: `REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} FROM ${quoteIdent(op.name)};`, level: "caution", reason: `${op.name} loses its access in ${schema}` });
      out.push({ sql: `REVOKE ALL ON SCHEMA ${quoteIdent(schema)} FROM ${quoteIdent(op.name)};`, level: "caution" });
    }
    out.push({ sql: `DROP ROLE ${quoteIdent(op.name)};`, level: "caution", reason: "Fails if the role still owns objects, or holds privileges in another database" });
    return null;
  },

  grant(d, op, out) {
    needRole(d, op.role);
    if (!op.privileges.length) throw new OpError("Pick at least one privilege");
    const target = grantTargets(d, op);
    const privileges = PRIVILEGES.filter((p) => op.privileges.includes(p));
    for (const t of target.tables) {
      const g = t.grants.find((x) => x.role === op.role) ?? t.grants[t.grants.push({ role: op.role, privileges: [] }) - 1];
      g.privileges = [...new Set([...g.privileges, ...privileges])].sort();
    }
    out.push({ sql: `GRANT USAGE ON SCHEMA ${quoteIdent(target.schema)} TO ${quoteIdent(op.role)};`, level: "safe", reason: "Without USAGE on the schema, table privileges have no effect" });
    out.push({ sql: `GRANT ${privileges.join(", ")} ON ${target.on} TO ${quoteIdent(op.role)};`, level: "safe", reason: op.allIn ? "Covers the tables that exist now, not ones created later" : undefined });
    return [{ kind: "revoke", role: op.role, privileges, table: op.table, allIn: op.allIn }];
  },

  revoke(d, op, out) {
    needRole(d, op.role);
    if (!op.privileges.length) throw new OpError("Pick at least one privilege");
    const target = grantTargets(d, op);
    const privileges = PRIVILEGES.filter((p) => op.privileges.includes(p));
    for (const t of target.tables) {
      for (const g of t.grants) if (g.role === op.role) g.privileges = g.privileges.filter((p) => !privileges.includes(p));
      t.grants = t.grants.filter((g) => g.privileges.length);
    }
    out.push({ sql: `REVOKE ${privileges.join(", ")} ON ${target.on} FROM ${quoteIdent(op.role)};`, level: "caution", reason: `${op.role} loses that access immediately` });
    return [{ kind: "grant", role: op.role, privileges, table: op.table, allIn: op.allIn }];
  },

  enable_rls(d, op, out, ctx) {
    const t = getTable(d, op.table);
    if (t.rls) throw new OpError(`Row-level security is already on for ${t.name}`);
    t.rls = true;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} ENABLE ROW LEVEL SECURITY;`, level: "caution", reason: "Until a policy allows them, everyone except the table owner sees no rows" });
    if (!t.policies.length) ctx.notes.push(`${t.name} has row-level security on but no policy yet, so only its owner can read it.`);
    return [{ kind: "disable_rls", table: op.table }];
  },

  disable_rls(d, op, out) {
    const t = getTable(d, op.table);
    if (!t.rls) throw new OpError(`Row-level security is already off for ${t.name}`);
    t.rls = false;
    out.push({ sql: `ALTER TABLE ${tableSql(t)} DISABLE ROW LEVEL SECURITY;`, level: "caution", reason: "Every role with access sees every row again" });
    return [{ kind: "enable_rls", table: op.table }];
  },

  create_policy(d, op, out) {
    const t = getTable(d, op.table);
    if (!op.template) throw new OpError("That kind of policy is not one Creator can write");
    const name = op.name ?? constraintName(t.name, [op.template], "policy");
    checkNewIdent(name, "policy name");
    if (t.policies.some((p) => p.name === name)) throw new OpError(`${t.name} already has a policy named ${name}`);
    if (op.role) needRole(d, op.role);
    let command = op.command, expr;
    if (op.template === "read_all") { command = "select"; expr = "true"; }
    else {
      const c = getColumn(t, op.column);
      if (op.template === "owner_column") {
        if (!["text", "varchar"].includes(c.type.base)) throw new OpError(`${c.name} must be a text column holding a role name`);
        expr = `${quoteIdent(c.name)} = current_user`;
      } else {
        const setting = op.setting ?? "app.tenant_id";
        if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(setting)) throw new OpError("The setting name must look like app.tenant_id");
        expr = `${quoteIdent(c.name)} = current_setting(${quoteLiteral(setting)})::${typeSql(c.type, enumSql(d))}`;
      }
    }
    const inverse = [{ kind: "drop_policy", table: op.table, name }];
    if (!t.rls) {
      t.rls = true;
      out.push({ sql: `ALTER TABLE ${tableSql(t)} ENABLE ROW LEVEL SECURITY;`, level: "caution", reason: "A policy only takes effect once row-level security is on" });
      inverse.push({ kind: "disable_rls", table: op.table });
    }
    const using = command !== "insert", check = command === "insert" || command === "update" || command === "all";
    t.policies.push({ name, command, roles: [op.role ?? "public"], template: op.template, using: using ? expr : null, check: check && op.template !== "read_all" ? expr : null });
    out.push({
      sql: `CREATE POLICY ${quoteIdent(name)} ON ${tableSql(t)}\n  FOR ${POLICY_COMMANDS[command]} TO ${op.role ? quoteIdent(op.role) : "PUBLIC"}` +
        (using ? `\n  USING (${expr})` : "") + (check && op.template !== "read_all" ? `\n  WITH CHECK (${expr})` : "") + ";",
      level: "safe", reason: "Table owners and superusers bypass policies",
    });
    return inverse;
  },

  drop_policy(d, op, out) {
    const t = getTable(d, op.table);
    if (!t.policies.some((p) => p.name === op.name)) throw new OpError(`${t.name} has no policy "${String(op.name).slice(0, 60)}"`);
    t.policies = t.policies.filter((p) => p.name !== op.name);
    out.push({ sql: `DROP POLICY ${quoteIdent(op.name)} ON ${tableSql(t)};`, level: "caution", reason: "Rows this policy allowed are no longer visible" });
    return null;
  },

  // ---- rows. `count` is a read-only query the server runs for the preview, so the draft can say how many rows are affected.
  delete_rows(d, op, out) {
    const t = getTable(d, op.table);
    if (!op.filter) throw new OpError(`Deleting every row is "empty the ${t.name} table". A delete needs a test that picks the rows`);
    const where = conditionSql(d, t, op.filter, { clock: true }).sql;
    out.push({ sql: `DELETE FROM ${tableSql(t)} WHERE ${where};`, count: `SELECT count(*) FROM ${tableSql(t)} WHERE ${where}`, level: "destructive", reason: `Deletes the matching ${rowsWord(t)}. Rows in other tables that must point at them will block it` });
    return null;
  },

  truncate_tables(d, op, out) {
    if (!op.tables.length) throw new OpError("Name the table to empty");
    const wanted = new Set(op.tables.map((id) => { getTable(d, id); return id; }));
    // Postgres will not empty a table that others point at unless they are emptied with it. Work out which those are, and name them.
    const all = new Set(wanted);
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, o] of Object.entries(d.tables)) if (!all.has(id) && o.fks.some((f) => all.has(f.refTable))) { all.add(id); grew = true; }
    }
    const extra = [...all].filter((id) => !wanted.has(id));
    if (extra.length && !op.withDependents) throw new OpError(`${extra.map((id) => d.tables[id].name).join(", ")} point${extra.length === 1 ? "s" : ""} at ${[...wanted].map((id) => d.tables[id].name).join(", ")}, so ${extra.length === 1 ? "it has" : "they have"} to be emptied too. Say "and everything that points at it" to include ${extra.length === 1 ? "it" : "them"}`);
    const list = [...all].map((id) => d.tables[id]);
    out.push({
      sql: `TRUNCATE TABLE ${list.map(tableSql).join(", ")}${op.restartIdentity ? " RESTART IDENTITY" : ""};`,
      count: `SELECT ${list.map((t) => `(SELECT count(*) FROM ${tableSql(t)})`).join(" + ")}`,
      level: "destructive", reason: `Deletes every row of ${list.map((t) => t.name).join(", ")}${extra.length ? ` (${extra.map((id) => d.tables[id].name).join(", ")} because ${extra.length === 1 ? "it points" : "they point"} at the rest)` : ""}. The tables themselves stay`,
    });
    return null;
  },

  update_rows(d, op, out) {
    const t = getTable(d, op.table);
    const value = valueSql(d, t, op.set.column, op.set.value);
    const where = op.filter ? conditionSql(d, t, op.filter, { clock: true }).sql : null;
    out.push({
      sql: `UPDATE ${tableSql(t)} SET ${quoteIdent(op.set.column)} = ${value}${where ? ` WHERE ${where}` : ""};`,
      count: `SELECT count(*) FROM ${tableSql(t)}${where ? ` WHERE ${where}` : ""}`,
      level: "destructive", reason: `Overwrites ${op.set.column} in ${where ? "the matching" : "every one of the"} ${rowsWord(t)}. The old values are not kept`,
    });
    return null;
  },

  insert_row(d, op, out) {
    const t = getTable(d, op.table);
    if (!op.values.length) throw new OpError("A new row needs at least one value");
    const given = new Set();
    const pairs = op.values.map((x) => { if (given.has(x.column)) throw new OpError(`${x.column} is given twice`); given.add(x.column); return [quoteIdent(getColumn(t, x.column).name), valueSql(d, t, x.column, x.value)]; });
    const missing = t.columns.filter((c) => !c.nullable && !c.default && !c.identity && !c.generated && !given.has(c.name)).map((c) => c.name);
    if (missing.length) throw new OpError(`A row of ${t.name} also needs ${missing.join(", ")}`);
    out.push({ sql: `INSERT INTO ${tableSql(t)} (${pairs.map((p) => p[0]).join(", ")}) VALUES (${pairs.map((p) => p[1]).join(", ")});`, level: "safe", reason: "Adds one row" });
    return null;
  },

  seed(d, op, out) {
    const ids = op.tables.length ? op.tables : Object.keys(d.tables);
    if (!ids.length) throw new OpError("There are no tables to fill yet");
    ids.forEach((id) => getTable(d, id));
    out.push({
      sql: `-- sample data: ${op.rows} row${op.rows === 1 ? "" : "s"} each into ${ids.map((id) => d.tables[id].name).join(", ")} (seed ${op.seedValue})`,
      level: "safe", seed: { tables: ids, rows: op.rows, seedValue: op.seedValue },
    });
    return null;
  },
};

const RANK = { safe: 0, caution: 1, destructive: 2 };

/**
 * Replay `ops` over `baseline`.
 * → { draft, ops (the ones that applied), broken, statements, notes, renames, inverse, confirmPhrase, level }
 */
export function compileOps(baseline, ops) {
  let draft = structuredClone(baseline);
  const ctx = { notes: [], renames: {}, newLabels: new Set(), newEnums: new Set() };
  const applied = [], broken = [], statements = [], inverses = [];
  for (const op of ops) {
    const attempt = structuredClone(draft);
    const saved = { notes: ctx.notes.length, renames: { ...ctx.renames } };
    const out = [];
    try {
      if (!Object.hasOwn(STEPS, op.kind)) throw new OpError("Unknown change");
      const inverse = STEPS[op.kind](attempt, op, out, ctx);
      if (op.kind === "create_enum") ctx.newEnums.add(`${op.schema}.${op.name}`);
      draft = attempt;
      applied.push(op);
      inverses.push(inverse);
      for (const s of out) statements.push({ opId: op.id, ...s });
    } catch (err) {
      if (!(err instanceof OpError) && err.status !== 400) throw err;
      ctx.notes.length = saved.notes;
      ctx.renames = saved.renames;
      broken.push({ id: op.id, kind: op.kind, reason: err.message });
    }
  }
  const level = statements.reduce((worst, s) => (RANK[s.level] > RANK[worst] ? s.level : worst), "safe");
  return {
    draft, ops: applied, broken, statements, notes: ctx.notes, renames: ctx.renames, level,
    // Undoing a migration means undoing its ops last-first. One op that cannot be undone makes the whole entry final.
    inverse: inverses.every(Boolean) ? inverses.reverse().flat() : null,
    confirmPhrase: level === "destructive" ? baseline.database : null,
  };
}

export const migrationSql = (statements) => statements.map((s) => s.sql).join("\n\n");
