import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, catalogAnswer, describeAnswer, suggestions } from "../server/nl/assistant.js";

const col = (table, name, kind = "text", extra = {}) => ({ id: `${table}.${name}`, table, name, kind, type: kind, ...extra });
function table(id, estRows, columns, extra = {}) {
  const [schema, name] = id.split(".");
  return [id, { id, schema, name, label: name, kind: "r", estRows, comment: null, columns: columns.map((c) => col(id, ...c)), ...extra }];
}
const model = {
  tables: new Map([
    table("shop.orders", 6000, [["id", "number", { isPk: true }], ["customer_id", "number", { references: "customers.id" }],
      ["status", "enum", { values: ["pending", "paid", "cancelled"] }], ["total_amount", "number"], ["ordered_at", "time"], ["shipped_at", "time", { nullable: true }]]),
    table("shop.customers", 400, [["id", "number", { isPk: true }], ["name", "text"], ["country", "text", { values: ["Japan", "Brazil", "India"] }]]),
    table("shop.reviews", 1500, [["id", "number", { isPk: true }], ["rating", "number"], ["body", "text", { values: ["Great value", "Love it"] }]]),
    table("shop._migrations", 9000, [["id", "number", { isPk: true }], ["name", "text"]]),
  ]),
};

test("single-number answers get a headline and a caption", () => {
  const s = summarize(model, { main: "shop.orders", intent: "count", filters: [{ column: "shop.orders.status", op: "eq", value: "cancelled" }], time: { column: "shop.orders.ordered_at", window: "this year" } }, { rows: [[403]] });
  assert.equal(s.headline, "403");
  assert.equal(s.text, "orders where status is cancelled, ordered at within this year");
  const total = summarize(model, { main: "shop.orders", intent: "aggregate", agg: { fn: "sum", column: "shop.orders.total_amount" } }, { rows: [["182339.61"]] });
  assert.equal(total.headline, "182,339.61");
  assert.equal(total.text, "Total amount across orders", "no 'Total total amount'");
});

test("lists, breakdowns and empty results read as sentences", () => {
  const plan = { main: "shop.orders", intent: "breakdown", agg: { fn: "count" }, group: { column: "shop.customers.name" }, order: { column: "__measure__" }, filters: [] };
  assert.equal(summarize(model, plan, { rows: [["Priya Berg", 12], ["Leo Berg", 9]] }).text, "The number of orders by customer name: 2 groups. Priya Berg leads with 12.");
  assert.equal(summarize(model, { main: "shop.customers", intent: "rows", filters: [{ column: "shop.customers.country", op: "in", value: ["Japan", "Brazil"] }] }, { rows: [] }).text,
    "No customers found where country is Japan or Brazil.");
  assert.match(summarize(model, { main: "shop.orders", intent: "rows", filters: [{ column: "shop.orders.shipped_at", op: "is_null" }] }, { rows: Array(100).fill([1]) }).text, /^The first 100 orders where no shipped at\. There may be more/);
  assert.match(summarize(model, { main: "shop.orders", intent: "rows", filters: [] }, null, "syntax error").text, /Postgres rejected it/);
});

test("catalog and structure answers come from the model alone", () => {
  const c = catalogAnswer(model);
  assert.match(c.summary.text, /^This database has 4 tables in 1 schema\./);
  assert.equal(c.result.rows.length, 4);
  assert.deepEqual(c.result.links[0], { schema: "shop", name: "_migrations" }, "sorted by size");
  const d = describeAnswer(model.tables.get("shop.orders"));
  assert.match(d.summary.text, /orders is a table with 6 columns and about 6,000 rows\. Its key is id\. It links to customers\./);
  assert.equal(d.result.rows.find((r) => r[0] === "status")[4], "pending, paid, cancelled");
});

test("suggestions are built from this schema and skip plumbing and free text", () => {
  const list = suggestions(model);
  assert.equal(list[0], "what's in this database");
  assert.ok(list.includes("orders per status"));
  assert.ok(list.includes("total amount by status"), "no 'total total amount'");
  assert.ok(list.includes("how many orders are paid"), "status values read as adjectives");
  assert.ok(list.includes("customers in Brazil"), "places read as places, not 'customers are Brazil'");
  assert.ok(suggestions(model, 20).includes("orders with no shipped at"));
  assert.ok(list.some((q) => q.includes("customers")));
  assert.ok(!list.some((q) => /migrations/.test(q)), "migration tables are not suggested");
  assert.ok(!list.some((q) => /per body|per name/.test(q)), "free-text columns are not grouping suggestions");
  assert.equal(new Set(list).size, list.length);
  assert.deepEqual(suggestions({ tables: new Map() }), ["what's in this database"]);
});
