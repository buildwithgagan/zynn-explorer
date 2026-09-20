/** Tiny hyperscript: h("div.panel", { onclick }, child, …). Text children are always escaped. */
export function h(spec, ...args) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const arg of args.flat(Infinity)) {
    if (arg == null || arg === false) continue;
    if (arg instanceof Node) el.append(arg);
    else if (typeof arg === "object") {
      for (const [k, v] of Object.entries(arg)) {
        if (v == null || v === false) continue;
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "class") el.className += " " + v;
        else if (k === "html") el.innerHTML = v; // only ever used with output of highlightSql (escaped)
        else if (k in el && k !== "list") el[k] = v;
        else el.setAttribute(k, v);
      }
    } else el.append(String(arg));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Build an inline SVG: svg("0 0 24 24", 16, [["path", { d }]], { fill: "none" }). */
export function svg(viewBox, size, children, attrs = {}) {
  const el = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox, width: size, height: size, "aria-hidden": "true", ...attrs })) el.setAttribute(k, v);
  for (const [tag, a] of children) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) child.setAttribute(k, v);
    el.append(child);
  }
  return el;
}

// The Zynn mark. Same path data as the Zynn Console's app/icon.svg and sidebar lockup.
const ZYNN_MARK = "M17 6H25L15 26H7Z M7 6H13L10 12H4Z M22 20H28L25 26H19Z";
export const zynnMark = (size = 18) => svg("0 0 32 32", size, [["path", { d: ZYNN_MARK, fill: "currentColor" }]]);
const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round" };
export const lineIcon = (paths, size = 16) => svg("0 0 24 24", size, paths.map((d) => ["path", { d }]), STROKE);

export async function api(path, body, method) {
  const res = await fetch("/api" + path, body === undefined ? { method: method ?? "GET" } : {
    method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? "Request failed"), data);
  return data;
}

export const enc = encodeURIComponent;

export function fmtBytes(n) {
  if (n == null) return "—";
  n = Number(n);
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtNum(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v < 0) return "—"; // reltuples is -1 before the first ANALYZE
  return v.toLocaleString("en-US");
}

export function fmtCompact(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  if (v < 0) return "?";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

export function fmtTime(t) {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString();
}

export const KIND_NAMES = { r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table" };

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SQL_TOKEN = new RegExp(
  "(--[^\\n]*)|('(?:[^']|'')*')|(&quot;(?:(?!&quot;).)*&quot;)|\\b(select|from|where|and|or|not|null|is|in|as|on|join|left|right|inner|outer|full|cross|lateral|group|order|by|having|limit|offset|union|all|distinct|case|when|then|else|end|create|table|view|materialized|index|unique|primary|key|foreign|references|constraint|default|check|insert|into|values|update|set|delete|returning|with|asc|desc|nulls|last|first|ilike|like|between|exists|function|returns|language|trigger|before|after|for|each|row|execute|begin|commit|rollback|explain|analyze|generated|always|identity|stored|partition|comment|alter|drop|grant|revoke|using|cascade|count|sum|avg|min|max|date_trunc|coalesce)\\b|\\b(\\d+(?:\\.\\d+)?)\\b",
  "gi"
);

/** Minimal SQL highlighter. Input is escaped first and tokenized in one pass; returns safe HTML. */
export function highlightSql(sql) {
  return escapeHtml(sql ?? "").replace(SQL_TOKEN, (m, comment, string, ident, keyword, number) => {
    if (ident) return m;
    const cls = comment ? "cmt" : string ? "str" : keyword ? "kw" : number ? "numlit" : null;
    return cls ? `<span class="${cls}">${m}</span>` : m;
  });
}

export const codeBlock = (sql) => h("pre.code", { html: highlightSql(sql) });

// Postgres type OIDs rendered right-aligned as numbers.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);

function cellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Render a { fields, rows } result (rows as arrays). */
export function resultTable(result, { onSort, sort, dir, types, startAt = 0 } = {}) {
  if (!result.fields?.length) {
    return h("div.panel.empty", `${result.command ?? "OK"}${result.rowCount != null ? ` · ${fmtNum(result.rowCount)} rows affected` : ""}`);
  }
  const head = h("tr", h("th", ""), result.fields.map((f) =>
    h(`th${onSort ? ".sortable" : ""}`, { onclick: onSort && (() => onSort(f.name)) },
      f.name, sort === f.name ? (dir === "desc" ? " ↓" : " ↑") : "",
      types?.[f.name] && h("span.type", types[f.name]))));
  const body = result.rows.map((row, i) =>
    h("tr", h("td.rownum", startAt + i + 1), row.map((v, c) => {
      const text = cellText(v);
      if (text === null) return h("td.null", "null");
      const numeric = NUMERIC_OIDS.has(result.fields[c].typeId);
      return h(numeric ? "td.num" : "td", { title: text.length > 40 ? text.slice(0, 2000) : null }, text.length > 300 ? text.slice(0, 300) + "…" : text);
    })));
  return h("div.table-wrap", h("table.grid.data", h("thead", head), h("tbody", body)));
}

/** Render an array of objects with a column spec: [{ key, label, render?, num? }]. */
export function objectTable(rows, columns, { empty = "Nothing here." } = {}) {
  if (!rows?.length) return h("div.panel.empty", empty);
  return h("div.table-wrap", h("table.grid",
    h("thead", h("tr", columns.map((c) => h("th", c.label)))),
    h("tbody", rows.map((r) => h("tr", columns.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      if (v == null || v === "") return h("td.null", "—");
      return h(`td${c.num ? ".num" : ""}${c.wrap ? ".wrap" : ""}${c.mono ? ".mono" : ""}`, v);
    }))))));
}

export function toCsv(result) {
  const quote = (v) => {
    const s = cellText(v) ?? "";
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [result.fields.map((f) => quote(f.name)).join(","), ...result.rows.map((r) => r.map(quote).join(","))].join("\n");
}

export function download(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const loading = (label = "Loading") => h("div.loading", label);
export const errorBox = (err) => h("div.error", err.message + (err.hint ? `\nHint: ${err.hint}` : "") + (err.detail ? `\n${err.detail}` : ""));

/** Mount an async view: shows a spinner, then the view or an error. */
export async function mount(container, build) {
  container.replaceChildren(loading());
  try {
    const view = await build();
    container.replaceChildren(view);
  } catch (err) {
    container.replaceChildren(errorBox(err));
  }
}

export function tabs(defs, initial) {
  const body = h("div");
  const bar = h("div.tabs");
  const select = (def) => {
    for (const b of bar.children) b.classList.toggle("active", b.dataset.id === def.id);
    const out = def.render();
    if (out instanceof Promise) mount(body, () => out);
    else body.replaceChildren(out);
  };
  for (const def of defs) {
    bar.append(h("button", { "data-id": def.id, onclick: () => select(def) }, def.label, def.count != null && h("span.n", def.count)));
  }
  select(defs.find((d) => d.id === initial) ?? defs[0]);
  return h("div", bar, body);
}
