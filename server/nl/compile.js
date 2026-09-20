import { quoteIdent } from "../db.js";
import { joinPath } from "./model.js";

const OPS = { eq: "=", neq: "is distinct from", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const AGG_FNS = new Set(["count", "sum", "avg", "min", "max"]);
const BUCKETS = new Set(["day", "week", "month", "quarter", "year"]);
const INTENTS = new Set(["rows", "count", "aggregate", "breakdown", "share"]);
const DEFAULT_ROW_LIMIT = 100;
const MAX_LIMIT = 5_000;

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Compile a query plan into parameterized SQL.
 *
 * The plan is untrusted input (it can come back edited from the browser). Every table
 * and column is resolved through the catalog model, every keyword through a whitelist,
 * and every value is bound as a parameter, so a plan can only ever produce a SELECT
 * over objects that exist.
 */
export function compile(model, plan) {
  const notes = [];
  const main = model.tables.get(plan?.main);
  if (!main) throw fail("The plan has no valid main table");
  const intent = INTENTS.has(plan.intent) ? plan.intent : "rows";

  const columnIndex = new Map();
  const column = (id) => {
    const col = columnIndex.get(id);
    if (!col) throw fail(`Column ${id} is not part of the tables in this query`);
    return col;
  };

  // --- joins ---------------------------------------------------------------
  const used = new Map([[main.id, main]]);
  const steps = [];
  for (const targetId of plan.joins ?? []) {
    if (used.has(targetId) || !model.tables.has(targetId)) continue;
    const path = joinPath(model, main.id, targetId);
    if (!path) {
      notes.push(`No foreign-key path from ${main.label} to ${model.tables.get(targetId).label}; it was left out.`);
      continue;
    }
    for (const step of path) {
      if (used.has(step.right)) continue;
      used.set(step.right, model.tables.get(step.right));
      steps.push(step);
    }
  }
  for (const t of used.values()) for (const c of t.columns) columnIndex.set(c.id, c);

  const aliasCounts = new Map();
  for (const t of used.values()) aliasCounts.set(t.name, (aliasCounts.get(t.name) ?? 0) + 1);
  const alias = (tableId) => {
    const t = used.get(tableId);
    return quoteIdent(aliasCounts.get(t.name) > 1 ? `${t.schema}_${t.name}` : t.name);
  };
  const ref = (col) => `${alias(col.table)}.${quoteIdent(col.name)}`;

  // --- where ---------------------------------------------------------------
  const params = [];
  const bareParams = new Set(); // parameters that are safe to show unquoted
  const bind = (value, bare = false) => {
    const n = params.push(value);
    if (bare) bareParams.add(n);
    return `$${n}`;
  };
  const where = [];
  const filteredTables = new Set();

  // Conditions flagged `or` are alternatives: they compile into one parenthesised group that is
  // ANDed with everything else. Exclusions are NULL-safe, so "not cancelled" keeps rows with no status.
  const alternatives = [];
  const part = [];
  const partAlternatives = [];
  for (const f of plan.filters ?? []) {
    const col = column(f.column);
    const like = () => bind(`%${String(f.value).replace(/[\\%_]/g, "\\$&")}%`);
    const list = () => {
      const values = Array.isArray(f.value) ? f.value.map(String).slice(0, 50) : [];
      if (!values.length) throw fail("A list filter needs at least one value");
      return bind(values);
    };
    let clause;
    if (f.op === "is_null" || f.op === "not_null") clause = `${ref(col)} is ${f.op === "is_null" ? "" : "not "}null`;
    else if (f.op === "in") clause = `${ref(col)}::text = any(${list()}::text[])`;
    else if (f.op === "not_in") clause = `(${ref(col)} is null or ${ref(col)}::text <> all(${list()}::text[]))`;
    else if (f.op === "contains") clause = `${ref(col)}::text ilike ${like()}`;
    else if (f.op === "not_contains") clause = `(${ref(col)} is null or ${ref(col)}::text not ilike ${like()})`;
    else if (OPS[f.op]) {
      if (col.kind === "number" && !Number.isFinite(Number(f.value))) throw fail(`${f.value} is not a number`);
      clause = `${ref(col)} ${OPS[f.op]} ${bind(String(f.value), col.kind === "number")}`;
    } else throw fail(`Unknown filter operator ${f.op}`);

    // For a percentage, conditions flagged `part` are what is being measured; they go into the
    // numerator and must not narrow the set the percentage is taken of.
    const measured = intent === "share" && f.part === true;
    if (f.or === true) (measured ? partAlternatives : alternatives).push(clause);
    else if (measured) part.push(clause);
    else {
      where.push(clause);
      // Only a condition every row must meet justifies an inner join. An alternative must not drop
      // rows that lack the joined record, because they may still satisfy another alternative.
      filteredTables.add(col.table);
    }
  }
  if (alternatives.length === 1) where.push(alternatives[0]);
  else if (alternatives.length > 1) where.push(`(${alternatives.join("\n    or ")})`);
  if (partAlternatives.length === 1) part.push(partAlternatives[0]);
  else if (partAlternatives.length > 1) part.push(`(${partAlternatives.join(" or ")})`);

  if (plan.time?.column) {
    const col = column(plan.time.column);
    const { from, to } = plan.time;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw fail("Invalid time range");
    filteredTables.add(col.table);
    where.push(`${ref(col)} >= ${bind(from)}`, `${ref(col)} < ${bind(to)}`);
  }

  // --- from ----------------------------------------------------------------
  let fanOut = false;
  const from = [`from ${quoteIdent(main.schema)}.${quoteIdent(main.name)} as ${alias(main.id)}`];
  for (const s of steps) {
    const right = used.get(s.right);
    // Walking from a referenced table down to the table that references it multiplies rows.
    if (model.edges.some((e) => e.from === s.right && e.to === s.left)) fanOut = true;
    const on = s.leftColumns
      .map((lc, i) => `${alias(s.left)}.${quoteIdent(lc)} = ${alias(s.right)}.${quoteIdent(s.rightColumns[i])}`)
      .join(" and ");
    const kind = filteredTables.has(s.right) ? "join" : "left join";
    from.push(`${kind} ${quoteIdent(right.schema)}.${quoteIdent(right.name)} as ${alias(s.right)} on ${on}`);
  }

  // --- measure -------------------------------------------------------------
  const mainPk = main.columns.filter((c) => c.isPk);
  const countRows = fanOut && mainPk.length === 1 ? `count(distinct ${ref(mainPk[0])})` : "count(*)";
  let measure = countRows;
  let measureName = "count";
  if (intent === "aggregate" || intent === "breakdown") {
    const fn = AGG_FNS.has(plan.agg?.fn) ? plan.agg.fn : "count";
    const aggCol = plan.agg?.column ? column(plan.agg.column) : null;
    if (fn !== "count" && aggCol) {
      measure = `${fn}(${ref(aggCol)})`;
      measureName = `${fn}_${aggCol.name}`;
      if (fanOut && aggCol.table === main.id) {
        notes.push(`Joining a one-to-many table repeats ${main.label} rows, which can inflate ${fn}(${aggCol.label}).`);
      }
    } else if (fn !== "count") {
      notes.push(`No numeric column was identified for ${fn}; counting rows instead.`);
    }
  }

  // --- select / group / order ----------------------------------------------
  const parts = [];
  const dir = plan.order?.dir === "asc" ? "asc" : "desc";
  let limit = Number.isInteger(plan.limit) && plan.limit > 0 ? Math.min(plan.limit, MAX_LIMIT) : null;

  if (intent === "share") {
    if (!part.length) throw fail("A percentage needs a condition to measure, such as a status");
    const counted = fanOut && mainPk.length === 1 ? `count(distinct ${ref(mainPk[0])})` : "count(*)";
    const matching = `${counted} filter (where ${part.join(" and ")})`;
    parts.push(`select ${matching} as "matching", ${counted} as "total",\n       round(100.0 * ${matching} / nullif(${counted}, 0), 1) as "percent"`, ...from);
    if (where.length) parts.push(`where ${where.join("\n  and ")}`);
    limit = null;
  } else if (intent === "count" || intent === "aggregate") {
    parts.push(`select ${measure} as ${quoteIdent(measureName)}`, ...from);
    if (where.length) parts.push(`where ${where.join("\n  and ")}`);
    limit = null;
  } else if (intent === "breakdown") {
    if (!plan.group?.column) throw fail("A breakdown needs a column to group by");
    const groupCol = column(plan.group.column);
    const bucket = groupCol.kind === "time" && BUCKETS.has(plan.group.bucket) ? plan.group.bucket : null;
    const groupExpr = bucket ? `date_trunc('${bucket}', ${ref(groupCol)})::date` : ref(groupCol);
    parts.push(`select ${groupExpr} as ${quoteIdent(bucket ?? groupCol.name)}, ${measure} as ${quoteIdent(measureName)}`, ...from);
    if (where.length) parts.push(`where ${where.join("\n  and ")}`);
    parts.push("group by 1");
    const orderTarget = plan.order?.column;
    if (orderTarget === "__measure__") parts.push(`order by 2 ${dir} nulls last`);
    else if (orderTarget === groupCol.id || bucket) parts.push(`order by 1 ${orderTarget ? dir : "asc"}`);
    else parts.push("order by 2 desc nulls last");
    limit ??= 500;
  } else {
    const shown = (plan.show ?? []).map(column);
    const list = shown.length ? shown.map(ref).join(", ") : `${alias(main.id)}.*`;
    parts.push(`select ${list}`, ...from);
    if (where.length) parts.push(`where ${where.join("\n  and ")}`);
    if (plan.order?.column && plan.order.column !== "__measure__") {
      parts.push(`order by ${ref(column(plan.order.column))} ${dir} nulls last`);
    }
    limit ??= DEFAULT_ROW_LIMIT;
  }
  if (limit) parts.push(`limit ${limit}`);

  const sql = parts.join("\n");
  return { sql, params, display: inlineParams(sql, params, bareParams), notes };
}

/** Human-readable SQL with literals inlined, for display and for sending to the editor. */
export function inlineParams(sql, params, bareParams = new Set()) {
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const raw = params[Number(n) - 1];
    if (Array.isArray(raw)) return `array[${raw.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(", ")}]`;
    const v = String(raw);
    return bareParams.has(Number(n)) && /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
  });
}
