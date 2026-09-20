import { createHash } from "node:crypto";
import { sameType } from "./types.js";

/** A problem with one op. Caught by the compiler, which reports the op as broken instead of failing the draft. */
export class OpError extends Error {}

// Keywords Postgres reserves: usable only when quoted, so Creator never picks them as names.
const RESERVED = new Set(`all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate
collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time
current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full
grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime
localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right
select session_user similar some symmetric table tablesample then to trailing true union unique user using variadic verbose
when where window with`.split(/\s+/));

const PLURALS = { user: "users", order: "orders", group: "groups", table: "tables", column: "columns", check: "checks", grant: "grants" };

export const isReserved = (name) => RESERVED.has(name);

/** A name Creator may give to something new. Existing objects can have any name; they are only ever quoted. */
export function checkNewIdent(name, what = "name") {
  if (typeof name !== "string" || !name) throw new OpError(`A ${what} is required`);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new OpError(`"${name.slice(0, 40)}" is not a valid ${what}: use lowercase letters, digits and underscores`);
  if (Buffer.byteLength(name) > 63) throw new OpError(`The ${what} "${name.slice(0, 20)}…" is longer than Postgres allows (63 bytes)`);
  if (name.startsWith("pg_")) throw new OpError(`Names starting with pg_ are reserved for Postgres`);
  if (RESERVED.has(name)) {
    const hint = PLURALS[name] ? ` Try "${PLURALS[name]}".` : "";
    throw new OpError(`"${name}" is a reserved word in Postgres.${hint}`);
  }
  return name;
}

/** Turn a reserved word into its usual safe plural, when there is one. */
export const safeName = (name) => (RESERVED.has(name) && PLURALS[name]) || name;

/** `<table>_<cols>_<suffix>`, shortened with a hash when it would exceed 63 bytes. */
export function constraintName(table, columns, suffix) {
  const full = [table, ...columns, suffix].join("_");
  if (Buffer.byteLength(full) <= 63) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 63 - suffix.length - 10)}_${hash}_${suffix}`;
}

/** Every relation-level name in a schema: tables and indexes share one namespace. */
export function relationNames(design, schema) {
  const names = new Set();
  for (const v of Object.values(design.views ?? {})) if (v.schema === schema) names.add(v.name);
  for (const t of Object.values(design.tables)) {
    if (t.schema !== schema) continue;
    names.add(t.name);
    for (const i of t.indexes) names.add(i.name);
    for (const k of [t.pk, ...t.uniques]) if (k) names.add(k.name);
  }
  return names;
}

export function constraintNames(table) {
  return new Set([table.pk, ...table.fks, ...table.uniques, ...table.checks].filter(Boolean).map((k) => k.name));
}

export function getTable(design, id) {
  const table = typeof id === "string" && Object.hasOwn(design.tables, id) ? design.tables[id] : null;
  if (!table) throw new OpError(`Table ${String(id).slice(0, 80)} does not exist at this point in the draft`);
  return table;
}

export function getColumn(table, name) {
  const column = table.columns.find((c) => c.name === name);
  if (!column) throw new OpError(`${table.name} has no column "${String(name).slice(0, 60)}"`);
  return column;
}

/** The columns a foreign key may point at: the primary key, or a unique constraint. */
export function referenceable(table, columns) {
  const same = (k) => k && k.columns.length === columns.length && k.columns.every((c, i) => c === columns[i]);
  return same(table.pk) || table.uniques.some(same) || table.indexes.some((i) => i.unique && same(i));
}

export function checkFkTypes(table, columns, refTable, refColumns) {
  columns.forEach((name, i) => {
    const a = getColumn(table, name), b = getColumn(refTable, refColumns[i]);
    if (!sameType(a.type, b.type)) {
      throw new OpError(`${table.name}.${a.name} is ${a.type.raw ?? a.type.base ?? "an enum"} but ${refTable.name}.${b.name} is ${b.type.raw ?? b.type.base ?? "an enum"}: a foreign key needs matching types`);
    }
  });
}
