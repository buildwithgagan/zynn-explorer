import { createHash } from "node:crypto";
import { query, connectionInfo } from "../db.js";
import { parseCatalogType, parseCatalogDefault, typeLabel, sameType } from "./types.js";

// The design is Creator's picture of a database: plain JSON, so it can be cloned, diffed and sent to the browser.
// `loadDesign()` reads it from the catalog; ops are then replayed on a clone to get the draft.

const TTL_MS = 60_000;
const USER_SCHEMA = `n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)'`;
const FK_ACTIONS = { a: "no_action", r: "restrict", c: "cascade", n: "set_null", d: "set_default" };
const POLICY_CMDS = { "*": "all", r: "select", a: "insert", w: "update", d: "delete" };
let cache = null;

export function invalidateDesign() {
  cache = null;
}

const rows = async (sql) => (await query(sql)).rows;

export async function loadDesign() {
  const key = JSON.stringify(connectionInfo());
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return structuredClone(cache.design);

  const [meta, schemas, tables, columns, constraints, indexes, enums, policies, grants, roles] = await Promise.all([
    rows(`select current_database() as database, current_setting('server_version_num')::int as version_num`),
    rows(`select n.nspname as name from pg_namespace n where ${USER_SCHEMA} order by 1`),
    rows(`select c.oid::int as oid, n.nspname as schema, c.relname as name, c.reltuples::bigint as est_rows,
                 c.relrowsecurity as rls, obj_description(c.oid, 'pg_class') as comment
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p') and ${USER_SCHEMA} order by 2, 3`),
    rows(`select a.attrelid::int as rel, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                 case when t.typtype = 'e' then tn.nspname || '.' || t.typname end as enum_id,
                 a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default,
                 a.attidentity as identity, a.attgenerated as generated,
                 col_description(a.attrelid, a.attnum) as comment
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          join pg_type t on t.oid = a.atttypid join pg_namespace tn on tn.oid = t.typnamespace
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where c.relkind in ('r','p') and ${USER_SCHEMA} and a.attnum > 0 and not a.attisdropped
          order by a.attrelid, a.attnum`),
    rows(`select k.conrelid::int as rel, k.conname as name, k.contype as type,
                 array(select a.attname::text from unnest(k.conkey) with ordinality u(n, i)
                       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i) as columns,
                 fn.nspname || '.' || fc.relname as ref_table,
                 array(select a.attname::text from unnest(k.confkey) with ordinality u(n, i)
                       join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i) as ref_columns,
                 k.confdeltype as on_delete, k.confupdtype as on_update,
                 pg_get_constraintdef(k.oid, true) as definition
          from pg_constraint k
          join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          left join pg_class fc on fc.oid = k.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
          where k.contype in ('p','f','u','c') and c.relkind in ('r','p') and ${USER_SCHEMA}
          order by k.conname`),
    rows(`select i.indrelid::int as rel, ic.relname as name, i.indisunique as is_unique, am.amname as method,
                 array(select a.attname::text from unnest(i.indkey::int[]) with ordinality u(n, i)
                       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.n order by u.i) as columns,
                 pg_get_indexdef(i.indexrelid) as definition
          from pg_index i
          join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
          join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p') and ${USER_SCHEMA}
            and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
          order by ic.relname`),
    rows(`select n.nspname as schema, t.typname as name,
                 array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) as values
          from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'e' and ${USER_SCHEMA} order by 1, 2`),
    rows(`select p.polrelid::int as rel, p.polname as name, p.polcmd as command,
                 pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
                 array(select pg_get_userbyid(r)::text from unnest(p.polroles) r) as roles
          from pg_policy p order by 2`),
    rows(`select table_schema || '.' || table_name as table_id, grantee as role,
                 array_agg(privilege_type::text order by privilege_type) as privileges
          from information_schema.role_table_grants
          where table_schema not in ('pg_catalog','information_schema') group by 1, 2 order by 1, 2`),
    rows(`select rolname as name, rolcanlogin as login from pg_roles where rolname !~ '^pg_' order by 1`),
  ]);

  const design = {
    database: meta[0].database, versionNum: meta[0].version_num,
    schemas: schemas.map((s) => s.name), enums: {}, roles: {}, tables: {},
  };
  for (const e of enums) design.enums[`${e.schema}.${e.name}`] = { schema: e.schema, name: e.name, values: e.values };
  for (const r of roles) design.roles[r.name] = { login: r.login };

  const byOid = new Map();
  for (const t of tables) {
    const table = {
      schema: t.schema, name: t.name, comment: t.comment ?? null, rls: t.rls, estRows: Number(t.est_rows),
      columns: [], pk: null, fks: [], uniques: [], checks: [], indexes: [], policies: [], grants: [],
    };
    design.tables[`${t.schema}.${t.name}`] = table;
    byOid.set(t.oid, table);
  }
  for (const c of columns) {
    byOid.get(c.rel)?.columns.push({
      name: c.name, type: parseCatalogType(c.type, c.enum_id), nullable: !c.not_null,
      default: c.generated ? null : parseCatalogDefault(c.default),
      identity: c.identity === "a" ? "always" : c.identity === "d" ? "by_default" : null,
      generated: Boolean(c.generated), comment: c.comment ?? null,
    });
  }
  for (const k of constraints) {
    const table = byOid.get(k.rel);
    if (!table) continue;
    if (k.type === "p") table.pk = { name: k.name, columns: k.columns };
    else if (k.type === "u") table.uniques.push({ name: k.name, columns: k.columns });
    else if (k.type === "c") table.checks.push({ name: k.name, definition: k.definition });
    else table.fks.push({
      name: k.name, columns: k.columns, refTable: k.ref_table, refColumns: k.ref_columns,
      onDelete: FK_ACTIONS[k.on_delete] ?? "no_action", onUpdate: FK_ACTIONS[k.on_update] ?? "no_action",
    });
  }
  for (const i of indexes) byOid.get(i.rel)?.indexes.push({ name: i.name, columns: i.columns, unique: i.is_unique, method: i.method, definition: i.definition });
  for (const p of policies) byOid.get(p.rel)?.policies.push({ name: p.name, command: POLICY_CMDS[p.command] ?? "all", roles: p.roles, using: p.using, check: p.with_check });
  for (const g of grants) design.tables[g.table_id]?.grants.push({ role: g.role, privileges: g.privileges });

  cache = { key, at: Date.now(), design };
  return structuredClone(design);
}

const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};

/** Identifies a schema state. Apply refuses to run against a database that has moved on since the preview. */
export function fingerprint(design) {
  const tables = Object.fromEntries(Object.entries(design.tables).map(([id, t]) => [id, { ...t, estRows: undefined, grants: undefined }]));
  return createHash("sha1").update(JSON.stringify(canonical({ tables, enums: design.enums }))).digest("hex");
}

/** Tables ordered so that every table comes after the tables it references. Edges that close a cycle are `deferred`. */
export function topoTables(design, ids = Object.keys(design.tables)) {
  const wanted = new Set(ids);
  const order = [], deferred = [], state = new Map();
  const visit = (id) => {
    state.set(id, "open");
    for (const fk of design.tables[id].fks) {
      if (fk.refTable === id || !wanted.has(fk.refTable)) continue;
      if (state.get(fk.refTable) === "open") deferred.push({ table: id, fk: fk.name });
      else if (!state.has(fk.refTable)) visit(fk.refTable);
    }
    state.set(id, "done");
    order.push(id);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return { order, deferred };
}

/** The draft as a diagram, with each table, column and relation marked same / added / changed / dropped. */
export function toErd(baseline, draft, renames = {}) {
  const before = (id) => baseline.tables[renames[id] ?? id];
  const tables = [], edges = [];
  const columnRow = (t, c, state) => ({
    name: c.name, type: typeLabel(c.type), state,
    isPk: Boolean(t.pk?.columns.includes(c.name)), isFk: t.fks.some((f) => f.columns.includes(c.name)),
  });
  for (const [id, t] of Object.entries(draft.tables)) {
    const old = before(id);
    const columns = t.columns.map((c) => {
      const was = old?.columns.find((o) => o.name === c.name);
      const changed = was && (!sameType(was.type, c.type) || was.nullable !== c.nullable);
      return columnRow(t, c, !old ? "added" : !was ? "added" : changed ? "changed" : "same");
    });
    for (const o of old?.columns ?? []) if (!t.columns.some((c) => c.name === o.name)) columns.push(columnRow(old, o, "dropped"));
    const touched = columns.some((c) => c.state !== "same") || (old && (renames[id] || old.rls !== t.rls || old.fks.length !== t.fks.length || old.indexes.length !== t.indexes.length));
    tables.push({ id, schema: t.schema, name: t.name, state: !old ? "added" : touched ? "changed" : "same", columns });
    for (const f of t.fks) {
      edges.push({ from: id, to: f.refTable, fromCol: f.columns[0], toCol: f.refColumns[0], name: f.name,
        state: old?.fks.some((o) => o.name === f.name) ? "same" : "added" });
    }
  }
  const kept = new Set(Object.keys(draft.tables).map((id) => renames[id] ?? id));
  for (const [id, t] of Object.entries(baseline.tables)) {
    if (kept.has(id)) continue;
    tables.push({ id, schema: t.schema, name: t.name, state: "dropped", columns: t.columns.map((c) => columnRow(t, c, "dropped")) });
  }
  return { tables, edges };
}

export function emptyDesign(database = "draft") {
  return { database, versionNum: 160000, schemas: ["public"], enums: {}, roles: {}, tables: {} };
}
