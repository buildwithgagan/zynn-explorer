import { query, runSql, qualified, quoteIdent } from "./db.js";

const USER_SCHEMA = `n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)'`;

const rows = async (sql, params) => (await query(sql, params)).rows;

/** Sidebar tree: every schema with its relations, functions, sequences and types. */
export async function tree() {
  const [schemas, relations, functions, sequences, types] = await Promise.all([
    rows(`select n.nspname as name, pg_get_userbyid(n.nspowner) as owner,
                 obj_description(n.oid, 'pg_namespace') as comment
          from pg_namespace n where ${USER_SCHEMA} order by 1`),
    rows(`select n.nspname as schema, c.relname as name, c.relkind as kind,
                 c.reltuples::bigint as est_rows, pg_total_relation_size(c.oid) as bytes,
                 obj_description(c.oid, 'pg_class') as comment
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p','v','m','f') and ${USER_SCHEMA}
          order by 1, 2`),
    rows(`select n.nspname as schema, p.proname as name, p.oid::int as oid, p.prokind as kind,
                 pg_get_function_identity_arguments(p.oid) as args,
                 pg_get_function_result(p.oid) as returns
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where ${USER_SCHEMA}
            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          order by 1, 2`),
    rows(`select n.nspname as schema, c.relname as name
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and ${USER_SCHEMA} order by 1, 2`),
    rows(`select n.nspname as schema, t.typname as name, t.typtype as kind,
                 case when t.typtype = 'e' then
                   (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
                 end as labels,
                 case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end as base
          from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typtype in ('e','d','r') and ${USER_SCHEMA}
             or (t.typtype = 'c' and ${USER_SCHEMA}
                 and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
          order by 1, 2`),
  ]);
  return { schemas, relations, functions, sequences, types };
}

export async function overview() {
  const [db, counts, biggest, extensions] = await Promise.all([
    rows(`select d.datname as name, pg_database_size(d.oid) as bytes,
                 pg_encoding_to_char(d.encoding) as encoding, d.datcollate as collate,
                 pg_get_userbyid(d.datdba) as owner,
                 s.numbackends, s.xact_commit, s.xact_rollback, s.blks_read, s.blks_hit,
                 s.tup_returned, s.tup_fetched, s.tup_inserted, s.tup_updated, s.tup_deleted,
                 s.deadlocks, s.temp_bytes, s.stats_reset,
                 pg_postmaster_start_time() as started, version() as version,
                 current_setting('max_connections')::int as max_connections
          from pg_database d join pg_stat_database s on s.datid = d.oid
          where d.datname = current_database()`),
    rows(`select
            count(*) filter (where c.relkind in ('r','p')) as tables,
            count(*) filter (where c.relkind = 'v') as views,
            count(*) filter (where c.relkind = 'm') as matviews,
            count(*) filter (where c.relkind = 'i') as indexes,
            count(*) filter (where c.relkind = 'S') as sequences,
            (select count(*) from pg_namespace n where ${USER_SCHEMA}) as schemas,
            (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMA}) as functions
          from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMA}`),
    rows(`select n.nspname as schema, c.relname as name, c.relkind as kind,
                 c.reltuples::bigint as est_rows,
                 pg_total_relation_size(c.oid) as total_bytes,
                 pg_table_size(c.oid) as table_bytes,
                 pg_indexes_size(c.oid) as index_bytes
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p','m') and ${USER_SCHEMA}
          order by pg_total_relation_size(c.oid) desc limit 15`),
    rows(`select e.extname as name, e.extversion as version, n.nspname as schema,
                 obj_description(e.oid, 'pg_extension') as comment
          from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`),
  ]);
  return { database: db[0], counts: counts[0], biggest, extensions };
}

async function relationOid(schema, name) {
  const found = await rows(
    `select c.oid::int as oid, c.relkind as kind from pg_class c
     join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`,
    [schema, name]
  );
  if (!found.length) {
    const err = new Error(`Relation ${schema}.${name} not found`);
    err.status = 404;
    throw err;
  }
  return found[0];
}

export async function relation(schema, name) {
  const { oid, kind } = await relationOid(schema, name);
  const [meta, columns, indexes, constraints, referencedBy, triggers, policies, grants, stats, partitions] =
    await Promise.all([
      rows(`select c.relkind as kind, pg_get_userbyid(c.relowner) as owner, c.reltuples::bigint as est_rows,
                   pg_total_relation_size(c.oid) as total_bytes, pg_table_size(c.oid) as table_bytes,
                   pg_indexes_size(c.oid) as index_bytes, obj_description(c.oid, 'pg_class') as comment,
                   c.relrowsecurity as rls, c.relispartition as is_partition,
                   pg_get_partkeydef(c.oid) as partition_key,
                   case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as definition
            from pg_class c where c.oid = $1`, [oid]),
      rows(`select a.attnum as position, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                   a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default,
                   a.attidentity as identity, a.attgenerated as generated,
                   col_description(a.attrelid, a.attnum) as comment,
                   exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary
                           and a.attnum = any(i.indkey)) as is_pk,
                   (select format('%I.%I(%I)', fn.nspname, fc.relname, fa.attname)
                      from pg_constraint k
                      join pg_class fc on fc.oid = k.confrelid
                      join pg_namespace fn on fn.oid = fc.relnamespace
                      join pg_attribute fa on fa.attrelid = k.confrelid
                       and fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
                     where k.conrelid = a.attrelid and k.contype = 'f' and a.attnum = any(k.conkey)
                     limit 1) as references,
                   s.null_frac, s.n_distinct
            from pg_attribute a
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            left join pg_stats s on s.schemaname = $2 and s.tablename = $3 and s.attname = a.attname
            where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
            order by a.attnum`, [oid, schema, name]),
      rows(`select ic.relname as name, am.amname as method, i.indisunique as is_unique,
                   i.indisprimary as is_primary, i.indisvalid as is_valid,
                   pg_relation_size(ic.oid) as bytes, pg_get_indexdef(i.indexrelid) as definition,
                   st.idx_scan as scans, st.idx_tup_read as tuples_read
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
            join pg_am am on am.oid = ic.relam
            left join pg_stat_all_indexes st on st.indexrelid = i.indexrelid
            where i.indrelid = $1 order by i.indisprimary desc, ic.relname`, [oid]),
      rows(`select k.conname as name, k.contype as type, pg_get_constraintdef(k.oid, true) as definition
            from pg_constraint k where k.conrelid = $1 order by k.contype, k.conname`, [oid]),
      rows(`select k.conname as name, n.nspname as schema, c.relname as table,
                   pg_get_constraintdef(k.oid, true) as definition
            from pg_constraint k
            join pg_class c on c.oid = k.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            where k.confrelid = $1 and k.contype = 'f' order by 2, 3`, [oid]),
      rows(`select t.tgname as name, t.tgenabled as enabled, pg_get_triggerdef(t.oid, true) as definition
            from pg_trigger t where t.tgrelid = $1 and not t.tgisinternal order by 1`, [oid]),
      rows(`select p.polname as name, p.polcmd as command, p.polpermissive as permissive,
                   pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
                   array(select pg_get_userbyid(r)::text from unnest(p.polroles) r) as roles
            from pg_policy p where p.polrelid = $1 order by 1`, [oid]),
      rows(`select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
            from information_schema.role_table_grants
            where table_schema = $1 and table_name = $2 group by grantee order by 1`, [schema, name]),
      rows(`select seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd, n_tup_del,
                   n_tup_hot_upd, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum,
                   last_analyze, last_autoanalyze, vacuum_count, autovacuum_count
            from pg_stat_all_tables where relid = $1`, [oid]),
      rows(`select n.nspname as schema, c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
            from pg_inherits i join pg_class c on c.oid = i.inhrelid
            join pg_namespace n on n.oid = c.relnamespace where i.inhparent = $1 order by 2`, [oid]),
    ]);

  const detail = {
    schema, name, kind, ...meta[0],
    columns, indexes, constraints, referencedBy, triggers, policies, grants,
    stats: stats[0] ?? null, partitions,
  };
  detail.ddl = buildDdl(detail);
  return detail;
}

/** Reconstructed DDL. Approximate by design: good for reading, not a pg_dump replacement. */
function buildDdl(d) {
  const target = qualified(d.schema, d.name);
  if (d.kind === "v") return `CREATE VIEW ${target} AS\n${d.definition}`;
  if (d.kind === "m") return `CREATE MATERIALIZED VIEW ${target} AS\n${d.definition}`;

  const lines = d.columns.map((c) => {
    let line = `  ${quoteIdent(c.name)} ${c.type}`;
    if (c.identity === "a") line += " GENERATED ALWAYS AS IDENTITY";
    else if (c.identity === "d") line += " GENERATED BY DEFAULT AS IDENTITY";
    else if (c.generated === "s") line += ` GENERATED ALWAYS AS (${c.default}) STORED`;
    else if (c.default != null) line += ` DEFAULT ${c.default}`;
    if (c.not_null) line += " NOT NULL";
    return line;
  });
  for (const k of d.constraints) lines.push(`  CONSTRAINT ${quoteIdent(k.name)} ${k.definition}`);

  let ddl = `CREATE ${d.kind === "f" ? "FOREIGN " : ""}TABLE ${target} (\n${lines.join(",\n")}\n)`;
  if (d.partition_key) ddl += ` PARTITION BY ${d.partition_key}`;
  ddl += ";";
  const secondary = d.indexes.filter((i) => !d.constraints.some((k) => k.name === i.name));
  if (secondary.length) ddl += "\n\n" + secondary.map((i) => i.definition + ";").join("\n");
  if (d.triggers.length) ddl += "\n\n" + d.triggers.map((t) => t.definition + ";").join("\n");
  if (d.comment) ddl += `\n\nCOMMENT ON TABLE ${target} IS '${d.comment.replace(/'/g, "''")}';`;
  return ddl;
}

const FILTER_OPS = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  contains: "ilike", is_null: "is null", not_null: "is not null",
};

/** Paginated, sortable, filterable data browse. Identifiers are validated against the catalog. */
export async function browse(schema, name, { limit = 100, offset = 0, sort, dir, filters = [] } = {}) {
  const { oid } = await relationOid(schema, name);
  const cols = (await rows(
    `select attname as name from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped`, [oid]
  )).map((r) => r.name);
  const known = new Set(cols);

  const params = [];
  const where = [];
  for (const f of filters) {
    if (!known.has(f.column) || !FILTER_OPS[f.op]) continue;
    const col = quoteIdent(f.column);
    if (f.op === "is_null" || f.op === "not_null") {
      where.push(`${col} ${FILTER_OPS[f.op]}`);
    } else if (f.op === "contains") {
      params.push(`%${String(f.value).replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`${col}::text ilike $${params.length}`);
    } else {
      params.push(String(f.value));
      where.push(`${col}::text ${FILTER_OPS[f.op]} $${params.length}`);
    }
  }
  const whereSql = where.length ? ` where ${where.join(" and ")}` : "";
  const orderSql = sort && known.has(sort)
    ? ` order by ${quoteIdent(sort)} ${dir === "desc" ? "desc" : "asc"} nulls last` : "";
  const lim = Math.min(Math.max(Number(limit) | 0, 1), 1000);
  const off = Math.max(Number(offset) | 0, 0);

  const sql = `select * from ${qualified(schema, name)}${whereSql}${orderSql} limit ${lim} offset ${off}`;
  const [data, total] = await Promise.all([
    runSql(sql, params),
    where.length
      ? runSql(`select count(*) from ${qualified(schema, name)}${whereSql}`, params, { timeoutMs: 8_000 })
          .then((r) => ({ count: r.rows[0][0], exact: true }))
          .catch(() => ({ count: null, exact: false }))
      : rows(`select reltuples::bigint as n from pg_class where oid = $1`, [oid])
          .then((r) => ({ count: Math.max(r[0].n, 0), exact: false })),
  ]);
  return { ...data, sql, total };
}

export async function functionDetail(oid) {
  const found = await rows(
    `select n.nspname as schema, p.proname as name, l.lanname as language, p.prokind as kind,
            pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
            p.provolatile as volatility, p.prosecdef as security_definer,
            pg_get_userbyid(p.proowner) as owner, obj_description(p.oid, 'pg_proc') as comment,
            case when p.prokind <> 'a' then pg_get_functiondef(p.oid) end as definition
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where p.oid = $1`, [Number(oid)]
  );
  if (!found.length) {
    const err = new Error("Function not found");
    err.status = 404;
    throw err;
  }
  return found[0];
}

export async function sequences() {
  return rows(`select schemaname as schema, sequencename as name, data_type, start_value, min_value,
                      max_value, increment_by, cycle, last_value
               from pg_sequences order by 1, 2`);
}

export async function roles() {
  return rows(`select r.rolname as name, r.rolsuper as superuser, r.rolcreatedb as create_db,
                      r.rolcreaterole as create_role, r.rolcanlogin as can_login,
                      r.rolreplication as replication, r.rolbypassrls as bypass_rls,
                      r.rolconnlimit as conn_limit, r.rolvaliduntil as valid_until,
                      array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid
                            where m.member = r.oid) as member_of
               from pg_roles r where r.rolname !~ '^pg_' order by 1`);
}

export async function activity() {
  const [sessions, locks] = await Promise.all([
    rows(`select pid, usename as user, datname as database, application_name as app,
                 client_addr::text as client, state, wait_event_type, wait_event,
                 backend_type, backend_start, xact_start, query_start,
                 extract(epoch from (now() - query_start))::int as query_secs,
                 left(query, 2000) as query
          from pg_stat_activity where pid <> pg_backend_pid()
          order by (state = 'active') desc, query_start desc nulls last`),
    rows(`select l.pid, l.locktype, l.mode, l.granted, c.relname as relation,
                 a.usename as user, left(a.query, 400) as query,
                 pg_blocking_pids(l.pid) as blocked_by
          from pg_locks l
          left join pg_class c on c.oid = l.relation
          left join pg_stat_activity a on a.pid = l.pid
          where l.pid <> pg_backend_pid() and (not l.granted or l.locktype in ('relation','transactionid','tuple'))
            and (c.relname is null or c.relname !~ '^pg_')
          order by l.granted, l.pid limit 200`),
  ]);
  return { sessions, locks };
}

export async function settings() {
  return rows(`select name, setting, unit, category, short_desc, source, boot_val, reset_val,
                      context, pending_restart
               from pg_settings order by category, name`);
}

export async function databases() {
  return rows(`select d.datname as name, pg_get_userbyid(d.datdba) as owner,
                      pg_encoding_to_char(d.encoding) as encoding,
                      case when has_database_privilege(d.datname, 'CONNECT') then pg_database_size(d.oid) end as bytes,
                      d.datname = current_database() as current
               from pg_database d where not d.datistemplate order by 1`);
}

/** Foreign-key graph for the relationships view and the NL join planner. */
export async function foreignKeys() {
  return rows(`select k.conname as name,
                      n.nspname as schema, c.relname as table,
                      array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as columns,
                      fn.nspname as ref_schema, fc.relname as ref_table,
                      array(select a.attname::text from unnest(k.confkey) with ordinality u(attnum, ord)
                            join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord) as ref_columns
               from pg_constraint k
               join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
               join pg_class fc on fc.oid = k.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
               where k.contype = 'f' and ${USER_SCHEMA} order by 2, 3, 1`);
}

/** Global object search across relations, columns and functions. */
export async function search(term) {
  const like = `%${String(term).replace(/[\\%_]/g, "\\$&")}%`;
  return rows(`
    (select 'relation' as type, n.nspname as schema, c.relname as name, null::text as detail, c.relkind::text as kind
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p','v','m','f') and ${USER_SCHEMA} and c.relname ilike $1 limit 25)
    union all
    (select 'column', n.nspname, c.relname, a.attname || ' ' || format_type(a.atttypid, a.atttypmod), c.relkind::text
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
        and ${USER_SCHEMA} and a.attname ilike $1 limit 40)
    union all
    (select 'function', n.nspname, p.proname, p.oid::text, p.prokind::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${USER_SCHEMA} and p.proname ilike $1 limit 20)`, [like]);
}
