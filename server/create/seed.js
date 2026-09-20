import { qualified, quoteIdent } from "../db.js";
import { topoTables } from "./design.js";
import { ARCHETYPES, inferArchetype, mulberry32 } from "./archetypes.js";

// Sample rows are generated in code from each column's archetype, so they respect types, enums, the
// check templates Creator knows, uniqueness, and foreign keys (children only ever point at real parents).

export const MAX_ROWS_PER_MIGRATION = 10_000;
const BATCH = 100;
const fail = (message) => Object.assign(new Error(message), { status: 400 });

const singleUniques = (table) => new Set([...table.uniques, ...table.indexes.filter((i) => i.unique)].filter((k) => k.columns.length === 1).map((k) => k.columns[0]));

/** How each column of `table` gets its value: { column, source: fk | enum | gen | sequence }. Columns left to Postgres are omitted. */
export function columnPlan(design, id) {
  const table = design.tables[id];
  const unique = singleUniques(table);
  const plan = [];
  for (const c of table.columns) {
    if (c.identity || c.generated) continue;
    const fk = table.fks.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
    if (table.fks.some((f) => f.columns.length > 1 && f.columns.includes(c.name))) throw fail(`${table.name} has a multi-column foreign key, which sample data cannot fill yet`);
    if (fk) { plan.push({ column: c, source: "fk", fk }); continue; }
    if (["now", "uuid"].includes(c.default?.kind) || c.default?.raw) continue;
    if (c.type.enum) { plan.push({ column: c, source: "enum", values: design.enums[c.type.enum].values }); continue; }
    const isKey = table.pk?.columns.includes(c.name);
    if (isKey && ["smallint", "integer", "bigint"].includes(c.type.base)) { plan.push({ column: c, source: "sequence" }); continue; }
    const archetype = c.archetype && Object.hasOwn(ARCHETYPES, c.archetype) ? c.archetype : inferArchetype(c);
    if (!archetype) {
      if (c.nullable || c.default) continue;
      throw fail(`${table.name}.${c.name} is a required ${c.type.raw ?? c.type.base} column, which sample data cannot fill`);
    }
    plan.push({ column: c, source: "gen", archetype, unique: unique.has(c.name) || isKey, check: table.checks.find((k) => k.column === c.name)?.template });
  }
  return plan;
}

function fit(value, item, i, offset) {
  const { column, check, unique } = item;
  let v = value;
  if (typeof v === "string") {
    if (unique && !v.includes(String(offset + i + 1))) v = `${v}-${offset + i + 1}`;
    if (check === "lowercase") v = v.toLowerCase();
    const max = column.type.base === "varchar" ? column.type.args?.[0] : null;
    if (max && v.length > max) v = unique ? v.slice(0, Math.max(1, max - 6)) + String(offset + i + 1).slice(-5) : v.slice(0, max);
    if (column.type.base === "text[]") v = `{${JSON.stringify(v)}}`;
  } else if (typeof v === "number") {
    if (unique) v = offset + i + 1;
    if (check === "positive") v = Math.max(1, v);
    if (check === "rating") v = Math.min(5, Math.max(1, v));
    if (column.type.base === "smallint") v = Math.min(v, 32_000);
  }
  return v;
}

/**
 * Rows for one table. `parentKeys` maps a referenced table id to the key values that exist for it.
 * → { columns: [name], rows: [[value]] }
 */
export function generateRows(design, id, count, rng, parentKeys, { offset = 0 } = {}) {
  const table = design.tables[id];
  const plan = columnPlan(design, id);
  const fkItems = plan.filter((p) => p.source === "fk");
  for (const p of fkItems) {
    const keys = p.fk.refTable === id ? [] : parentKeys[p.fk.refTable] ?? [];
    p.keys = keys;
    if (!keys.length && !p.column.nullable) throw fail(`${table.name}.${p.column.name} is required but ${design.tables[p.fk.refTable]?.name ?? p.fk.refTable} has no rows to point at`);
  }
  // A join table is unique on its pair of references: walk the pairs instead of drawing them at random.
  const pairKey = [table.pk, ...table.uniques].find((k) => k && k.columns.length > 1 && k.columns.every((c) => fkItems.some((p) => p.column.name === c && p.keys.length)));
  const pairItems = pairKey ? pairKey.columns.map((c) => fkItems.find((p) => p.column.name === c)) : [];
  if (pairKey) count = Math.min(count, pairItems.reduce((n, p) => n * p.keys.length, 1));

  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(plan.map((p) => {
      if (p.source === "sequence") return offset + i + 1;
      if (p.source === "enum") return p.values[Math.floor(rng() * p.values.length)];
      if (p.source === "fk") {
        if (!p.keys.length) return null;
        const at = pairItems.indexOf(p);
        if (at >= 0) {
          const stride = pairItems.slice(0, at).reduce((n, q) => n * q.keys.length, 1);
          return p.keys[Math.floor(i / stride) % p.keys.length];
        }
        const uniqueFk = singleUniques(table).has(p.column.name);
        return uniqueFk ? p.keys[i % p.keys.length] : p.keys[Math.floor(rng() * p.keys.length)];
      }
      return fit(ARCHETYPES[p.archetype].gen(rng, offset + i), p, i, offset);
    }));
  }
  return { columns: plan.map((p) => p.column.name), rows };
}

/** Insert sample rows through `exec` (one statement at a time, inside the migration's transaction). */
export async function run(exec, design, { tables, rows, seedValue }) {
  const { order } = topoTables(design, tables);
  if (order.length * rows > MAX_ROWS_PER_MIGRATION) throw fail(`That is more than ${MAX_ROWS_PER_MIGRATION.toLocaleString("en-US")} sample rows in one go. Ask for fewer rows or fewer tables`);
  const rng = mulberry32(seedValue);
  const keys = {};
  let inserted = 0;
  for (const id of order) {
    const table = design.tables[id];
    const target = qualified(table.schema, table.name);
    for (const fk of table.fks) {
      if (fk.refTable === id || keys[fk.refTable] || fk.refColumns.length !== 1) continue;
      const parent = design.tables[fk.refTable];
      const found = await exec(`select ${quoteIdent(fk.refColumns[0])} from ${qualified(parent.schema, parent.name)} limit 1000`);
      keys[fk.refTable] = found.rows.map((r) => r[0]);
    }
    const offset = Number((await exec(`select count(*) from ${target}`)).rows[0][0]);
    const data = generateRows(design, id, rows, rng, keys, { offset });
    const pk = table.pk?.columns.length === 1 ? table.pk.columns[0] : null;
    keys[id] ??= [];
    for (let at = 0; at < data.rows.length; at += BATCH) {
      const batch = data.rows.slice(at, at + BATCH);
      const width = data.columns.length;
      const values = width
        ? batch.map((_, r) => `(${data.columns.map((_, c) => `$${r * width + c + 1}`).join(", ")})`).join(", ")
        : null;
      const sql = values
        ? `insert into ${target} (${data.columns.map(quoteIdent).join(", ")}) values ${values}`
        : `insert into ${target} select from generate_series(1, ${batch.length})`;
      const result = await exec(sql + (pk ? ` returning ${quoteIdent(pk)}` : ""), batch.flat());
      if (pk) keys[id].push(...result.rows.map((r) => r[0]));
      inserted += batch.length;
    }
  }
  return inserted;
}
