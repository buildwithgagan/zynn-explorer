import { test } from "node:test";
import assert from "node:assert/strict";
import { validContext, mergeFollowUp, describePlan, conditionList } from "../server/nl/followup.js";

const col = (table, name, kind = "text", extra = {}) => ({ id: `${table}.${name}`, label: `${table.split(".")[1]}.${name}`, table, name, kind, ...extra });
function table(id, columns) {
  const [schema, name] = id.split(".");
  return [id, { id, schema, name, label: name, kind: "r", columns: columns.map((c) => col(id, ...c)) }];
}
const model = {
  tables: new Map([
    table("shop.orders", [["id", "number", { isPk: true }], ["customer_id", "number"], ["status", "enum"], ["total", "number"], ["ordered_at", "time"]]),
    table("shop.customers", [["id", "number", { isPk: true }], ["name", "text"], ["country", "text"]]),
  ]),
  edges: [{ from: "shop.orders", to: "shop.customers", fromColumns: ["customer_id"], toColumns: ["id"] }],
};
const status = (value) => ({ column: "shop.orders.status", op: "eq", value });
const lastMonth = { column: "shop.orders.ordered_at", from: "2026-08-01", to: "2026-09-01", window: "last month" };
const prevCount = { main: "shop.orders", joins: [], intent: "count", filters: [], show: [], limit: null, order: null, time: lastMonth };
const fresh = (over = {}) => ({ main: "shop.orders", joins: [], intent: "rows", filters: [], show: [], limit: null, order: null, time: null, ...over });

test("context from the browser is only trusted if it compiles against the catalog", () => {
  const ok = validContext(model, { request: "how many orders last month", plan: prevCount });
  assert.equal(ok.reading, "a count of orders where ordered at within last month");
  assert.deepEqual(ok.conditions.map((c) => c.kind), ["time"]);
  assert.equal(validContext(model, { request: "x", plan: { ...prevCount, main: 'shop.orders"; drop table x; --' } }), null);
  assert.equal(validContext(model, { request: "x", plan: { ...prevCount, filters: [{ column: "shop.secrets.token", op: "eq", value: 1 }] } }), null);
  assert.equal(validContext(model, { request: "x", plan: { ...prevCount, filters: [{ column: "shop.orders.total", op: "; drop", value: 1 }] } }), null);
  assert.equal(validContext(model, { plan: prevCount }), null, "needs the previous question too");
  assert.equal(validContext(model, null), null);
});

test("'only the cancelled ones' narrows and keeps the shape and the time range", () => {
  const plan = mergeFollowUp({ prev: prevCount, fresh: fresh({ filters: [status("cancelled")] }), shape: "keep" });
  assert.equal(plan.intent, "count");
  assert.deepEqual(plan.filters.map((f) => f.value), ["cancelled"]);
  assert.equal(plan.time.window, "last month");
  assert.equal(plan.time.carried, true);
});

test("'what about this year' replaces the time range; a new value replaces the old one on the same column", () => {
  const thisYear = { column: "shop.orders.ordered_at", from: "2026-01-01", to: "2027-01-01", window: "this year" };
  const prev = { ...prevCount, filters: [status("cancelled")] };
  const a = mergeFollowUp({ prev, fresh: fresh({ time: thisYear }), shape: "keep" });
  assert.equal(a.time.window, "this year");
  assert.deepEqual(a.filters.map((f) => f.value), ["cancelled"], "other conditions carry over");
  const b = mergeFollowUp({ prev, fresh: fresh({ filters: [status("refunded")] }), shape: "keep" });
  assert.deepEqual(b.filters.map((f) => f.value), ["refunded"], "not cancelled AND refunded");
});

test("'show them' and 'how many is that' change the shape and keep the conditions", () => {
  const prev = { ...prevCount, filters: [status("cancelled")] };
  const list = mergeFollowUp({ prev, fresh: fresh(), shape: "rows" });
  assert.equal(list.intent, "rows");
  assert.equal(list.filters.length, 1);
  const prevList = { ...prev, intent: "rows", limit: 10, order: { column: "shop.orders.total", dir: "desc" } };
  const count = mergeFollowUp({ prev: prevList, fresh: fresh({ intent: "count" }), shape: "count" });
  assert.equal(count.intent, "count");
  assert.equal(count.limit, null);
  assert.equal(count.order, null);
});

test("'break that down by country' keeps the calculation; 'just the top 5' keeps the grouping", () => {
  const prevTotal = { ...prevCount, intent: "aggregate", agg: { fn: "sum", column: "shop.orders.total" } };
  const byCountry = fresh({ intent: "breakdown", joins: ["shop.customers"], agg: { fn: "count", column: null }, group: { column: "shop.customers.country", bucket: null } });
  const plan = mergeFollowUp({ prev: prevTotal, fresh: byCountry, shape: "breakdown" });
  assert.deepEqual(plan.agg, { fn: "sum", column: "shop.orders.total" }, "still total, not a count");
  assert.equal(plan.group.column, "shop.customers.country");
  assert.deepEqual(plan.joins, ["shop.customers"]);
  const top5 = mergeFollowUp({ prev: { ...plan, order: { column: "__measure__", dir: "desc" } }, fresh: fresh({ limit: 5 }), shape: "keep" });
  assert.equal(top5.intent, "breakdown");
  assert.equal(top5.limit, 5);
  assert.equal(top5.group.column, "shop.customers.country");
  assert.equal(top5.order.column, "__measure__");
});

test("'remove the date filter' drops exactly that condition", () => {
  const prev = { ...prevCount, filters: [status("cancelled")] };
  const conditions = conditionList(model, prev);
  assert.deepEqual(conditions.map((c) => c.phrase), ["status is cancelled", "ordered at within last month"]);
  const plan = mergeFollowUp({ prev, fresh: fresh(), shape: "keep", dropped: [conditions[1]] });
  assert.equal(plan.time, null);
  assert.equal(plan.filters.length, 1);
  const noStatus = mergeFollowUp({ prev, fresh: fresh(), shape: "keep", dropped: [conditions[0]] });
  assert.equal(noStatus.filters.length, 0);
  assert.equal(noStatus.time.window, "last month");
});

test("describePlan gives Jev a one-line reading of the previous answer", () => {
  assert.equal(describePlan(model, { main: "shop.orders", intent: "breakdown", agg: { fn: "sum", column: "shop.orders.total" }, group: { column: "shop.customers.country" }, filters: [status("paid")], time: null }),
    "a breakdown of orders (sum of total) grouped by country where status is paid");
});
