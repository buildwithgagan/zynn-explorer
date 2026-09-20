import { quoteIdent, qualified, quoteLiteral } from "../db.js";
import { typeSql, typeLabel, sameType, isSafeWidening, CHECKS, ON_DELETE, PRIVILEGES, POLICY_COMMANDS } from "./types.js";
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
    ctx.renames[newId] = ctx.renames[op.table] ?? op.table;
    delete ctx.renames[op.table];
    return [{ kind: "rename_table", table: newId, name: oldName }];
  },

  drop_table(d, op, out) {
    const t = getTable(d, op.table);
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

  drop_column(d, op, out) {
    const t = getTable(d, op.table);
    getColumn(t, op.column);
    if (t.pk?.columns.includes(op.column)) throw new OpError(`"${op.column}" is part of ${t.name}'s primary key`);
    const users = Object.values(d.tables).filter((o) => o.fks.some((f) => f.refTable === op.table && f.refColumns.includes(op.column)));
    if (users.length) throw new OpError(`${users.map((u) => u.name).join(", ")} reference${users.length === 1 ? "s" : ""} ${t.name}.${op.column}`);
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
    for (const key of ["fks", "uniques", "checks"]) t[key] = t[key].filter((k) => k.name !== op.name);
    out.push({ sql: `ALTER TABLE ${tableSql(t)} DROP CONSTRAINT ${quoteIdent(op.name)};`, level: "caution", reason: "The rule stops being enforced" });
    return null;
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
    out.push({ sql: `DROP ROLE ${quoteIdent(op.name)};`, level: "caution", reason: "Fails while the role still owns objects or holds privileges" });
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
