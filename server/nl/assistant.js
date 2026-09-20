// The conversational layer around the planner. Jev returns judgments, not prose, so every
// sentence the assistant says is composed here from the plan and the result.

const words = (name) => String(name).replace(/_/g, " ");
const num = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return String(v ?? "null");
  return n.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
};
const OP_WORDS = { eq: "is", neq: "is not", gt: "over", gte: "at least", lt: "under", lte: "at most", contains: "contains", not_contains: "does not contain" };
const FN_WORDS = { count: "Count", sum: "Total", avg: "Average", min: "Lowest", max: "Highest" };

function columnOf(model, id) {
  const tableId = id.split(".").slice(0, -1).join(".");
  return model.tables.get(tableId)?.columns.find((c) => c.id === id);
}

const singular = (w) => w.replace(/ies$/, "y").replace(/(ss|us)$/, "$1").replace(/([^s])s$/, "$1");

/** A column in words. Generic names carry their table, so "name" reads as "department name". */
function columnWords(model, id) {
  const col = columnOf(model, id);
  const name = words(col?.name ?? id.split(".").pop());
  if (!col || !/^(name|title|label|code|id|type|kind|status|state|email)$/i.test(col.name)) return name;
  const table = model.tables.get(col.table);
  return table ? `${singular(words(table.name))} ${name}` : name;
}

/** The plan's conditions as short phrases: ["status is cancelled", "total amount over 500"]. */
export function conditionPhrases(model, plan) {
  const phrases = (plan.filters ?? []).map((f) => {
    const generic = columnOf(model, f.column)?.table !== plan.main;
    const name = generic ? columnWords(model, f.column) : words(f.column.split(".").pop());
    if (f.op === "is_null") return `no ${name}`;
    if (f.op === "not_null") return `${name} set`;
    if (f.op === "in") return `${name} is ${f.value.slice(0, -1).join(", ")} or ${f.value.at(-1)}`;
    if (f.op === "not_in") return `${name} is not ${f.value.slice(0, -1).join(", ")} or ${f.value.at(-1)}`;
    return `${name} ${OP_WORDS[f.op] ?? f.op} ${typeof f.value === "number" ? num(f.value) : f.value}`;
  });
  if (plan.time) phrases.push(`${words(plan.time.column.split(".").pop())} within ${plan.time.window}`);
  return phrases;
}

/** All conditions as one phrase. Alternatives read as "either A or B"; the rest are joined by commas. */
export function conditionsText(model, plan) {
  const phrases = conditionPhrases(model, plan);
  const filters = plan.filters ?? [];
  const either = phrases.filter((_, i) => filters[i]?.or === true);
  const rest = phrases.filter((_, i) => filters[i]?.or !== true);
  const parts = [...rest];
  if (either.length > 1) parts.unshift(`either ${either.join(" or ")}`);
  else parts.unshift(...either);
  return parts.join(", ");
}

/** One or two sentences describing what was found, plus a headline figure for single-number answers. */
export function summarize(model, plan, result, error) {
  const main = model.tables.get(plan.main);
  const noun = words(main?.name ?? "rows");
  const where = conditionsText(model, plan);
  const scope = where ? ` where ${where}` : "";
  if (error || !result) return { text: `I built a query for ${noun}${scope}, but Postgres rejected it.`, headline: null };

  const rows = result.rows;
  if (plan.intent === "share") {
    const [matching, total, percent] = rows[0] ?? [0, 0, null];
    const measured = conditionsText(model, { ...plan, filters: plan.filters.filter((f) => f.part), time: null });
    const base = conditionsText(model, { ...plan, filters: plan.filters.filter((f) => !f.part) });
    const of = `${noun}${base ? ` where ${base}` : ""}`;
    if (!Number(total)) return { headline: null, text: `There are no ${of}, so there is no percentage to give.` };
    return { headline: `${num(percent)}%`, text: `${num(matching)} of ${num(total)} ${of}: ${measured}` };
  }
  if (plan.intent === "count") {
    const n = rows[0]?.[0] ?? 0;
    return { headline: num(n), text: `${noun}${scope}`, unit: null };
  }
  if (plan.intent === "aggregate") {
    const col = plan.agg?.column ? words(plan.agg.column.split(".").pop()) : noun;
    const label = plan.agg?.fn === "sum" && /^(total|sum)\b/i.test(col) ? col.replace(/^./, (ch) => ch.toUpperCase())
      : `${FN_WORDS[plan.agg?.fn] ?? "Value"} ${plan.agg?.fn === "count" ? "of " : ""}${col}`;
    return { headline: num(rows[0]?.[0]), text: `${label} across ${noun}${scope}` };
  }
  if (plan.intent === "breakdown") {
    const groupCol = columnOf(model, plan.group.column);
    const group = groupCol?.table === plan.main ? words(groupCol.name) : columnWords(model, plan.group.column);
    const bucket = plan.group.bucket ? `${plan.group.bucket} (${group})` : group;
    const aggName = plan.agg?.column ? words(plan.agg.column.split(".").pop()) : "";
    const stutters = plan.agg?.fn === "sum" && /^(total|sum)\b/i.test(aggName); // "total total amount"
    const measure = plan.agg?.fn && plan.agg.fn !== "count" && plan.agg.column
      ? (stutters ? aggName : `${FN_WORDS[plan.agg.fn].toLowerCase()} ${aggName}`) : `number of ${noun}`;
    if (!rows.length) return { headline: null, text: `No ${noun} found${scope}, so there is nothing to break down.` };
    const lead = rows[0];
    const ordered = plan.order?.column === "__measure__" || (!plan.order && !plan.group.bucket);
    const top = ordered ? ` ${lead[0] ?? "null"} leads with ${num(lead[1])}.` : "";
    return { headline: null, text: `The ${measure} by ${bucket}${scope}: ${rows.length} ${rows.length === 1 ? "group" : "groups"}.${top}` };
  }
  if (!rows.length) return { headline: null, text: `No ${noun} found${scope}.` };
  const capped = plan.limit == null && rows.length >= 100;
  const sorted = plan.order?.column ? `, sorted by ${words(plan.order.column.split(".").pop())}` : "";
  return {
    headline: null,
    text: `${capped ? `The first ${rows.length}` : num(rows.length)} ${rows.length === 1 ? singular(noun) : noun}${scope}${sorted}.${capped ? " There may be more: set a limit or add a condition to narrow it." : ""}`,
  };
}

const KIND_WORDS = { r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table" };

/** "What's in this database?" — answered from the catalog model, no query needed. */
export function catalogAnswer(model) {
  const tables = [...model.tables.values()].sort((a, b) => (b.estRows ?? 0) - (a.estRows ?? 0));
  const schemas = new Set(tables.map((t) => t.schema));
  const counts = tables.reduce((acc, t) => ((acc[KIND_WORDS[t.kind]] = (acc[KIND_WORDS[t.kind]] ?? 0) + 1), acc), {});
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  const biggest = tables.filter((t) => t.estRows > 0).slice(0, 3).map((t) => `${t.label} (~${num(t.estRows)} rows)`);
  return {
    summary: {
      headline: null,
      text: `This database has ${parts.join(" and ")} in ${schemas.size} schema${schemas.size === 1 ? "" : "s"}.` +
        (biggest.length ? ` The largest are ${biggest.join(", ")}.` : "") + " Ask about any of them, or open one from the sidebar.",
    },
    result: {
      fields: ["table", "type", "rows (est.)", "columns", "links to", "description"].map((name) => ({ name, typeId: name === "rows (est.)" || name === "columns" ? 23 : 25 })),
      rows: tables.map((t) => [
        t.label, KIND_WORDS[t.kind], t.estRows >= 0 && "rpm".includes(t.kind) ? t.estRows : "—", t.columns.length,
        [...new Set(t.columns.filter((c) => c.references).map((c) => c.references.split(".").slice(0, -1).join(".")))].join(", ") || "—",
        t.comment ?? "—",
      ]),
      links: tables.map((t) => ({ schema: t.schema, name: t.name })),
      ms: 0, truncated: false,
    },
  };
}

/** "What columns does orders have?" — the table's structure. */
export function describeAnswer(table) {
  const keys = table.columns.filter((c) => c.isPk).map((c) => c.name);
  const refs = table.columns.filter((c) => c.references);
  return {
    summary: {
      headline: null,
      text: `${table.label} is a ${KIND_WORDS[table.kind]} with ${table.columns.length} columns` +
        (table.estRows > 0 ? ` and about ${num(table.estRows)} rows` : "") + "." +
        (table.comment ? ` ${table.comment}.` : "") +
        (keys.length ? ` Its key is ${keys.join(", ")}.` : "") +
        (refs.length ? ` It links to ${[...new Set(refs.map((c) => c.references.split(".").slice(0, -1).join(".")))].join(", ")}.` : ""),
    },
    result: {
      fields: ["column", "type", "nullable", "references", "known values", "description"].map((name) => ({ name, typeId: 25 })),
      rows: table.columns.map((c) => [
        (c.isPk ? "⚷ " : "") + c.name, c.type, c.nullable ? "yes" : "no", c.references ?? "—",
        c.values ? c.values.slice(0, 8).join(", ") + (c.values.length > 8 ? ", …" : "") : "—", c.comment ?? "—",
      ]),
      open: { schema: table.schema, name: table.name },
      ms: 0, truncated: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Suggestions tailored to the connected database, derived from its schema in code.
// ---------------------------------------------------------------------------
const PLUMBING = /^_|migration|schema_version|knex|flyway|alembic|drizzle|prisma|ar_internal|sessions?$|tokens?$|_log$|_logs$/i;
const isMeasure = (c) => c.kind === "number" && !c.isPk && !c.references && !/(^|_)(id|no|number|code|zip|year|version|position|sort|order)$/i.test(c.name);

const referencedBy = (model, t) => (model.edges ?? []).filter((e) => e.to === t.id && e.from !== t.id).length;

export function suggestions(model, limit = 8) {
  const tables = [...model.tables.values()]
    .filter((t) => "rp".includes(t.kind) && !PLUMBING.test(t.name) && t.columns.length > 1)
    // Biggest first. On a database that was never ANALYZEd every size is unknown, so fall back to how
    // many tables point at each one: the most referenced tables are the core entities.
    .sort((a, b) => Math.max(b.estRows ?? 0, 0) - Math.max(a.estRows ?? 0, 0) || referencedBy(model, b) - referencedBy(model, a));
  // Several rounds over the tables so the list mixes subjects instead of exhausting one table first.
  const perTable = tables.slice(0, 6).map((t) => {
    const noun = words(t.name);
    // A grouping column should read like a label (status, role, country), not free text.
    const categories = t.columns.filter((c) => c.values && c.kind !== "boolean" && c.values.length >= 2 && c.values.length <= 12
      && !/body|text|note|comment|description|message|title|name$/i.test(c.name) && c.values.every((v) => v.length <= 24));
    const category = categories.find((c) => c.kind === "enum" || /status|state|type|kind|role|level|segment|stage|plan|tier/i.test(c.name)) ?? categories[0];
    const flag = t.columns.find((c) => c.kind === "boolean");
    const measure = t.columns.find(isMeasure);
    const time = t.columns.find((c) => c.kind === "time" && /creat|order|start|occur|issued|hired|date|_at$|_on$/i.test(c.name)) ?? t.columns.find((c) => c.kind === "time");
    const optionalTime = t.columns.find((c) => c.kind === "time" && c.nullable && c !== time);
    const out = [];
    if (category) out.push(`${noun} per ${words(category.name)}`);
    if (measure && category) out.push(`${/^(total|sum)/i.test(measure.name) ? "" : "total "}${words(measure.name)} by ${words(category.name)}`);
    else if (measure) out.push(`average ${words(measure.name)} of ${noun}`);
    if (time) out.push(`number of ${noun} per month this year`);
    // "are paid" suits a status; a place needs "in Brazil"; anything else is left out rather than phrased badly.
    const sample = category?.values[Math.min(1, category.values.length - 1)];
    if (category && /status|state$|stage|level|role|segment|tier|kind|type/i.test(category.name)) out.push(`how many ${noun} are ${sample}`);
    else if (category && /country|city|region|location|office/i.test(category.name)) out.push(`${noun} in ${sample}`);
    if (time) out.push(`latest 10 ${noun}`);
    if (optionalTime) out.push(`${noun} with no ${words(optionalTime.name)}`);
    if (flag) out.push(`how many ${noun} are ${words(flag.name)}`);
    if (!out.length) out.push(`how many ${noun} are there`);
    return out;
  // Rotate each table's list by its position so the first round is not the same question shape six times.
  }).map((list, i) => list.map((_, k) => list[(k + i) % list.length]));
  // At most two questions of any one shape, so the row is a spread of ideas rather than one idea repeated.
  const shapeOf = (q) => q.replace(/^(how many|latest 10|number of|average|total)\b.*?( per month this year| are there| with no .*| by .*| per .*| in .*| are .*| of .*)?$/i, "$1|$2");
  const shapes = new Map();
  const mixed = ["what's in this database"];
  const rounds = Math.max(0, ...perTable.map((list) => list.length));
  for (let round = 0; round < rounds && mixed.length < limit; round++) {
    for (const list of perTable) {
      const q = list[round];
      if (!q || mixed.length >= limit || mixed.includes(q)) continue;
      const shape = shapeOf(q);
      if ((shapes.get(shape) ?? 0) >= 2) continue;
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      mixed.push(q);
    }
  }
  return mixed;
}
