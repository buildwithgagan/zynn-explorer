import {
  h, api, enc, fmtBytes, fmtNum, fmtCompact, fmtTime, KIND_NAMES, codeBlock, resultTable, objectTable,
  toCsv, download, mount, tabs, errorBox, loading, promptDialog,
} from "./ui.js";
import { erdDiagram } from "./erd.js";

const relHref = (schema, name) => `#/rel/${enc(schema)}/${enc(name)}`;
const card = (k, v, small) => h("div.card", h("div.k", k), h("div.v", v, small && h("small", " " + small)));

// ---------------------------------------------------------------- overview
export async function overviewPage() {
  const o = await api("/overview");
  const d = o.database;
  const hit = Number(d.blks_hit) + Number(d.blks_read) > 0
    ? (100 * Number(d.blks_hit) / (Number(d.blks_hit) + Number(d.blks_read))).toFixed(1) + "%" : "—";
  const max = Math.max(...o.biggest.map((b) => Number(b.total_bytes)), 1);
  return h("div.page",
    h("div.page-head", h("h1", d.name), h("span.sub", d.version.split(" on ")[0])),
    h("div.cards",
      card("Size", fmtBytes(d.bytes)), card("Tables", fmtNum(o.counts.tables)), card("Views", fmtNum(Number(o.counts.views) + Number(o.counts.matviews))),
      card("Indexes", fmtNum(o.counts.indexes)), card("Functions", fmtNum(o.counts.functions)), card("Schemas", fmtNum(o.counts.schemas)),
      card("Connections", d.numbackends, `/ ${d.max_connections}`), card("Cache hit", hit)),
    h("div.section", h("h2", "Largest relations"),
      objectTable(o.biggest, [
        { label: "Relation", render: (r) => h("a.mono", { href: relHref(r.schema, r.name) }, `${r.schema}.${r.name}`) },
        { label: "Rows (est.)", num: true, render: (r) => fmtNum(r.est_rows) },
        { label: "Table", num: true, render: (r) => fmtBytes(r.table_bytes) },
        { label: "Indexes", num: true, render: (r) => fmtBytes(r.index_bytes) },
        { label: "Total", num: true, render: (r) => fmtBytes(r.total_bytes) },
        { label: "", render: (r) => h("div", { style: "width:160px" }, h("div.bar", { style: `width:${(100 * r.total_bytes / max).toFixed(1)}%` })) },
      ], { empty: "No tables yet." })),
    h("div.two",
      h("div.section", h("h2", "Database"),
        h("div.panel", { style: "padding:14px" }, h("dl.kv",
          h("dt", "Owner"), h("dd", d.owner), h("dt", "Encoding"), h("dd", d.encoding), h("dt", "Collation"), h("dd", d.collate),
          h("dt", "Server started"), h("dd", fmtTime(d.started)),
          h("dt", "Commits / rollbacks"), h("dd", `${fmtNum(d.xact_commit)} / ${fmtNum(d.xact_rollback)}`),
          h("dt", "Tuples in / upd / del"), h("dd", `${fmtNum(d.tup_inserted)} / ${fmtNum(d.tup_updated)} / ${fmtNum(d.tup_deleted)}`),
          h("dt", "Deadlocks"), h("dd", fmtNum(d.deadlocks)), h("dt", "Temp bytes"), h("dd", fmtBytes(d.temp_bytes))))),
      h("div.section", h("h2", "Extensions"),
        objectTable(o.extensions, [
          { label: "Name", key: "name", mono: true }, { label: "Version", key: "version", mono: true },
          { label: "Schema", key: "schema", mono: true }, { label: "Description", key: "comment", wrap: true },
        ]))));
}

// ---------------------------------------------------------------- relation
const CONSTRAINT_TYPES = { p: "primary key", f: "foreign key", u: "unique", c: "check", x: "exclusion", n: "not null", t: "trigger" };

export async function relationPage(schema, name, initialTab) {
  const d = await api(`/relation/${enc(schema)}/${enc(name)}`);
  const types = Object.fromEntries(d.columns.map((c) => [c.name, c.type]));

  const columnsTab = () => objectTable(d.columns, [
    { label: "#", key: "position", num: true },
    { label: "Column", render: (c) => h("span.mono", c.is_pk && h("span.pk", { title: "primary key" }, "⚷ "), c.name) },
    { label: "Type", key: "type", mono: true },
    { label: "Nullable", render: (c) => (c.not_null ? "not null" : h("span", { style: "color:var(--faint)" }, "null")) },
    { label: "Default", mono: true, render: (c) => c.identity ? "identity" : c.generated === "s" ? `generated: ${c.default}` : c.default },
    { label: "References", render: (c) => {
      if (!c.references) return null;
      const m = c.references.match(/^(.*)\.([^.(]+)\((.*)\)$/);
      return m ? h("a.mono", { href: relHref(m[1].replace(/"/g, ""), m[2].replace(/"/g, "")) }, c.references) : c.references;
    } },
    { label: "Distinct", num: true, render: (c) => c.n_distinct == null ? null : c.n_distinct < 0 ? `${Math.round(-c.n_distinct * 100)}% of rows` : fmtNum(c.n_distinct) },
    { label: "Nulls", num: true, render: (c) => c.null_frac == null ? null : `${(c.null_frac * 100).toFixed(1)}%` },
    { label: "Comment", key: "comment", wrap: true },
  ]);

  const structureTab = () => h("div",
    h("div.section", h("h2", "Indexes"), objectTable(d.indexes, [
      { label: "Name", render: (i) => h("span.mono", i.name, " ", i.is_primary && h("span.badge.accent", "primary"), i.is_unique && !i.is_primary && h("span.badge", "unique"), !i.is_valid && h("span.badge.bad", "invalid")) },
      { label: "Method", key: "method", mono: true }, { label: "Size", num: true, render: (i) => fmtBytes(i.bytes) },
      { label: "Scans", num: true, render: (i) => fmtNum(i.scans) }, { label: "Definition", key: "definition", mono: true, wrap: true },
    ], { empty: "No indexes." })),
    h("div.section", h("h2", "Constraints"), objectTable(d.constraints, [
      { label: "Name", key: "name", mono: true }, { label: "Type", render: (k) => CONSTRAINT_TYPES[k.type] ?? k.type },
      { label: "Definition", key: "definition", mono: true, wrap: true },
    ], { empty: "No constraints." })),
    h("div.section", h("h2", "Referenced by"), objectTable(d.referencedBy, [
      { label: "Table", render: (r) => h("a.mono", { href: relHref(r.schema, r.table) }, `${r.schema}.${r.table}`) },
      { label: "Constraint", key: "name", mono: true }, { label: "Definition", key: "definition", mono: true, wrap: true },
    ], { empty: "No other table references this one." })),
    h("div.section", h("h2", "Triggers"), objectTable(d.triggers, [
      { label: "Name", key: "name", mono: true }, { label: "Enabled", render: (t) => (t.enabled === "D" ? "disabled" : "enabled") },
      { label: "Definition", key: "definition", mono: true, wrap: true },
    ], { empty: "No triggers." })),
    d.partitions.length ? h("div.section", h("h2", "Partitions"), objectTable(d.partitions, [
      { label: "Partition", render: (p) => h("a.mono", { href: relHref(p.schema, p.name) }, p.name) }, { label: "Bound", key: "bound", mono: true },
    ])) : null);

  const accessTab = () => h("div",
    h("div.section", h("h2", "Grants"), objectTable(d.grants, [
      { label: "Grantee", key: "grantee", mono: true }, { label: "Privileges", key: "privileges", wrap: true },
    ], { empty: "No explicit grants." })),
    h("div.section", h("h2", `Row-level security ${d.rls ? "(enabled)" : "(off)"}`), objectTable(d.policies, [
      { label: "Policy", key: "name", mono: true }, { label: "Command", key: "command" },
      { label: "Roles", render: (p) => p.roles.join(", ") || "public" },
      { label: "Using", key: "using", mono: true, wrap: true }, { label: "With check", key: "with_check", mono: true, wrap: true },
    ], { empty: "No policies." })));

  const statsTab = () => {
    const s = d.stats;
    if (!s) return h("div.panel.empty", "No statistics for this relation.");
    const dead = Number(s.n_live_tup) + Number(s.n_dead_tup) > 0 ? (100 * s.n_dead_tup / (Number(s.n_live_tup) + Number(s.n_dead_tup))).toFixed(1) + "%" : "—";
    return h("div",
      h("div.cards", card("Live rows", fmtNum(s.n_live_tup)), card("Dead rows", fmtNum(s.n_dead_tup), dead),
        card("Seq scans", fmtNum(s.seq_scan)), card("Index scans", fmtNum(s.idx_scan)),
        card("Inserts", fmtNum(s.n_tup_ins)), card("Updates", fmtNum(s.n_tup_upd), `${fmtNum(s.n_tup_hot_upd)} HOT`), card("Deletes", fmtNum(s.n_tup_del))),
      h("div.panel", { style: "padding:14px" }, h("dl.kv",
        h("dt", "Last vacuum"), h("dd", fmtTime(s.last_vacuum)), h("dt", "Last autovacuum"), h("dd", fmtTime(s.last_autovacuum)),
        h("dt", "Last analyze"), h("dd", fmtTime(s.last_analyze)), h("dt", "Last autoanalyze"), h("dd", fmtTime(s.last_autoanalyze)))));
  };

  return h("div.page",
    h("div.page-head",
      h("h1", d.name), h("span.badge.accent", KIND_NAMES[d.kind] ?? d.kind), h("span.sub", `${d.schema} · owner ${d.owner}`),
      h("span.spacer"),
      h("span.sub", `${fmtNum(d.est_rows)} rows est. · ${fmtBytes(d.total_bytes)}`),
      h("a.btn", { href: `#/sql?q=${enc(`select * from "${schema}"."${name}" limit 100`)}` }, "Query in SQL")),
    d.comment && h("p", { style: "color:var(--muted);margin:-6px 0 14px" }, d.comment),
    tabs([
      { id: "data", label: "Data", render: () => dataBrowser(schema, name, d.columns, types) },
      { id: "columns", label: "Columns", count: d.columns.length, render: columnsTab },
      { id: "structure", label: "Indexes & constraints", count: d.indexes.length + d.constraints.length, render: structureTab },
      { id: "ddl", label: d.kind === "v" || d.kind === "m" ? "Definition" : "DDL", render: () => codeBlock(d.ddl) },
      { id: "access", label: "Access", render: accessTab },
      { id: "stats", label: "Statistics", render: statsTab },
    ], initialTab ?? "data"));
}

function dataBrowser(schema, name, columns, types) {
  const state = { limit: 100, offset: 0, sort: null, dir: "asc", filters: [] };
  const out = h("div");
  const chips = h("div.chips");
  const info = h("span.info");
  let last = null;

  const colSelect = h("select.input", columns.map((c) => h("option", { value: c.name }, c.name)));
  const opSelect = h("select.input", [["contains", "contains"], ["eq", "="], ["neq", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["is_null", "is null"], ["not_null", "is not null"]]
    .map(([v, l]) => h("option", { value: v }, l)));
  const valueInput = h("input.input", { placeholder: "value", onkeydown: (e) => e.key === "Enter" && addFilter() });

  function addFilter() {
    const op = opSelect.value;
    if (!op.endsWith("null") && valueInput.value === "") return;
    state.filters.push({ column: colSelect.value, op, value: valueInput.value });
    valueInput.value = "";
    state.offset = 0;
    load();
  }

  async function load() {
    chips.replaceChildren(...state.filters.map((f, i) => h("span.chip", `${f.column} ${opSelect.querySelector(`[value=${f.op}]`).textContent} ${f.op.endsWith("null") ? "" : f.value}`,
      h("button", { title: "Remove", onclick: () => { state.filters.splice(i, 1); state.offset = 0; load(); } }, "✕"))));
    out.replaceChildren(loading());
    try {
      last = await api(`/relation/${enc(schema)}/${enc(name)}/rows`, state);
      const to = state.offset + last.rows.length;
      const total = last.total.count == null ? "" : ` of ${last.total.exact ? "" : "~"}${fmtNum(last.total.count)}`;
      info.textContent = last.rows.length ? `${fmtNum(state.offset + 1)}–${fmtNum(to)}${total} · ${last.ms} ms` : `0 rows · ${last.ms} ms`;
      prev.disabled = state.offset === 0;
      next.disabled = last.rows.length < state.limit;
      out.replaceChildren(resultTable(last, {
        sort: state.sort, dir: state.dir, types, startAt: state.offset,
        onSort: (col) => {
          if (state.sort === col) state.dir = state.dir === "asc" ? "desc" : "asc";
          else { state.sort = col; state.dir = "asc"; }
          state.offset = 0;
          load();
        },
      }));
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  }

  const prev = h("button.btn.small", { onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load(); } }, "← Prev");
  const next = h("button.btn.small", { onclick: () => { state.offset += state.limit; load(); } }, "Next →");
  const size = h("select.input", { onchange: (e) => { state.limit = Number(e.target.value); state.offset = 0; load(); } },
    [50, 100, 250, 500, 1000].map((n) => h("option", { value: n, selected: n === 100 }, `${n} rows`)));

  load();
  return h("div",
    h("div.toolbar", colSelect, opSelect, valueInput, h("button.btn", { onclick: addFilter }, "Add filter"),
      h("span.spacer"), info, size, prev, next,
      h("button.btn.small", { onclick: () => last && download(`${name}.csv`, toCsv(last)) }, "CSV")),
    chips, h("div", { style: "height:8px" }), out);
}

// ---------------------------------------------------------------- function
export async function functionPage(oid) {
  const f = await api(`/function/${enc(oid)}`);
  const kind = { f: "function", p: "procedure", a: "aggregate", w: "window function" }[f.kind] ?? "function";
  return h("div.page",
    h("div.page-head", h("h1", f.name), h("span.badge.accent", kind), h("span.sub", `${f.schema} · ${f.language} · owner ${f.owner}`)),
    f.comment && h("p", { style: "color:var(--muted)" }, f.comment),
    h("div.section", h("div.panel", { style: "padding:14px" }, h("dl.kv",
      h("dt", "Arguments"), h("dd", f.args || "none"), h("dt", "Returns"), h("dd", f.returns ?? "—"),
      h("dt", "Volatility"), h("dd", { i: "immutable", s: "stable", v: "volatile" }[f.volatility]),
      h("dt", "Security"), h("dd", f.security_definer ? "definer" : "invoker")))),
    f.definition ? codeBlock(f.definition) : h("div.panel.empty", "Aggregates have no source definition."));
}

// ---------------------------------------------------------------- relationships
export async function relationshipsPage(tree) {
  const fks = await api("/foreign-keys");
  const linked = new Set(fks.flatMap((f) => [`${f.schema}.${f.table}`, `${f.ref_schema}.${f.ref_table}`]));
  const tables = tree.relations.filter((r) => linked.has(`${r.schema}.${r.name}`));
  if (!tables.length) return h("div.page", h("div.page-head", h("h1", "Relationships")), h("div.panel.empty", "No foreign keys in this database."));

  const details = await Promise.all(tables.slice(0, 40).map((t) => api(`/relation/${enc(t.schema)}/${enc(t.name)}`)));
  const svg = erdDiagram({
    tables: details.map((d) => ({
      id: `${d.schema}.${d.name}`, name: d.name, schema: d.schema,
      columns: d.columns.map((c) => ({ name: c.name, type: c.type, isPk: c.is_pk, isFk: Boolean(c.references) })),
    })),
    edges: fks.map((f) => ({
      from: `${f.schema}.${f.table}`, to: `${f.ref_schema}.${f.ref_table}`, fromCol: f.columns[0], toCol: f.ref_columns[0],
      title: `${f.table}.${f.columns.join(",")} → ${f.ref_table}.${f.ref_columns.join(",")}`,
    })),
  }, { onClick: (t) => (location.hash = relHref(t.schema, t.name)) });
  const nodes = details;

  return h("div.page", { style: "max-width:none" },
    h("div.page-head", h("h1", "Relationships"), h("span.sub", `${fks.length} foreign keys · ${nodes.length} tables`)),
    tabs([
      { id: "diagram", label: "Diagram", render: () => h("div.erd-wrap", svg) },
      { id: "list", label: "Foreign keys", count: fks.length, render: () => objectTable(fks, [
        { label: "Table", render: (f) => h("a.mono", { href: relHref(f.schema, f.table) }, `${f.schema}.${f.table}`) },
        { label: "Columns", mono: true, render: (f) => f.columns.join(", ") },
        { label: "References", render: (f) => h("a.mono", { href: relHref(f.ref_schema, f.ref_table) }, `${f.ref_schema}.${f.ref_table}`) },
        { label: "Columns", mono: true, render: (f) => f.ref_columns.join(", ") },
        { label: "Constraint", key: "name", mono: true },
      ]) },
    ]));
}

// ---------------------------------------------------------------- server pages
export async function activityPage() {
  const body = h("div");
  const auto = h("input", { type: "checkbox" });
  async function refresh() {
    const a = await api("/activity");
    body.replaceChildren(
      h("div.section", h("h2", `Sessions (${a.sessions.length})`), objectTable(a.sessions, [
        { label: "PID", key: "pid", num: true }, { label: "User", key: "user", mono: true }, { label: "Database", key: "database", mono: true },
        { label: "App", key: "app" }, { label: "Client", key: "client", mono: true },
        { label: "State", render: (s) => s.state && h(`span.badge${s.state === "active" ? ".accent" : s.state.includes("aborted") ? ".bad" : ""}`, s.state) },
        { label: "Wait", render: (s) => s.wait_event && `${s.wait_event_type}: ${s.wait_event}` },
        { label: "Running", num: true, render: (s) => (s.state === "active" && s.query_secs != null ? `${s.query_secs}s` : null) },
        { label: "Query", key: "query", mono: true, wrap: true },
      ], { empty: "No other sessions." })),
      h("div.section", h("h2", `Locks (${a.locks.length})`), objectTable(a.locks, [
        { label: "PID", key: "pid", num: true }, { label: "Type", key: "locktype" }, { label: "Mode", key: "mode", mono: true },
        { label: "Granted", render: (l) => (l.granted ? "yes" : h("span.badge.bad", "waiting")) },
        { label: "Relation", key: "relation", mono: true }, { label: "Blocked by", render: (l) => l.blocked_by?.join(", ") },
        { label: "Query", key: "query", mono: true, wrap: true },
      ], { empty: "No relation or transaction locks held by other sessions." })));
  }
  await refresh();
  const timer = setInterval(() => { if (!body.isConnected) clearInterval(timer); else if (auto.checked) refresh().catch(() => {}); }, 3000);
  return h("div.page", { style: "max-width:none" },
    h("div.page-head", h("h1", "Activity"), h("span.spacer"), h("label.check", auto, "Auto-refresh (3s)"), h("button.btn", { onclick: refresh }, "Refresh")), body);
}

export async function rolesPage() {
  const roles = await api("/roles");
  const flag = (on, label) => on && h("span.badge", label);
  return h("div.page", h("div.page-head", h("h1", "Roles"), h("span.sub", `${roles.length} roles`)),
    objectTable(roles, [
      { label: "Role", key: "name", mono: true },
      { label: "Attributes", render: (r) => h("span", flag(r.superuser, "superuser"), " ", flag(r.can_login, "login"), " ", flag(r.create_db, "createdb"), " ", flag(r.create_role, "createrole"), " ", flag(r.replication, "replication"), " ", flag(r.bypass_rls, "bypassrls")) },
      { label: "Member of", mono: true, render: (r) => r.member_of.join(", ") },
      { label: "Conn. limit", num: true, render: (r) => (r.conn_limit < 0 ? "∞" : r.conn_limit) },
      { label: "Valid until", render: (r) => r.valid_until && fmtTime(r.valid_until) },
    ]));
}

export async function settingsPage() {
  const all = await api("/settings");
  const out = h("div");
  const changedOnly = h("input", { type: "checkbox" });
  const filter = h("input.input", { placeholder: "Filter settings…", style: "width:280px" });
  const render = () => {
    const term = filter.value.toLowerCase();
    const rows = all.filter((s) => (!changedOnly.checked || s.setting !== s.boot_val)
      && (!term || s.name.includes(term) || s.short_desc.toLowerCase().includes(term) || s.category.toLowerCase().includes(term)));
    out.replaceChildren(objectTable(rows.slice(0, 400), [
      { label: "Name", render: (s) => h("span.mono", s.name, " ", s.pending_restart && h("span.badge.warn", "restart pending")) },
      { label: "Value", mono: true, render: (s) => `${s.setting}${s.unit ? " " + s.unit : ""}` },
      { label: "Default", mono: true, render: (s) => (s.setting !== s.boot_val ? s.boot_val : null) },
      { label: "Source", key: "source" }, { label: "Category", key: "category" }, { label: "Description", key: "short_desc", wrap: true },
    ], { empty: "No settings match." }));
  };
  filter.oninput = render;
  changedOnly.onchange = render;
  render();
  return h("div.page", { style: "max-width:none" },
    h("div.page-head", h("h1", "Settings"), h("span.sub", `${all.length} parameters`), h("span.spacer"), h("label.check", changedOnly, "Changed from default"), filter), out);
}

export async function sequencesPage() {
  const seqs = await api("/sequences");
  return h("div.page", h("div.page-head", h("h1", "Sequences"), h("span.sub", `${seqs.length}`)),
    objectTable(seqs, [
      { label: "Sequence", mono: true, render: (s) => `${s.schema}.${s.name}` }, { label: "Type", key: "data_type", mono: true },
      { label: "Last value", num: true, render: (s) => fmtNum(s.last_value) }, { label: "Increment", key: "increment_by", num: true },
      { label: "Min", key: "min_value", num: true }, { label: "Max", key: "max_value", num: true }, { label: "Cycle", render: (s) => (s.cycle ? "yes" : "no") },
    ], { empty: "No sequences." }));
}

export async function typesPage(tree) {
  const kinds = { e: "enum", d: "domain", c: "composite", r: "range" };
  return h("div.page", h("div.page-head", h("h1", "Types"), h("span.sub", `${tree.types.length}`)),
    objectTable(tree.types, [
      { label: "Type", mono: true, render: (t) => `${t.schema}.${t.name}` }, { label: "Kind", render: (t) => kinds[t.kind] ?? t.kind },
      { label: "Definition", wrap: true, mono: true, render: (t) => t.labels ? t.labels.join(" | ") : t.base },
    ], { empty: "No user-defined types." }));
}

export async function databasesPage(onSwitch, onCreated) {
  const dbs = await api("/databases");
  const feedback = h("div");
  const create = async () => {
    const name = await promptDialog({
      title: "New database", label: "Name", confirmLabel: "Create and open", placeholder: "my_app",
      body: "Created on this server with your current role, then opened. Use lowercase letters, digits and underscores.",
    });
    if (!name) return;
    feedback.replaceChildren();
    try { await api("/create/database", { name }); await onCreated(name); } catch (err) { feedback.replaceChildren(errorBox(err)); }
  };
  const open = (d) => async (e) => {
    e.target.disabled = true;
    feedback.replaceChildren();
    try { await onSwitch(d.name); } catch (err) { feedback.replaceChildren(errorBox(err)); e.target.disabled = false; }
  };
  return h("div.page", h("div.page-head", h("h1", "Databases"), h("span.sub", "on this server · switching reuses your current credentials"),
    h("span.spacer"), onCreated && h("button.btn.primary", { onclick: create }, "New database")),
    feedback,
    objectTable(dbs, [
      { label: "Database", render: (d) => h("span.mono", d.name, " ", d.current && h("span.badge.accent", "connected")) },
      { label: "", render: (d) => (d.current ? " " : h("button.btn.small", { onclick: open(d) }, "Open")) },
      { label: "Size", num: true, render: (d) => fmtBytes(d.bytes) }, { label: "Owner", key: "owner", mono: true }, { label: "Encoding", key: "encoding" },
    ]));
}

export { fmtCompact };
