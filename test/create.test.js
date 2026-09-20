import test from "node:test";
import assert from "node:assert/strict";
import { compileOps } from "../server/create/compile.js";
import { cleanOp, cleanOps } from "../server/create/ops.js";
import { emptyDesign, fingerprint, toErd, topoTables } from "../server/create/design.js";
import { BLUEPRINTS, instantiate } from "../server/create/blueprints/index.js";
import { advise } from "../server/create/advisor.js";
import { generateRows } from "../server/create/seed.js";
import { mulberry32, inferArchetype } from "../server/create/archetypes.js";
import { parseCatalogType, parseCatalogDefault, parseCatalogGenerated, isSafeWidening, cleanDefault } from "../server/create/types.js";
import { describeOp, summarizeOps } from "../server/create/wording.js";
import { identCandidates, tableIdent, toSnake, singularize, valueLists, splitChanges } from "../server/nl/candidates.js";

const T = (base, ...args) => (args.length ? { base, args } : { base });
const table = (name, columns, extra = {}) => ({ kind: "create_table", name, columns, ...extra });
const build = (ops, baseline = emptyDesign("shop")) => compileOps(baseline, cleanOps(ops));

const SHOP = [
  table("customers", [{ name: "name", type: T("text"), nullable: false }, { name: "email", type: T("text"), nullable: false, unique: true, check: "lowercase" }]),
  table("orders", [{ name: "customer_id", ref: { table: "public.customers", onDelete: "cascade" }, nullable: false }, { name: "total", type: T("numeric", 12, 2), nullable: false, check: "non_negative" }]),
];

test("a draft compiles in the order it was written, with the conventions applied", () => {
  const r = build(SHOP);
  assert.equal(r.broken.length, 0);
  const sql = r.statements.map((s) => s.sql);
  assert.match(sql[0], /^CREATE TABLE "public"\."customers" \(\n {2}"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,/);
  assert.match(sql[0], /"created_at" timestamptz DEFAULT now\(\) NOT NULL/);
  assert.match(sql[0], /CONSTRAINT "customers_pkey" PRIMARY KEY \("id"\)/);
  assert.match(sql[0], /CONSTRAINT "customers_email_check" CHECK \("email" = lower\("email"\)\)/);
  assert.match(sql[1], /FOREIGN KEY \("customer_id"\) REFERENCES "public"\."customers" \("id"\) ON DELETE CASCADE/);
  assert.equal(sql[2], 'CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");');
  assert.equal(r.level, "safe");
  assert.equal(r.confirmPhrase, null);
  assert.deepEqual(r.draft.tables["public.orders"].columns.map((c) => c.name), ["id", "customer_id", "total", "created_at", "updated_at"]);
});

test("conventions are switches on the op: turning one off recompiles without it", () => {
  const r = build([{ ...SHOP[0], conventions: { id: true, timestamps: false, fkIndex: true } }]);
  assert.doesNotMatch(r.statements[0].sql, /created_at/);
});

test("hostile input never reaches SQL text unquoted", () => {
  const bad = 'x"; drop table customers; --';
  const cases = [
    table(bad, [{ name: "a", type: T("text") }]),
    table("t", [{ name: bad, type: T("text") }]),
    { kind: "create_enum", name: bad, values: ["a"] },
    { kind: "create_role", name: bad },
    { kind: "rename_table", table: "public.customers", name: bad },
  ];
  for (const op of cases) {
    const r = build([...SHOP, op]);
    assert.equal(r.broken.length, 1, op.kind);
    assert.ok(!r.statements.some((s) => s.sql.includes("drop table")), op.kind);
  }
  // A type, action, privilege or template that is not on the whitelist is refused or replaced, never interpolated.
  assert.throws(() => cleanOp(table("t", [{ name: "a", type: { base: "text); drop table customers; --" } }])), /not a column type/);
  assert.throws(() => cleanOp(table("t", [{ name: "a", type: T("varchar", "10); drop") }])), /whole number/);
  assert.equal(cleanOp({ kind: "add_fk", table: "public.orders", columns: ["a"], refTable: "public.customers", onDelete: "CASCADE; drop table x" }).onDelete, "restrict");
  assert.deepEqual(cleanOp({ kind: "grant", role: "r", privileges: ["select", "ALL; drop"], table: "public.orders" }).privileges, ["SELECT"]);
  assert.equal(cleanOp({ kind: "add_check", table: "t", column: "c", template: "1=1); drop table x; --" }).template, undefined);
  assert.throws(() => cleanOp({ kind: "drop_database", name: "x" }), /not one Creator understands/);

  // Values that must be free text are emitted as quoted literals.
  const r = build([...SHOP, { kind: "create_enum", name: "mood", values: ["it's", "ok'); drop table customers; --"] }, { kind: "set_comment", table: "public.customers", comment: "o'brien" }]);
  assert.match(r.statements.at(-2).sql, /AS ENUM \('it''s', 'ok''\); drop table customers; --'\);$/);
  assert.match(r.statements.at(-1).sql, /IS 'o''brien';$/);

  // An existing object with a strange name is reachable, but only ever quoted.
  const odd = emptyDesign();
  odd.tables['public.we"ird'] = { schema: "public", name: 'we"ird', columns: [{ name: "a", type: T("text"), nullable: true }], pk: null, fks: [], uniques: [], checks: [], indexes: [], policies: [], grants: [], rls: false, estRows: 0 };
  assert.equal(build([{ kind: "drop_table", table: 'public.we"ird' }], odd).statements[0].sql, 'DROP TABLE "public"."we""ird";');

  const policy = build([...SHOP, { kind: "add_column", table: "public.orders", column: { name: "tenant_id", type: T("bigint") } },
    { kind: "create_policy", table: "public.orders", template: "tenant_setting", column: "tenant_id", setting: "app.x'); drop table y; --" }]);
  assert.equal(policy.broken.length, 1);
});

test("passwords are not something an op can carry", () => {
  const op = cleanOp({ kind: "create_role", name: "analyst", password: "hunter2", login: true });
  assert.deepEqual(Object.keys(op).sort(), ["id", "kind", "name"]);
  assert.equal(build([op]).statements[0].sql, 'CREATE ROLE "analyst" NOLOGIN;');
});

test("reserved words and over-long names are refused with a reason", () => {
  assert.match(build([table("user", [{ name: "a", type: T("text") }])]).broken[0].reason, /reserved word.*"users"/);
  assert.match(build([table("a".repeat(64), [{ name: "a", type: T("text") }])]).broken[0].reason, /63 bytes/);
  assert.match(build([table("pg_stuff", [{ name: "a", type: T("text") }])]).broken[0].reason, /reserved for Postgres/);
  const long = build([table("a".repeat(40), [{ name: "b".repeat(40), type: T("text"), unique: true }])]);
  assert.equal(long.broken.length, 0);
  assert.ok(long.draft.tables[`public.${"a".repeat(40)}`].uniques[0].name.length <= 63);
});

test("removing an op breaks the ops that depended on it, with a reason", () => {
  const r = build([SHOP[1]]);
  assert.equal(r.statements.length, 0);
  assert.match(r.broken[0].reason, /public\.customers does not exist/);
});

test("destructive changes are flagged and need the database name", () => {
  const base = build(SHOP).draft;
  base.tables["public.orders"].estRows = 10;
  const drop = build([{ kind: "drop_column", table: "public.orders", column: "total" }], base);
  assert.equal(drop.level, "destructive");
  assert.equal(drop.confirmPhrase, "shop");
  assert.equal(drop.inverse, null);
  assert.match(build([{ kind: "drop_table", table: "public.customers" }], base).broken[0].reason, /orders still references customers/);
  assert.match(build([{ kind: "drop_column", table: "public.customers", column: "id" }], base).broken[0].reason, /primary key/);

  const widen = build([{ kind: "alter_column_type", table: "public.customers", column: "name", type: T("varchar", 10) }], base);
  assert.equal(widen.level, "destructive");
  assert.ok(isSafeWidening(T("integer"), T("bigint")) && isSafeWidening(T("varchar", 10), T("text")) && !isSafeWidening(T("bigint"), T("integer")));
  const required = build([{ kind: "add_column", table: "public.orders", column: { name: "note", type: T("text"), nullable: false } }], base);
  assert.equal(required.level, "caution");
});

test("undo: replaying the inverse ops returns the design to where it started", () => {
  const base = build(SHOP).draft;
  const ops = [
    { kind: "add_column", table: "public.customers", column: { name: "phone", type: T("text") } },
    { kind: "rename_column", table: "public.customers", column: "name", name: "full_name" },
    { kind: "set_not_null", table: "public.customers", column: "phone" },
    { kind: "create_enum", name: "order_status", values: ["new", "paid"] },
    { kind: "add_column", table: "public.orders", column: { name: "status", type: { enum: "public.order_status" }, nullable: false, default: { kind: "enum_label", value: "new" } } },
    { kind: "add_index", table: "public.orders", columns: ["total"] },
    { kind: "rename_table", table: "public.orders", name: "purchases" },
    { kind: "create_role", name: "analyst" }, { kind: "grant", role: "analyst", privileges: ["SELECT"], allIn: "public" },
    { kind: "create_policy", table: "public.purchases", template: "read_all", role: "analyst" },
  ];
  const forward = build(ops, base);
  assert.deepEqual(forward.broken, []);
  assert.ok(forward.inverse);
  const back = build(forward.inverse, forward.draft);
  assert.deepEqual(back.broken, []);
  assert.equal(fingerprint(back.draft), fingerprint(base));
});

test("a link's delete rule can be changed, and changed back", () => {
  const base = build(SHOP).draft;
  const name = "orders_customer_id_fkey";
  const r = build([{ kind: "set_fk_action", table: "public.orders", name, onDelete: "restrict" }], base);
  assert.deepEqual(r.broken, []);
  assert.equal(r.statements[0].sql, `ALTER TABLE "public"."orders"\n  DROP CONSTRAINT "${name}",\n  ADD CONSTRAINT "${name}" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE RESTRICT;`);
  assert.equal(fingerprint(build(r.inverse, r.draft).draft), fingerprint(base));
  assert.match(build([{ kind: "set_fk_action", table: "public.orders", name, onDelete: "cascade" }], base).broken[0].reason, /already deletes/);
  // Clearing a link needs a column that may be empty.
  assert.match(build([{ kind: "set_fk_action", table: "public.orders", name, onDelete: "set_null" }], base).broken[0].reason, /Make it optional first/);
  const cleared = build([{ kind: "drop_not_null", table: "public.orders", column: "customer_id" }, { kind: "set_fk_action", table: "public.orders", name, onDelete: "set_null" }], base);
  assert.deepEqual(cleared.broken, []);
  assert.match(cleared.statements.at(-1).sql, /ON DELETE SET NULL;$/);
  assert.equal(cleanOp({ kind: "set_fk_action", table: "t", name: "x", onDelete: "CASCADE; drop table y" }).onDelete, "restrict");
});

test("a combination of columns can be unique, and a default can be set", () => {
  const base = build(SHOP).draft;
  const r = build([{ kind: "add_unique", table: "public.orders", columns: ["customer_id", "total"] }, { kind: "set_default", table: "public.orders", column: "total", default: { kind: "number", value: 0 } }], base);
  assert.deepEqual(r.broken, []);
  assert.equal(r.statements[0].sql, 'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_id_total_key" UNIQUE ("customer_id", "total");');
  assert.equal(r.statements[1].sql, 'ALTER TABLE "public"."orders" ALTER COLUMN "total" SET DEFAULT 0;');
  assert.equal(describeOp(cleanOp({ kind: "add_unique", table: "public.orders", columns: ["customer_id", "total"] })), "Allow each combination of customer_id + total only once in orders");
});

test("a calculated column is a template over real columns, never an expression", () => {
  const base = build([table("order_items", [{ name: "quantity", type: T("integer"), nullable: false }, { name: "unit_price", type: T("numeric", 12, 2), nullable: false }, { name: "note", type: T("text") }, { name: "starts_at", type: T("timestamptz") }, { name: "ends_at", type: T("timestamptz") }])]).draft;
  const gen = (name, template, columns) => ({ kind: "add_generated_column", table: "public.order_items", name, template, columns });
  const r = build([gen("line_total", "multiply", ["quantity", "unit_price"]), gen("duration", "subtract", ["ends_at", "starts_at"]), gen("note_lower", "lower", ["note"])], base);
  assert.deepEqual(r.broken, []);
  assert.equal(r.statements[0].sql, 'ALTER TABLE "public"."order_items" ADD COLUMN "line_total" numeric GENERATED ALWAYS AS ("quantity" * "unit_price") STORED;');
  assert.match(r.statements[1].sql, /"duration" interval GENERATED ALWAYS AS \("ends_at" - "starts_at"\) STORED;$/);
  assert.match(r.statements[2].sql, /"note_lower" text GENERATED ALWAYS AS \(lower\("note"\)\) STORED;$/);
  assert.equal(fingerprint(build(r.inverse, r.draft).draft), fingerprint(base));
  // Types that do not fit, unknown templates, and SQL smuggled in as a template or a column are all refused.
  assert.match(build([gen("x", "multiply", ["quantity", "note"])], base).broken[0].reason, /cannot be combined/);
  assert.equal(cleanOp(gen("x", "quantity); drop table y; --", ["quantity"])).template, undefined);
  assert.match(build([gen("x", "nope", ["quantity"])], base).broken[0].reason, /not one Creator can write/);
  assert.match(build([gen("x", "lower", ['note"); drop table y; --'])], base).broken[0].reason, /has no column/);
  // A column that feeds a calculation cannot be dropped or retyped from under it; a rename follows through.
  assert.match(build([{ kind: "drop_column", table: "public.order_items", column: "quantity" }], r.draft).broken[0].reason, /line_total is calculated from quantity/);
  assert.match(build([{ kind: "alter_column_type", table: "public.order_items", column: "quantity", type: T("bigint") }], r.draft).broken[0].reason, /calculated from quantity/);
  const renamed = build([{ kind: "rename_column", table: "public.order_items", column: "quantity", name: "qty" }], r.draft).draft;
  assert.deepEqual(renamed.tables["public.order_items"].columns.find((c) => c.name === "line_total").generatedAs.columns, ["qty", "unit_price"]);
  // Sample data leaves calculated columns to Postgres.
  assert.ok(!generateRows(r.draft, "public.order_items", 3, mulberry32(1), {}).columns.includes("line_total"));
  assert.equal(describeOp(cleanOp(gen("line_total", "multiply", ["quantity", "unit_price"]))), "Add line_total to order_items, always quantity × unit_price");
});

test("calculations can use a fixed number, and conditions give yes/no or one of two values", () => {
  const base = build([{ kind: "create_enum", name: "order_status", values: ["pending", "paid"] },
    table("orders2", [{ name: "total", type: T("numeric", 12, 2), nullable: false }, { name: "quantity", type: T("integer") }, { name: "limit_qty", type: T("integer") }, { name: "phone", type: T("text") }, { name: "paid", type: T("boolean") }, { name: "status", type: { enum: "public.order_status" } }])]).draft;
  const gen = (name, rest) => ({ kind: "add_generated_column", table: "public.orders2", name, ...rest });
  const sqlOf = (rest) => { const r = build([gen("x", rest)], base); assert.deepEqual(r.broken, []); return r.statements[0].sql.replace(/^.*ADD COLUMN "x" /, ""); };
  assert.equal(sqlOf({ template: "multiply", columns: ["total"], constant: 1.2 }), 'numeric GENERATED ALWAYS AS ("total" * 1.2) STORED;');
  assert.equal(sqlOf({ template: "multiply", columns: ["quantity"], constant: 12 }), 'bigint GENERATED ALWAYS AS ("quantity" * 12) STORED;');
  assert.equal(sqlOf({ template: "subtract", columns: ["total"], constant: -5 }), 'numeric GENERATED ALWAYS AS ("total" - (-5)) STORED;');
  assert.equal(sqlOf({ template: "subtract", columns: ["quantity"], constant: 100, constantFirst: true }), 'bigint GENERATED ALWAYS AS (100 - "quantity") STORED;');
  assert.equal(sqlOf({ template: "divide", columns: ["quantity"], constant: 12 }), 'numeric GENERATED ALWAYS AS (("quantity")::numeric / 12) STORED;');
  assert.equal(sqlOf({ template: "divide", columns: ["total", "quantity"] }), 'numeric GENERATED ALWAYS AS (("total")::numeric / NULLIF("quantity", 0)) STORED;');
  assert.equal(sqlOf({ template: "when", condition: { column: "quantity", test: "gt", value: 100 } }), 'boolean GENERATED ALWAYS AS ("quantity" > 100) STORED;');
  assert.equal(sqlOf({ template: "when", condition: { column: "total", test: "gt", value: 50 }, then: 0, else: 5 }), 'numeric GENERATED ALWAYS AS (CASE WHEN "total" > 50 THEN 0 ELSE 5 END) STORED;');
  assert.equal(sqlOf({ template: "when", condition: { column: "quantity", test: "gte", value: { column: "limit_qty" } }, then: { text: "o'er" }, else: { text: "ok" } }), `text GENERATED ALWAYS AS (CASE WHEN "quantity" >= "limit_qty" THEN 'o''er' ELSE 'ok' END) STORED;`);
  assert.equal(sqlOf({ template: "when", condition: { column: "status", test: "eq", value: { label: "paid" } } }), `boolean GENERATED ALWAYS AS ("status" = 'paid'::"public"."order_status") STORED;`);
  assert.equal(sqlOf({ template: "when", condition: { column: "phone", test: "is_set" } }), 'boolean GENERATED ALWAYS AS ("phone" IS NOT NULL) STORED;');
  assert.equal(sqlOf({ template: "when", condition: { column: "paid", test: "eq", value: { bool: true } }, then: 1 }), 'numeric GENERATED ALWAYS AS (CASE WHEN "paid" = true THEN 1 END) STORED;');

  const why = (rest) => build([gen("x", rest)], base).broken[0]?.reason;
  assert.match(why({ template: "divide", columns: ["total"], constant: 0 }), /Dividing by zero/);
  assert.match(why({ template: "concat", columns: ["phone"], constant: 2 }), /Only times, plus, minus and divided by/);
  assert.match(why({ template: "multiply", columns: ["phone"], constant: 2 }), /not a number/);
  assert.match(why({ template: "when", condition: { column: "phone", test: "gt", value: 3 } }), /needs a number or a date/);
  assert.match(why({ template: "when", condition: { column: "status", test: "eq", value: { label: "refunded" } } }), /not one of the values/);
  assert.match(why({ template: "when", condition: { column: "total", test: "gt", value: 1 }, then: 1, else: { text: "a" } }), /both text/);
  assert.match(why({ template: "when", condition: { column: "total", test: "gt" } }), /something to compare with/);
  // Nothing but a number or short text can be a constant; a test is a name from a list; a smuggled column is just a missing column.
  assert.throws(() => cleanOp(gen("x", { template: "multiply", columns: ["total"], constant: "1); drop table y; --" })), /ordinary number/);
  assert.throws(() => cleanOp(gen("x", { template: "multiply", columns: ["total"], constant: 1e400 })), /ordinary number/);
  assert.equal(cleanOp(gen("x", { template: "when", condition: { column: "total", test: "> 1 OR true --", value: 1 } })).condition.test, undefined);
  assert.match(why({ template: "when", condition: { column: 'total" > 0 OR true --', test: "gt", value: 1 } }), /has no column/);
  // The inputs of a conditional column are protected like any other.
  const made = build([gen("is_big", { template: "when", condition: { column: "quantity", test: "gt", value: { column: "limit_qty" } } })], base).draft;
  assert.match(build([{ kind: "drop_column", table: "public.orders2", column: "limit_qty" }], made).broken[0].reason, /is_big is calculated from limit_qty/);
  assert.equal(describeOp(cleanOp(gen("fee", { template: "when", condition: { column: "total", test: "gt", value: 50 }, then: 0, else: 5 }))), "Add fee to orders2: 0 when total is more than 50, otherwise 5");
  assert.equal(describeOp(cleanOp(gen("gross", { template: "multiply", columns: ["total"], constant: 1.2 }))), "Add gross to orders2, always total × 1.2");
  assert.equal(describeOp(gen("gross", { template: "divide", columns: ["total"], constant: 12 })), "Add gross to orders2, always total ÷ 12"); // before cleaning, as the chat reply sees it
});

test("calculated columns read from the catalog are matched back to their template", () => {
  const cols = ["quantity", "unit_price", "first_name", "last_name", "email", "expires_at", "created_at"];
  // A shape that is not a plain template stays opaque, but the columns it reads are still known. Text inside quotes is not a column.
  assert.deepEqual(parseCatalogGenerated("((quantity)::numeric * unit_price)", cols), { template: null, columns: ["quantity", "unit_price"] });
  assert.deepEqual(parseCatalogGenerated("CASE WHEN (quantity > 100) THEN 'email'::text ELSE 'small'::text END", cols), { template: null, columns: ["quantity"] });
  assert.deepEqual(parseCatalogGenerated("(quantity * unit_price)", cols), { template: "multiply", columns: ["quantity", "unit_price"] });
  assert.deepEqual(parseCatalogGenerated("(expires_at - created_at)", cols), { template: "subtract", columns: ["expires_at", "created_at"] });
  assert.deepEqual(parseCatalogGenerated("((first_name || ' '::text) || last_name)", cols), { template: "concat", columns: ["first_name", "last_name"] });
  assert.deepEqual(parseCatalogGenerated("lower(email)", cols), { template: "lower", columns: ["email"] });
  assert.deepEqual(parseCatalogGenerated("(quantity * missing)", cols), { template: null, columns: ["quantity"] });
  assert.equal(parseCatalogGenerated("(1 + 1)", cols), null);
});

test("a default can be a time from now", () => {
  const base = build([table("tokens", [{ name: "expires_at", type: T("timestamptz") }, { name: "label", type: T("text") }])]).draft;
  const set = (column, d) => ({ kind: "set_default", table: "public.tokens", column, default: d });
  assert.equal(build([set("expires_at", { kind: "now_plus", amount: 30, unit: "days" })], base).statements[0].sql, `ALTER TABLE "public"."tokens" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '30 days';`);
  assert.match(build([set("label", { kind: "now_plus", amount: 30, unit: "days" })], base).broken[0].reason, /cannot hold a moment in time/);
  assert.throws(() => cleanDefault({ kind: "now_plus", amount: 30, unit: "days'; drop table x; --" }), /unit must be/);
  assert.throws(() => cleanDefault({ kind: "now_plus", amount: "1; drop", unit: "days" }), /whole number/);
  assert.deepEqual(parseCatalogDefault("(now() + '30 days'::interval)"), { kind: "now_plus", amount: 30, unit: "days" });
  assert.deepEqual(parseCatalogDefault("(now() + '1 mon'::interval)"), { kind: "now_plus", amount: 1, unit: "months" });
});

test("removing a combination rule can be undone, and a rule in use cannot be removed", () => {
  const base = build([...SHOP, { kind: "add_unique", table: "public.orders", columns: ["customer_id", "total"] }]).draft;
  const r = build([{ kind: "drop_constraint", table: "public.orders", name: "orders_customer_id_total_key" }, { kind: "add_unique", table: "public.orders", columns: ["customer_id", "total", "id"] }], base);
  assert.deepEqual(r.broken, []);
  assert.deepEqual(r.draft.tables["public.orders"].uniques.map((u) => u.columns.join("+")), ["customer_id+total+id"]);
  assert.equal(fingerprint(build(r.inverse, r.draft).draft), fingerprint(base));
  const linked = build([table("a", [{ name: "code", type: T("text"), nullable: false, unique: true }]), table("b", [{ name: "a_code", type: T("text") }]), { kind: "add_fk", table: "public.b", columns: ["a_code"], refTable: "public.a", refColumns: ["code"] }]).draft;
  assert.match(build([{ kind: "drop_constraint", table: "public.a", name: "a_code_key" }], linked).broken[0].reason, /b references these columns/);
});

test("an enum value added in a draft cannot be used until it is applied", () => {
  const base = build([{ kind: "create_enum", name: "mood", values: ["ok"] }, table("t", [{ name: "m", type: { enum: "public.mood" } }])]).draft;
  const r = build([{ kind: "add_enum_value", enum: "public.mood", value: "great" }, { kind: "set_default", table: "public.t", column: "m", default: { kind: "enum_label", value: "great" } }], base);
  assert.match(r.broken[0].reason, /apply first/);
});

test("access: grants include schema usage, policies switch row-level security on", () => {
  const r = build([...SHOP, { kind: "create_role", name: "app" }, { kind: "grant", role: "app", privileges: ["SELECT", "INSERT"], table: "public.orders" },
    { kind: "add_column", table: "public.orders", column: { name: "owner", type: T("text") } }, { kind: "create_policy", table: "public.orders", template: "owner_column", column: "owner", role: "app" }]);
  assert.deepEqual(r.broken, []);
  const sql = r.statements.map((s) => s.sql).join("\n");
  assert.match(sql, /GRANT USAGE ON SCHEMA "public" TO "app";\nGRANT SELECT, INSERT ON "public"\."orders" TO "app";/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "orders_owner_column_policy" ON "public"\."orders"\n {2}FOR ALL TO "app"\n {2}USING \("owner" = current_user\)\n {2}WITH CHECK \("owner" = current_user\);/);
  assert.match(build([{ kind: "grant", role: "ghost", privileges: ["SELECT"], allIn: "public" }]).broken[0].reason, /Role ghost does not exist/);
});

test("every blueprint, with every option on, builds a clean draft", () => {
  for (const b of BLUEPRINTS) {
    const { ops } = instantiate(b, { optional: new Set(b.optional.map((o) => o.id)) });
    const r = build(ops);
    assert.deepEqual(r.broken, [], b.id);
    assert.equal(r.level, "safe", b.id);
    const tables = Object.values(r.draft.tables);
    assert.ok(tables.length >= 3, b.id);
    for (const t of tables) {
      assert.ok(t.pk, `${b.id}.${t.name} has a primary key`);
      for (const f of t.fks) assert.ok([t.pk, ...t.uniques, ...t.indexes].some((k) => k.columns[0] === f.columns[0]), `${b.id}.${t.name}.${f.columns[0]} is indexed`);
    }
    assert.deepEqual(advise(r.draft).filter((f) => f.severity !== "low"), [], `${b.id} passes its own advisor`);
  }
});

test("blueprints rename entities and skip tables that already exist", () => {
  const clinic = BLUEPRINTS.find((b) => b.id === "booking_clinic");
  const { ops } = instantiate(clinic, { optional: new Set(["owners"]), renames: { patients: "pets" } });
  const r = build(ops);
  assert.deepEqual(r.broken, []);
  assert.ok(r.draft.tables["public.pets"].fks.some((f) => f.refTable === "public.owners"));
  assert.ok(r.draft.tables["public.appointments"].columns.some((c) => c.name === "pet_id"));
  const again = instantiate(clinic, { renames: { patients: "pets" }, existing: new Set(Object.keys(r.draft.tables)) });
  assert.equal(again.ops.filter((o) => o.kind === "create_table").length, 0);
});

test("sample data respects foreign keys, uniqueness, checks and enums, and is repeatable", () => {
  const { ops } = instantiate(BLUEPRINTS.find((b) => b.id === "ecommerce"), { optional: new Set(["reviews"]) });
  const design = build(ops).draft;
  const make = () => {
    const rng = mulberry32(42), keys = {}, out = {};
    for (const id of topoTables(design).order) {
      out[id] = generateRows(design, id, 30, rng, keys);
      keys[id] = out[id].rows.map((_, i) => i + 1);
    }
    return out;
  };
  const data = make();
  assert.deepEqual(data, make());
  const col = (id, name) => data[id].rows.map((r) => r[data[id].columns.indexOf(name)]);
  // Identity keys are left to Postgres. created_at is not: left to its default, every row would be stamped with the insert.
  assert.ok(!data["public.orders"].columns.includes("id") && data["public.orders"].columns.includes("created_at"));
  assert.ok(col("public.orders", "customer_id").every((v) => v >= 1 && v <= 30));
  assert.equal(new Set(col("public.customers", "email")).size, 30);
  assert.ok(col("public.customers", "email").every((v) => v === v.toLowerCase()));
  assert.ok(col("public.order_items", "quantity").every((v) => v >= 1));
  assert.ok(col("public.orders", "status").every((v) => design.enums["public.order_status"].values.includes(v)));
  assert.ok(col("public.reviews", "rating").every((v) => v >= 1 && v <= 5));

  const blog = build(instantiate(BLUEPRINTS.find((b) => b.id === "blog_cms")).ops).draft;
  const pairs = generateRows(blog, "public.post_tags", 50, mulberry32(1), { "public.posts": [1, 2, 3], "public.tags": [1, 2] });
  assert.equal(pairs.rows.length, 6);
  assert.equal(new Set(pairs.rows.map((r) => r.join(":"))).size, 6);
  assert.throws(() => generateRows(design, "public.orders", 5, mulberry32(1), {}), /customers has no rows/);
  assert.equal(inferArchetype({ name: "email", type: T("text") }), "email");
  assert.equal(inferArchetype({ name: "email", type: T("integer") }), "count");
  assert.equal(inferArchetype({ name: "password_hash", type: T("text") }), "password_hash");
  assert.equal(inferArchetype({ name: "token_hash", type: T("text") }), "secret_hash");
  assert.equal(inferArchetype({ name: "ip_address", type: T("inet") }), "ip_address");
  assert.ok(identCandidates("create a roles table and a permissions table for users").map((c) => c.ident).includes("roles"));
});

test("the advisor finds what a DBA would, and each fix compiles", () => {
  const d = emptyDesign();
  const base = { schema: "public", pk: null, fks: [], uniques: [], checks: [], indexes: [], policies: [], grants: [], rls: false, estRows: 100, comment: null };
  const c = (name, type, extra = {}) => ({ name, type, nullable: true, default: null, identity: null, generated: false, ...extra });
  d.tables["public.customers"] = { ...base, name: "customers", pk: { name: "customers_pkey", columns: ["id"] }, columns: [c("id", T("bigint"), { nullable: false }), c("status", T("text"))] };
  d.tables["public.products"] = { ...base, name: "products", pk: { name: "products_pkey", columns: ["id"] }, columns: [c("id", T("bigint"), { nullable: false })] };
  d.tables["public.order"] = {
    ...base, name: "order", rls: true,
    columns: [c("id", T("bigint"), { nullable: false }), c("customer_id", T("bigint")), c("product_id", T("bigint")), c("price", T("double precision")), c("placed", T("timestamp")), c("code", T("varchar", 255)), c("paid", T("boolean"))],
    fks: [{ name: "order_customer_id_fkey", columns: ["customer_id"], refTable: "public.customers", refColumns: ["id"], onDelete: "restrict" }],
    indexes: [{ name: "i1", columns: ["code"], method: "btree", unique: false }, { name: "i2", columns: ["code"], method: "btree", unique: false }],
  };
  const found = advise(d, { "public.customers": { status: ["new", "active"] } });
  const rules = found.map((f) => f.rule).sort();
  assert.deepEqual(rules, ["duplicate_index", "fk_index", "float_money", "missing_fk", "no_pk", "nullable_boolean", "rls_no_policy", "table_plural", "text_enum", "timestamp_tz", "varchar_255"]);
  assert.equal(found[0].severity, "high");
  for (const f of found) assert.deepEqual(build(f.ops, d).broken, [], f.rule);
  // A calculated yes/no column is not a "nullable boolean" to fix: its value follows from its inputs.
  const withFlag = build([{ kind: "add_generated_column", table: "public.customers", name: "is_new", template: "when", condition: { column: "status", test: "eq", value: { text: "new" } } }], d).draft;
  assert.ok(!advise(withFlag).some((f) => f.target.endsWith(".is_new")));
  const fixed = build(found.flatMap((f) => (f.rule === "table_plural" ? [] : f.ops)), d).draft;
  assert.deepEqual(advise(fixed).map((f) => f.rule).sort(), ["rls_no_policy", "table_plural"]);
});

test("the diagram marks what a draft adds, changes and drops", () => {
  const base = build(SHOP).draft;
  const r = build([{ kind: "add_column", table: "public.customers", column: { name: "phone", type: T("text") } }, { kind: "rename_table", table: "public.orders", name: "purchases" }, table("tags", [{ name: "label", type: T("text") }])], base);
  const erd = toErd(base, r.draft, r.renames);
  const state = Object.fromEntries(erd.tables.map((t) => [t.name, t.state]));
  assert.deepEqual(state, { customers: "changed", purchases: "changed", tags: "added" });
  assert.equal(erd.tables[0].columns.find((c) => c.name === "phone").state, "added");
  const dropped = toErd(base, build([{ kind: "drop_table", table: "public.orders" }], base).draft);
  assert.equal(dropped.tables.find((t) => t.name === "orders").state, "dropped");
});

test("catalog types and defaults round-trip into the design's vocabulary", () => {
  assert.deepEqual(parseCatalogType("character varying(50)"), T("varchar", 50));
  assert.deepEqual(parseCatalogType("numeric(12,2)"), T("numeric", 12, 2));
  assert.deepEqual(parseCatalogType("timestamp with time zone"), T("timestamptz"));
  assert.deepEqual(parseCatalogType("text[]"), T("text[]"));
  assert.deepEqual(parseCatalogType("tsvector"), { raw: "tsvector" });
  assert.deepEqual(parseCatalogType("order_status", "public.order_status"), { enum: "public.order_status" });
  assert.deepEqual(parseCatalogDefault("now()"), { kind: "now" });
  assert.deepEqual(parseCatalogDefault("'it''s'::text"), { kind: "string", value: "it's" });
  assert.deepEqual(parseCatalogDefault("nextval('x_id_seq'::regclass)"), { raw: "nextval('x_id_seq'::regclass)" });
});

test("names come from the request: phrases become identifiers by rule", () => {
  const idents = (r) => identCandidates(r).map((c) => c.ident);
  assert.deepEqual(idents("create a table called invoices with number, amount, due date and status"), ["invoices", "number", "amount", "due_date", "status", "due", "date"]);
  assert.ok(idents("add first name and date of birth to patients").includes("date_of_birth"));
  // "at" closes a name, "full" is not filler, and whole phrases come before their fragments.
  assert.deepEqual(idents("users with full name, email verified at and last login at").slice(0, 4), ["users", "full_name", "email_verified_at", "last_login_at"]);
  assert.deepEqual(idents('add a column "Order Ref" to orders').slice(0, 1), ["order_ref"]);
  // A bracketed list after a name is that field's allowed values, multi-word values included.
  assert.deepEqual(valueLists("tokens with purpose (email verification, password reset) and status (a, b or c)").map((l) => [l.fields.at(-1), l.values]),
    [["purpose", ["email_verification", "password_reset"]], ["status", ["a", "b", "c"]]]);
  assert.deepEqual(valueLists("add notes (optional) to users"), []);
  assert.equal(tableIdent("order item"), "order_items");
  assert.equal(tableIdent("Category"), "categories");
  assert.equal(tableIdent("staff"), "staff");
  assert.equal(toSnake("dueDate"), "due_date");
  assert.equal(singularize("statuses"), "status");
});

test("wording: every op reads as a sentence", () => {
  assert.equal(describeOp(cleanOp(SHOP[0])), "Create table customers with name and email");
  assert.equal(describeOp(cleanOp({ kind: "grant", role: "analyst", privileges: ["select"], allIn: "public" })), "Let analyst select every table in public");
  assert.equal(summarizeOps(cleanOps(SHOP)), "Create 2 tables: customers and orders");
});

test("the schema exports as SQL that names everything, and migrations as numbered files in a tar", async () => {
  const { schemaSql, migrationFiles, tar } = await import("../server/create/export.js");
  const { ops } = instantiate(BLUEPRINTS.find((b) => b.id === "hr"), { optional: new Set(["salaries"]) });
  const design = build([...ops, { kind: "add_generated_column", table: "public.salaries", name: "monthly", template: "divide", columns: ["amount"], constant: 12 },
    { kind: "create_role", name: "hr_reader" }, { kind: "grant", role: "hr_reader", privileges: ["SELECT"], table: "public.employees" }]).draft;
  const sql = schemaSql(design, { at: new Date(0) });
  assert.match(sql, /^-- shop: schema as of 1970-01-01T00:00:00.000Z/);
  // Parents before children, enums before the tables that use them, and the self-reference inside its own table.
  assert.ok(sql.indexOf('CREATE TYPE "public"."leave_request_kind"') < sql.indexOf('CREATE TABLE "public"."leave_requests"'));
  assert.ok(sql.indexOf('CREATE TABLE "public"."departments"') < sql.indexOf('CREATE TABLE "public"."employees"'));
  assert.match(sql, /"manager_id" bigint,[\s\S]*FOREIGN KEY \("manager_id"\) REFERENCES "public"\."employees" \("id"\) ON DELETE SET NULL/);
  assert.match(sql, /"id" bigint GENERATED ALWAYS AS IDENTITY,/);
  assert.match(sql, /CONSTRAINT "employees_email_check" CHECK \("email" = lower\("email"\)\)/);
  assert.match(sql, /CREATE INDEX "employees_department_id_idx" ON "public"\."employees" \("department_id"\);/);
  // Roles are cluster-wide: what depends on them is written out, but commented.
  assert.match(sql, /COMMIT;\n[\s\S]*-- CREATE ROLE "hr_reader" NOLOGIN;\n-- GRANT USAGE ON SCHEMA "public" TO "hr_reader";\n-- GRANT SELECT ON "public"\."employees" TO "hr_reader";/);

  const files = migrationFiles([
    { at: "2026-09-20T10:05:00Z", summary: "Add 25 sample rows to every table", sql: ["-- sample data: 25 rows each into users (seed 7)"] },
    { at: "2026-09-20T10:00:00Z", summary: "Create 2 tables: users and sessions", sql: ['CREATE TABLE "public"."users" ();', 'CREATE TABLE "public"."sessions" ();'] },
  ], "zynn");
  assert.deepEqual(files.map((f) => f.name), ["0001_create_2_tables_users_and_sessions.sql", "0002_add_25_sample_rows_to_every_table.sql"]);
  assert.match(files[0].content, /^-- zynn: migration 1 of 2\n[\s\S]*BEGIN;\n\nCREATE TABLE "public"\."users" \(\);\n\nCREATE TABLE "public"\."sessions" \(\);\n\nCOMMIT;\n$/);
  assert.ok(!files[1].content.includes("BEGIN;") && files[1].content.includes("not reproduced here"));

  const archive = tar(files, 0);
  assert.equal(archive.length % 512, 0);
  const text = new TextDecoder().decode(archive);
  assert.ok(text.startsWith("0001_create_2_tables_users_and_sessions.sql\0"));
  assert.equal(text.slice(257, 262), "ustar");
  const size = parseInt(text.slice(124, 135), 8);
  assert.equal(new TextDecoder().decode(archive.slice(512, 512 + size)), files[0].content);
  // The checksum is the byte sum of the header with the checksum field read as spaces.
  const head = archive.slice(0, 512), stored = parseInt(text.slice(148, 154), 8);
  assert.equal(head.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0), stored);
});

test("a message is split into changes at command verbs, never inside a list, a bracket or a description", () => {
  assert.deepEqual(splitChanges("make phone required on owners, rename practitioners to vets and drop notes from appointments"),
    ["make phone required on owners", "rename practitioners to vets", "drop notes from appointments"]);
  assert.deepEqual(splitChanges("add a phone number to customers and make it required"), ["add a phone number to customers", "make it required"]);
  assert.deepEqual(splitChanges("fill every table with 25 sample rows then create a read-only role called analyst"), ["fill every table with 25 sample rows", "create a read-only role called analyst"]);
  // A sentence that is not a command describes the create/add before it, and stays with it.
  const sessions = "create a table called sessions with token hash, ip address and expires at. each session belongs to a user. when a user is deleted their sessions are deleted too";
  assert.deepEqual(splitChanges(sessions), [sessions]);
  assert.deepEqual(splitChanges("create a table called invoices with number, amount and status (draft, sent, paid). number must be unique and required. index invoices by due date"),
    ["create a table called invoices with number, amount and status (draft, sent, paid). number must be unique and required", "index invoices by due date"]);
  // …but after any other kind of request it is a change of its own.
  assert.deepEqual(splitChanges("rename practitioners to vets. the phone on owners should be required"), ["rename practitioners to vets", "the phone on owners should be required"]);
  // Field lists, privilege lists, quotes and brackets are never split.
  for (const whole of ["add a loyalty points field and a birthday to customers", "let the zynn_api role read, add and edit users, sessions and subscriptions",
    'add a tier to plans: "premium, and make it big" when monthly price is over 50, otherwise "standard"', "create a table called tasks with title and priority (low, and make it high)"]) assert.deepEqual(splitChanges(whole), [whole]);
  assert.equal(splitChanges(Array.from({ length: 9 }, (_, i) => `drop table t${i}`).join(". ")).length, 6);
});

test("a view is a table's columns plus yes/no columns or a row test, and may use now and today", () => {
  const base = build([{ kind: "create_enum", name: "sub_status", values: ["trialing", "active"] },
    table("sessions", [{ name: "token", type: T("text") }, { name: "expires_at", type: T("timestamptz"), nullable: false }, { name: "due", type: T("date") }, { name: "status", type: { enum: "public.sub_status" } }])]).draft;
  const view = (rest) => ({ kind: "create_view", table: "public.sessions", ...rest });
  const expired = { column: "expires_at", test: "lt", value: { clock: "now" } };
  const r = build([view({ name: "sessions_live", flags: [{ name: "is_expired", condition: expired }] })], base);
  assert.deepEqual(r.broken, []);
  assert.equal(r.statements[0].sql, 'CREATE VIEW "public"."sessions_live" AS\nSELECT\n  "id",\n  "token",\n  "expires_at",\n  "due",\n  "status",\n  "created_at",\n  "updated_at",\n  ("expires_at" < now()) AS "is_expired"\nFROM "public"."sessions";');
  assert.equal(r.level, "safe");
  const filtered = build([view({ name: "active_sessions", filter: { column: "status", test: "eq", value: { label: "active" } }, flags: [{ name: "is_overdue", condition: { column: "due", test: "lt", value: { clock: "today" } } }] })], base);
  assert.match(filtered.statements[0].sql, /\("due" < CURRENT_DATE\) AS "is_overdue"\nFROM "public"\."sessions"\nWHERE "status" = 'active'::"public"\."sub_status";$/);
  assert.equal(describeOp(cleanOp(view({ name: "sessions_live", flags: [{ name: "is_expired", condition: expired }] }))), "Create view sessions_live: sessions, with is_expired (yes when expires_at is less than now)");

  // The clock is for views only: a stored calculated column still refuses it.
  assert.match(build([{ kind: "add_generated_column", table: "public.sessions", name: "x", template: "when", condition: expired }], base).broken[0].reason, /cannot depend on now or today\. A view can/);
  const why = (rest) => build([view(rest)], base).broken[0]?.reason;
  assert.match(why({ name: "v" }), /needs a yes\/no column or a test/);
  assert.match(why({ name: "sessions", filter: expired }), /already has something named sessions/);
  assert.match(why({ name: "v", flags: [{ name: "token", condition: expired }] }), /already has a column "token"/);
  assert.match(why({ name: "v", filter: { column: "token", test: "lt", value: { clock: "now" } } }), /needs a number or a date/);
  assert.match(why({ name: 'v"; drop table sessions; --', filter: expired }), /not a valid view name/);
  assert.equal(cleanOp(view({ name: "v", filter: { column: "due", test: "lt", value: { clock: "now()); drop table x; --" } } })).filter.value.clock, "now");

  // What a view shows cannot be dropped or retyped from under it, and undo puts the view back.
  assert.match(build([{ kind: "drop_column", table: "public.sessions", column: "token" }], r.draft).broken[0].reason, /view sessions_live shows sessions\.token/);
  assert.match(build([{ kind: "drop_table", table: "public.sessions" }], r.draft).broken[0].reason, /view sessions_live reads sessions/);
  assert.match(build([{ kind: "alter_column_type", table: "public.sessions", column: "token", type: T("varchar", 10) }], r.draft).broken[0].reason, /will not retype a column a view uses/);
  const gone = build([{ kind: "drop_view", view: "public.sessions_live" }], r.draft);
  assert.equal(gone.statements[0].sql, 'DROP VIEW "public"."sessions_live";');
  assert.equal(fingerprint(build(gone.inverse, gone.draft).draft), fingerprint(r.draft));
  assert.equal(fingerprint(build(r.inverse, r.draft).draft), fingerprint(base));
});

test("sample rows are coherent: time runs forwards, events follow status, numbers agree", () => {
  const NOW = Date.UTC(2026, 8, 21);
  const design = build([
    { kind: "create_enum", name: "sub_status", values: ["trialing", "active", "past_due", "cancelled"] },
    { kind: "create_enum", name: "inv_status", values: ["draft", "open", "paid", "void"] },
    { kind: "create_enum", name: "user_status", values: ["pending", "active"] },
    table("users", [{ name: "email", type: T("text"), archetype: "email" }, { name: "status", type: { enum: "public.user_status" }, nullable: false }, { name: "email_verified_at", type: T("timestamptz") }, { name: "last_login_at", type: T("timestamptz") }, { name: "failed_login_count", type: T("integer") }]),
    table("sessions", [{ name: "user_id", ref: { table: "public.users", onDelete: "cascade" }, nullable: false }, { name: "expires_at", type: T("timestamptz"), nullable: false }, { name: "revoked_at", type: T("timestamptz") }]),
    table("plans", [{ name: "monthly_price", type: T("numeric", 12, 2), archetype: "money" }, { name: "yearly_price", type: T("numeric", 12, 2), archetype: "money" }, { name: "min_seats", type: T("integer") }, { name: "max_seats", type: T("integer") }]),
    table("subscriptions", [{ name: "user_id", ref: { table: "public.users" }, nullable: false }, { name: "status", type: { enum: "public.sub_status" }, nullable: false }, { name: "started_at", type: T("timestamptz") }, { name: "current_period_end", type: T("timestamptz") }, { name: "cancelled_at", type: T("timestamptz") }]),
    table("invoices", [{ name: "subscription_id", ref: { table: "public.subscriptions" }, nullable: false }, { name: "status", type: { enum: "public.inv_status" }, nullable: false }, { name: "due_date", type: T("date") }, { name: "paid_at", type: T("timestamptz") }]),
    table("order_lines", [{ name: "quantity", type: T("integer"), archetype: "quantity", check: "positive" }, { name: "unit_price", type: T("numeric", 12, 2), archetype: "money" }, { name: "line_total", type: T("numeric", 12, 2), archetype: "money" }]),
  ]).draft;
  const make = () => {
    const rng = mulberry32(9), keys = {}, moments = {}, out = {};
    for (const id of topoTables(design).order) {
      const d = generateRows(design, id, 60, rng, keys, { now: NOW, parentMoments: moments });
      keys[id] = d.rows.map((_, i) => i + 1);
      moments[id] = new Map(d.moments.map((m, i) => [String(i + 1), m]));
      out[id] = d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])));
    }
    return { out, moments };
  };
  const { out, moments } = make();
  assert.deepEqual(make().out, out, "the same seed and the same day give the same rows");
  const t = (v) => new Date(v).getTime();

  for (const s of out["public.sessions"]) {
    assert.ok(t(s.expires_at) > t(s.created_at), "a session expires after it was created");
    assert.ok(t(s.created_at) >= moments["public.users"].get(String(s.user_id)), "and was created after its user");
    assert.ok(t(s.created_at) <= NOW && t(s.updated_at) >= t(s.created_at) && t(s.updated_at) <= NOW);
    if (s.revoked_at) assert.ok(t(s.revoked_at) > t(s.created_at) && t(s.revoked_at) <= NOW);
  }
  const live = out["public.sessions"].filter((s) => t(s.expires_at) > NOW).length, revoked = out["public.sessions"].filter((s) => s.revoked_at).length;
  assert.ok(live > 10 && live < 60, `some sessions are live and some have expired (${live} of 60 live)`);
  assert.ok(revoked < 20, `revoking is rare (${revoked} of 60)`);

  for (const s of out["public.subscriptions"]) {
    assert.equal(Boolean(s.cancelled_at), s.status === "cancelled", "cancelled_at is set exactly when the status says cancelled");
    if (s.started_at && s.current_period_end) assert.ok(t(s.current_period_end) > t(s.started_at));
    if (s.started_at) assert.ok(t(s.started_at) >= t(s.created_at));
  }
  for (const i of out["public.invoices"]) {
    assert.equal(Boolean(i.paid_at), i.status === "paid", "paid_at is set exactly when the invoice is paid");
    assert.match(i.due_date ?? "2026-01-01", /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const u of out["public.users"]) if (u.status === "pending") assert.equal(u.email_verified_at, null, "a pending user has not verified their email");
  assert.ok(out["public.users"].filter((u) => u.failed_login_count === 0).length > 35, "most users have no failed logins");
  for (const p of out["public.plans"]) {
    assert.equal(Number(p.yearly_price), Number((Number(p.monthly_price) * 10).toFixed(2)), "a year costs ten months");
    assert.ok(Number(p.monthly_price) <= 500 && p.max_seats >= p.min_seats);
  }
  for (const l of out["public.order_lines"]) assert.equal(Number(l.line_total), Number((l.quantity * Number(l.unit_price)).toFixed(2)), "a line total is quantity times unit price");
});
