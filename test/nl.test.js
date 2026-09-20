import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../server/nl/compile.js";
import { joinPath } from "../server/nl/model.js";
import { numberCandidates, yearCandidates, textCandidates, resolveWindow, mentionsTime } from "../server/nl/candidates.js";

function table(schema, name, columns) {
  const id = `${schema}.${name}`;
  return [id, {
    id, schema, name, label: name,
    columns: columns.map(([col, kind, isPk = false]) => ({ id: `${id}.${col}`, label: `${name}.${col}`, table: id, name: col, kind, isPk })),
  }];
}

const model = {
  tables: new Map([
    table("shop", "customers", [["id", "number", true], ["name", "text"], ["country", "text"]]),
    table("shop", "orders", [["id", "number", true], ["customer_id", "number"], ["status", "enum"], ["total", "number"], ["ordered_at", "time"]]),
    table("shop", "order_items", [["order_id", "number"], ["product_id", "number"], ["quantity", "number"]]),
    table("shop", "products", [["id", "number", true], ["name", "text"]]),
    table("shop", "audit", [["id", "number", true]]),
  ]),
  edges: [
    { from: "shop.orders", to: "shop.customers", fromColumns: ["customer_id"], toColumns: ["id"] },
    { from: "shop.order_items", to: "shop.orders", fromColumns: ["order_id"], toColumns: ["id"] },
    { from: "shop.order_items", to: "shop.products", fromColumns: ["product_id"], toColumns: ["id"] },
  ],
};

test("rows: filters are parameterized and default limit applies", () => {
  const { sql, params } = compile(model, {
    main: "shop.orders", intent: "rows",
    filters: [{ column: "shop.orders.status", op: "eq", value: "cancelled" }, { column: "shop.orders.total", op: "gt", value: 500 }],
  });
  assert.match(sql, /where "orders"\."status" = \$1\n {2}and "orders"\."total" > \$2/);
  assert.deepEqual(params, ["cancelled", "500"]);
  assert.match(sql, /limit 100$/);
});

test("breakdown across a two-hop join", () => {
  const { sql } = compile(model, {
    main: "shop.customers", joins: ["shop.products"], intent: "breakdown",
    agg: { fn: "sum", column: "shop.order_items.quantity" },
    group: { column: "shop.products.name" }, order: { column: "__measure__", dir: "desc" }, limit: 5,
  });
  assert.match(sql, /left join "shop"\."orders" as "orders" on "customers"\."id" = "orders"\."customer_id"/);
  assert.match(sql, /left join "shop"\."order_items"/);
  assert.match(sql, /left join "shop"\."products"/);
  assert.match(sql, /group by 1\norder by 2 desc nulls last\nlimit 5$/);
});

test("counting the parent of a one-to-many join counts distinct parents", () => {
  const { sql } = compile(model, {
    main: "shop.customers", joins: ["shop.orders"], intent: "count",
    filters: [{ column: "shop.orders.status", op: "eq", value: "paid" }],
  });
  assert.match(sql, /select count\(distinct "customers"\."id"\)/);
  assert.match(sql, /\njoin "shop"\."orders"/, "a filtered table is inner-joined");
});

test("time buckets and ranges", () => {
  const { sql, params } = compile(model, {
    main: "shop.orders", intent: "breakdown", agg: { fn: "count" },
    group: { column: "shop.orders.ordered_at", bucket: "month" },
    time: { column: "shop.orders.ordered_at", from: "2026-01-01", to: "2027-01-01" },
  });
  assert.match(sql, /date_trunc\('month', "orders"\."ordered_at"\)::date as "month"/);
  assert.match(sql, /order by 1 asc/);
  assert.deepEqual(params, ["2026-01-01", "2027-01-01"]);
});

test("a hostile plan cannot reach SQL text", () => {
  const evil = `x"; drop table shop.customers; --`;
  assert.throws(() => compile(model, { main: evil }), /main table/);
  assert.throws(() => compile(model, { main: "shop.orders", intent: "rows", show: [`shop.orders.${evil}`] }), /not part of/);
  assert.throws(() => compile(model, { main: "shop.orders", filters: [{ column: "shop.orders.total", op: "; drop", value: 1 }] }), /operator/);
  assert.throws(() => compile(model, { main: "shop.orders", filters: [{ column: "shop.orders.total", op: "gt", value: "1 or 1=1" }] }), /not a number/);
  assert.throws(() => compile(model, { main: "shop.orders", time: { column: "shop.orders.ordered_at", from: "now()", to: "2026-01-01" } }), /time range/);
  // Columns of tables that are not joined are out of reach, and values only ever travel as parameters.
  assert.throws(() => compile(model, { main: "shop.orders", show: ["shop.products.name"] }), /not part of/);
  const { sql, params } = compile(model, { main: "shop.customers", filters: [{ column: "shop.customers.name", op: "contains", value: evil }] });
  assert.ok(!sql.includes("drop table"));
  assert.equal(params[0], `%${evil}%`);
  // Unknown keywords fall back to safe defaults instead of being interpolated.
  const fallback = compile(model, { main: "shop.orders", intent: "breakdown", agg: { fn: "pg_sleep" }, group: { column: "shop.orders.ordered_at", bucket: "x'); --" }, limit: "5; --" });
  assert.match(fallback.sql, /count\(\*\)/);
  assert.ok(!fallback.sql.includes("--"));
});

test("empty / filled-in conditions", () => {
  const { sql, params } = compile(model, {
    main: "shop.orders", intent: "count",
    filters: [{ column: "shop.orders.ordered_at", op: "is_null" }, { column: "shop.orders.total", op: "not_null", value: "ignored" }],
  });
  assert.match(sql, /"orders"\."ordered_at" is null\n {2}and "orders"\."total" is not null/);
  assert.deepEqual(params, []);
});

test("'is one of' filters bind an array", () => {
  const { sql, params, display } = compile(model, {
    main: "shop.customers", filters: [{ column: "shop.customers.country", op: "in", value: ["Japan", "O'Brien"] }],
  });
  assert.match(sql, /"customers"\."country"::text = any\(\$1::text\[\]\)/);
  assert.deepEqual(params, [["Japan", "O'Brien"]]);
  assert.match(display, /any\(array\['Japan', 'O''Brien'\]::text\[\]\)/);
  assert.throws(() => compile(model, { main: "shop.customers", filters: [{ column: "shop.customers.country", op: "in", value: "Japan" }] }), /at least one/);
});

test("join paths", () => {
  assert.equal(joinPath(model, "shop.customers", "shop.products").length, 3);
  assert.equal(joinPath(model, "shop.orders", "shop.audit"), null);
  const out = compile(model, { main: "shop.orders", joins: ["shop.audit"], intent: "rows" });
  assert.match(out.notes[0], /No foreign-key path/);
});

test("candidates", () => {
  assert.deepEqual(numberCandidates("top five orders over $1,500 or 10k").map((n) => n.value), [1500, 10000, 5]);
  assert.deepEqual(yearCandidates("signups in 2024 vs 2025"), [2024, 2025]);
  const words = new Set(["orders", "order", "customers", "customer", "name"]);
  const texts = textCandidates(`orders from maya patel about "blue lamp"`, words);
  assert.equal(texts[0], "blue lamp");
  assert.ok(texts.includes("maya patel") && texts.includes("maya"));
  assert.deepEqual(textCandidates("show all customers", words), []);
  assert.deepEqual(textCandidates("what about Lisbon instead", words), ["Lisbon"], "follow-up filler is not part of a search term");
  assert.deepEqual(textCandidates("only the ones from those", words), []);
});

test("time questions are only asked when the request has time wording", () => {
  for (const q of ["orders placed today", "revenue by month", "signups in 2024", "sales in March", "last 7 days", "orders since Jan"]) assert.ok(mentionsTime(q), q);
  for (const q of ["orders per status", "how many orders are shipped or delivered", "senior engineers in the Berlin office"]) assert.ok(!mentionsTime(q), q);
});

test("time windows resolve to half-open ranges", () => {
  const now = new Date(Date.UTC(2026, 8, 19)); // Saturday 19 Sep 2026
  assert.deepEqual(resolveWindow("last_month", {}, now), { from: "2026-08-01", to: "2026-09-01" });
  assert.deepEqual(resolveWindow("this_week", {}, now), { from: "2026-09-14", to: "2026-09-21" });
  assert.deepEqual(resolveWindow("last_quarter", {}, now), { from: "2026-04-01", to: "2026-07-01" });
  assert.deepEqual(resolveWindow("last_7_days", {}, now), { from: "2026-09-13", to: "2026-09-20" });
  assert.deepEqual(resolveWindow("named", { month: 2 }, now), { from: "2026-03-01", to: "2026-04-01" });
  assert.deepEqual(resolveWindow("named", { month: 10 }, now), { from: "2025-11-01", to: "2025-12-01" }, "a future month means last year's");
  assert.deepEqual(resolveWindow("named", { year: 2024 }, now), { from: "2024-01-01", to: "2025-01-01" });
  assert.equal(resolveWindow("named", {}, now), null);
});
