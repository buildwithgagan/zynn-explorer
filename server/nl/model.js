import { query, connectionInfo, quoteIdent } from "../db.js";

const TTL_MS = 5 * 60_000; // invalidated on connect, database switch and writes
const MAX_CATEGORY_VALUES = 25;
let cache = null;

export function invalidateModel() {
  cache = null;
}

function category(typcategory, typtype, typname) {
  if (typtype === "e") return "enum";
  if (typcategory === "N") return "number";
  if (typcategory === "D") return typname === "time" || typname === "timetz" ? "other" : "time";
  if (typcategory === "B") return "boolean";
  if (typcategory === "S") return "text";
  return "other";
}

// pg_stats.most_common_vals is anyarray; its text form is a Postgres array literal.
function parseArrayLiteral(text) {
  if (!text || text[0] !== "{") return [];
  const out = [];
  let i = 1;
  while (i < text.length - 1) {
    let value = "";
    if (text[i] === '"') {
      i++;
      while (text[i] !== '"') {
        if (text[i] === "\\") i++;
        value += text[i++];
      }
      i++;
    } else {
      while (i < text.length - 1 && text[i] !== ",") value += text[i++];
      if (value === "NULL") value = null;
    }
    if (value !== null) out.push(value);
    i++; // comma
  }
  return out;
}

/**
 * The schema as the NL planner sees it: relations, typed columns, known category
 * values and the foreign-key graph. Every identifier that reaches generated SQL
 * is looked up here, so nothing outside the catalog can be referenced.
 */
export async function loadModel() {
  const key = JSON.stringify(connectionInfo());
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.model;

  const [cols, fks] = await Promise.all([
    query(`
      select n.nspname as schema, c.relname as table, c.relkind as kind,
             obj_description(c.oid, 'pg_class') as table_comment,
             c.reltuples::bigint as est_rows, pg_relation_size(c.oid) as bytes,
             a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
             bt.typcategory, bt.typtype, bt.typname,
             col_description(a.attrelid, a.attnum) as comment,
             exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary
                     and a.attnum = any(i.indkey)) as is_pk,
             case when bt.typtype = 'e' then
               (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = bt.oid)
             end as enum_labels,
             s.n_distinct, s.most_common_vals::text as common_vals
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
      join pg_type bt on bt.oid = case when t.typtype = 'd' then t.typbasetype else t.oid end
      left join pg_stats s on s.schemaname = n.nspname and s.tablename = c.relname and s.attname = a.attname
      where c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
        and not c.relispartition
        and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)'
      order by n.nspname, c.relname, a.attnum`),
    query(`
      select n.nspname as schema, c.relname as table, fn.nspname as ref_schema, fc.relname as ref_table,
             array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as columns,
             array(select a.attname::text from unnest(k.confkey) with ordinality u(attnum, ord)
                   join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord) as ref_columns
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class fc on fc.oid = k.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
      where k.contype = 'f'`),
  ]);

  const tables = new Map();
  for (const r of cols.rows) {
    const id = `${r.schema}.${r.table}`;
    if (!tables.has(id)) {
      tables.set(id, {
        id, schema: r.schema, name: r.table, kind: r.kind, comment: r.table_comment,
        estRows: r.est_rows, bytes: Number(r.bytes), hasStats: false, columns: [],
      });
    }
    if (r.n_distinct !== null) tables.get(id).hasStats = true;
    const kind = category(r.typcategory, r.typtype, r.typname);
    let values = null;
    if (kind === "enum") values = r.enum_labels;
    else if (kind === "boolean") values = ["true", "false"];
    else if (kind === "text" && r.n_distinct > 0 && r.n_distinct <= MAX_CATEGORY_VALUES) {
      const common = parseArrayLiteral(r.common_vals).filter((v) => v.length && v.length <= 60);
      // Only trust the list when statistics cover every distinct value.
      if (common.length && common.length >= r.n_distinct) values = common;
    }
    tables.get(id).columns.push({
      table: id, name: r.name, type: r.type, kind, comment: r.comment, isPk: r.is_pk, values,
      nullable: !r.not_null && !r.is_pk,
    });
  }

  await sampleUnanalyzed(tables);

  // Labels are what Jev sees. Drop the schema prefix when the table name is unambiguous.
  const nameCounts = new Map();
  for (const t of tables.values()) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);
  for (const t of tables.values()) {
    t.label = nameCounts.get(t.name) > 1 ? t.id : t.name;
    for (const c of t.columns) {
      c.id = `${t.id}.${c.name}`;
      c.label = `${t.label}.${c.name}`;
    }
  }

  const edges = fks.rows
    .map((f) => ({
      from: `${f.schema}.${f.table}`, to: `${f.ref_schema}.${f.ref_table}`,
      fromColumns: f.columns, toColumns: f.ref_columns,
    }))
    .filter((e) => tables.has(e.from) && tables.has(e.to));
  for (const e of edges) {
    const t = tables.get(e.from);
    e.fromColumns.forEach((name, i) => {
      const col = t.columns.find((c) => c.name === name);
      if (col) col.references = `${tables.get(e.to).label}.${e.toColumns[i]}`;
    });
  }

  const model = { tables, edges };
  cache = { key, at: Date.now(), model };
  return model;
}

const SAMPLE_MAX_BYTES = 16 * 1024 * 1024;
const LABEL_LIKE = /status|state|stage|type|kind|role|level|outcome|source|tier|plan|category|priority|severity|phase|mode|provider|env|result|visibility|scope/i;
const PROSE_LIKE = /body|text|note|comment|description|message|content|input|output|error|prompt|summary|reason|url|uri|path|hash|token|secret|key$|email|metadata|title/i;

/**
 * A database that was never ANALYZEd has no pg_stats, so nothing above knows which values a column
 * holds or how many rows a table has, and a word like "shipped" cannot be tied to a column. For small
 * tables without statistics, read that directly: one query per table returns the row count and up to
 * 26 distinct values of each short text column.
 */
async function sampleUnanalyzed(tables) {
  const targets = [...tables.values()]
    .filter((t) => "rpm".includes(t.kind) && !t.hasStats && t.bytes <= SAMPLE_MAX_BYTES)
    .slice(0, 60);
  await Promise.all(targets.map(async (t) => {
    const candidates = t.columns.filter((c) => c.kind === "text" && !c.values && !c.isPk && !PROSE_LIKE.test(c.name) && !/_id$|^id$/i.test(c.name)).slice(0, 12);
    const from = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
    const picks = candidates.map((c, i) =>
      `array(select distinct left(${quoteIdent(c.name)}::text, 61) from ${from} where ${quoteIdent(c.name)} is not null limit ${MAX_CATEGORY_VALUES + 1}) as v${i}`);
    try {
      const { rows } = await query(`select count(*)::bigint as n${picks.length ? ", " + picks.join(", ") : ""} from ${from}`);
      const n = Number(rows[0].n);
      if (!(t.estRows > 0)) t.estRows = n;
      candidates.forEach((c, i) => {
        const values = rows[0][`v${i}`] ?? [];
        const short = values.length >= 1 && values.length <= MAX_CATEGORY_VALUES && values.every((v) => v.length && v.length <= 60);
        // Few rows make every column look like a category, so an unlabelled column must also repeat.
        if (short && (LABEL_LIKE.test(c.name) || values.length <= n / 2)) c.values = values.sort();
      });
    } catch { /* no privilege, or the table vanished: leave it without values */ }
  }));
}

/** Shortest foreign-key path between two tables (either direction), up to `maxHops`. */
export function joinPath(model, fromId, toId, maxHops = 3) {
  if (fromId === toId) return [];
  const seen = new Set([fromId]);
  let frontier = [{ at: fromId, path: [] }];
  for (let hop = 0; hop < maxHops; hop++) {
    const next = [];
    for (const { at, path } of frontier) {
      for (const e of model.edges) {
        let step = null;
        if (e.from === at) step = { left: e.from, right: e.to, leftColumns: e.fromColumns, rightColumns: e.toColumns };
        else if (e.to === at) step = { left: e.to, right: e.from, leftColumns: e.toColumns, rightColumns: e.fromColumns };
        if (!step || seen.has(step.right)) continue;
        const extended = [...path, step];
        if (step.right === toId) return extended;
        seen.add(step.right);
        next.push({ at: step.right, path: extended });
      }
    }
    frontier = next;
  }
  return null;
}
