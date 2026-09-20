import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../server/nl/compile.js";
import { conditionsText, summarize } from "../server/nl/assistant.js";
import { mentionsNegation, mentionsOr } from "../server/nl/candidates.js";
import { mergeFollowUp, validContext } from "../server/nl/followup.js";

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
const F = (column, op, value, extra = {}) => ({ column: `shop.${column}`, op, value, ...extra });

test("exclusions are NULL-safe", () => {
  const { sql, params } = compile(model, { main: "shop.orders", filters: [F("orders.status", "neq", "cancelled"), F("orders.status", "not_in", ["refunded", "void"])] });
  assert.match(sql, /"orders"\."status" is distinct from \$1/);
  assert.match(sql, /\("orders"\."status" is null or "orders"\."status"::text <> all\(\$2::text\[\]\)\)/);
  assert.deepEqual(params, ["cancelled", ["refunded", "void"]]);
  const text = compile(model, { main: "shop.customers", filters: [F("customers.name", "not_contains", "50%_off")] });
  assert.match(text.sql, /\("customers"\."name" is null or "customers"\."name"::text not ilike \$1\)/);
  assert.equal(text.params[0], "%50\\%\\_off%", "wildcards in the term are escaped");
});

test("alternatives compile into one OR group that is ANDed with the rest", () => {
  const { sql, params } = compile(model, {
    main: "shop.orders", intent: "count",
    filters: [F("orders.status", "eq", "cancelled", { or: true }), F("orders.total", "gt", 1000, { or: true }), F("orders.status", "neq", "void")],
    time: { column: "shop.orders.ordered_at", from: "2026-01-01", to: "2027-01-01" },
  });
  const where = sql.slice(sql.indexOf("where"));
  assert.match(where, /^where "orders"\."status" is distinct from \$3\n {2}and \("orders"\."status" = \$1\n {4}or "orders"\."total" > \$2\)\n {2}and "orders"\."ordered_at" >= \$4\n {2}and "orders"\."ordered_at" < \$5$/);
  assert.deepEqual(params, ["cancelled", "1000", "void", "2026-01-01", "2027-01-01"]);
  const single = compile(model, { main: "shop.orders", filters: [F("orders.total", "gt", 5, { or: true })] });
  assert.ok(!single.sql.includes("("), "a lone alternative is just a condition");
});

test("an alternative on a joined table must not turn the join into an inner join", () => {
  const either = compile(model, { main: "shop.orders", joins: ["shop.customers"], filters: [F("customers.country", "eq", "Japan", { or: true }), F("orders.total", "gt", 1000, { or: true })] });
  assert.match(either.sql, /\nleft join "shop"\."customers"/, "orders over 1000 with no matching customer still qualify");
  const must = compile(model, { main: "shop.orders", joins: ["shop.customers"], filters: [F("customers.country", "eq", "Japan")] });
  assert.match(must.sql, /\njoin "shop"\."customers"/);
});

test("hostile values in the new operators never reach SQL text", () => {
  const evil = `x'); drop table shop.orders; --`;
  const { sql, params } = compile(model, { main: "shop.orders", filters: [F("orders.status", "not_in", [evil], { or: true }), F("orders.status", "neq", evil, { or: "yes please" })] });
  assert.ok(!sql.includes("drop table"));
  assert.deepEqual(params, [[evil], evil]);
  assert.ok(!sql.includes("\n    or "), "only a literal true marks an alternative, so these two stay ANDed");
  assert.match(sql, /is distinct from \$2\n {2}and \("orders"\."status" is null or/);
  assert.throws(() => compile(model, { main: "shop.orders", filters: [F("orders.status", "not_in", "cancelled")] }), /at least one value/);
  assert.throws(() => compile(model, { main: "shop.orders", filters: [F("orders.status", "not like", "x")] }), /Unknown filter operator/);
});

test("wording for exclusions and alternatives", () => {
  const plan = { main: "shop.orders", intent: "count", filters: [F("orders.status", "eq", "cancelled", { or: true }), F("orders.total", "gt", 1000, { or: true }), F("orders.status", "not_in", ["void", "test"])], time: null };
  assert.equal(conditionsText(model, plan), "either status is cancelled or total over 1,000, status is not void or test");
  assert.equal(summarize(model, plan, { rows: [[42]] }).text, "orders where either status is cancelled or total over 1,000, status is not void or test");
  assert.equal(conditionsText(model, { main: "shop.customers", filters: [F("customers.name", "not_contains", "test")] }), "name does not contain test");
  assert.equal(conditionsText(model, { main: "shop.orders", filters: [] }), "");
});

test("negation and 'or' questions are only asked when the wording is present", () => {
  for (const q of ["orders that are not cancelled", "customers other than Japan", "everything except refunds", "orders without a customer", "users who haven't logged in", "products that aren't active", "no cancelled orders", "accounts outside the United States", "all statuses but refunded", "everything but cancelled", "orders leaving out test accounts"]) assert.ok(mentionsNegation(q), q);
  for (const q of ["cancelled orders this year", "top 5 customers", "orders from Norway", "notable reviews", "orders in November"]) assert.ok(!mentionsNegation(q), q);
  assert.ok(mentionsOr("cancelled or over 1000"));
  assert.ok(mentionsOr("either remote or in Berlin"));
  assert.ok(!mentionsOr("orders for Oregon"));
});

test("a follow-up's alternative is added to an earlier condition on the same column, not swapped for it", () => {
  const prev = { main: "shop.orders", joins: [], intent: "count", show: [], limit: null, order: null, time: null, filters: [F("orders.status", "neq", "cancelled")] };
  const fresh = { main: "shop.orders", joins: [], intent: "rows", show: [], limit: null, order: null, time: null,
    filters: [F("orders.status", "eq", "refunded", { or: true }), F("orders.total", "gt", 5000, { or: true })] };
  const plan = mergeFollowUp({ prev, fresh, shape: "keep" });
  assert.deepEqual(plan.filters.map((f) => f.op), ["neq", "eq", "gt"], "'not cancelled' survives");
  assert.match(compile(model, plan).sql, /is distinct from \$1\n {2}and \("orders"\."status" = \$2\n {4}or "orders"\."total" > \$3\)/);
  const swap = mergeFollowUp({ prev, fresh: { ...fresh, filters: [F("orders.status", "eq", "refunded")] }, shape: "keep" });
  assert.deepEqual(swap.filters.map((f) => f.value), ["refunded"], "a plain restatement still replaces");
});

test("follow-ups carry alternatives and accept exclusions as context", () => {
  const prev = { main: "shop.orders", joins: [], intent: "rows", show: [], limit: null, order: null, time: null,
    filters: [F("orders.status", "eq", "cancelled", { or: true }), F("orders.total", "gt", 1000, { or: true })] };
  assert.ok(validContext(model, { request: "cancelled or over 1000", plan: prev }), "an OR plan is valid context");
  const next = mergeFollowUp({ prev, shape: "keep", fresh: { main: "shop.orders", joins: [], intent: "rows", show: [], limit: null, order: null, time: null, filters: [F("orders.customer_id", "neq", 7)] } });
  assert.deepEqual(next.filters.map((f) => [f.op, Boolean(f.or)]), [["eq", true], ["gt", true], ["neq", false]]);
  assert.match(compile(model, next).sql, /is distinct from \$3\n {2}and \(/);
});

test("percentages: the measured conditions go in the numerator, everything else defines the whole", () => {
  const plan = { main: "shop.orders", intent: "share", filters: [F("orders.status", "eq", "cancelled", { part: true }), F("orders.total", "gt", 100)],
    time: { column: "shop.orders.ordered_at", from: "2026-01-01", to: "2027-01-01" } };
  const { sql, params } = compile(model, plan);
  assert.match(sql, /count\(\*\) filter \(where "orders"\."status" = \$1\) as "matching", count\(\*\) as "total"/);
  assert.match(sql, /round\(100\.0 \* count\(\*\) filter \(where "orders"\."status" = \$1\) \/ nullif\(count\(\*\), 0\), 1\) as "percent"/);
  assert.match(sql, /\nwhere "orders"\."total" > \$2\n {2}and "orders"\."ordered_at" >= \$3/, "the measured condition is not in WHERE");
  assert.deepEqual(params, ["cancelled", "100", "2026-01-01", "2027-01-01"]);
  assert.throws(() => compile(model, { main: "shop.orders", intent: "share", filters: [F("orders.total", "gt", 100)] }), /needs a condition to measure/);
  const s = summarize(model, plan, { rows: [[403, 3244, "12.4"]] });
  assert.equal(s.headline, "12.4%");
  assert.equal(s.text, "403 of 3,244 orders where total over 100, ordered at within undefined: status is cancelled".replace("undefined", String(plan.time.window)));
  assert.match(summarize(model, plan, { rows: [[0, 0, null]] }).text, /no percentage to give/);
});

test("percentage follow-ups: ask, ask again, refine, then list", () => {
  const base = { main: "shop.orders", joins: [], intent: "rows", show: [], limit: null, order: null, time: null, filters: [F("orders.total", "gt", 100)] };
  const fresh = (filters, intent = "rows") => ({ main: "shop.orders", joins: [], intent, show: [], limit: null, order: null, time: null, filters });
  const first = mergeFollowUp({ prev: base, shape: "share", fresh: fresh([F("orders.status", "eq", "cancelled", { part: true })], "share") });
  assert.deepEqual(first.filters.map((f) => [f.value, Boolean(f.part)]), [[100, false], ["cancelled", true]]);
  const again = mergeFollowUp({ prev: first, shape: "share", fresh: fresh([F("orders.status", "eq", "paid", { part: true })], "share") });
  assert.deepEqual(again.filters.map((f) => [f.value, Boolean(f.part)]), [[100, false], ["paid", true]], "a new numerator replaces the old one");
  const refine = mergeFollowUp({ prev: first, shape: "keep", fresh: fresh([F("orders.status", "in", ["paid", "shipped"])]) });
  assert.equal(refine.intent, "share");
  assert.deepEqual(refine.filters.map((f) => Boolean(f.part)), [false, true], "a condition on the measured column becomes the numerator");
  const narrowed = mergeFollowUp({ prev: first, shape: "keep", fresh: fresh([F("orders.customer_id", "eq", 7)]) });
  assert.deepEqual(narrowed.filters.map((f) => [f.column.split(".").pop(), Boolean(f.part)]), [["total", false], ["status", true], ["customer_id", false]], "other conditions narrow the whole");
  const list = mergeFollowUp({ prev: first, shape: "rows", fresh: fresh([]) });
  assert.ok(list.filters.every((f) => !("part" in f)), "'show them' lists the matching records");
  assert.ok(compile(model, list).sql.includes('"orders"."status" = $2'));
});
