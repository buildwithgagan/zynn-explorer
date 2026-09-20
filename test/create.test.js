import test from "node:test";
import assert from "node:assert/strict";
import { compileOps } from "../server/create/compile.js";
import { cleanOp, cleanOps } from "../server/create/ops.js";
import { emptyDesign, fingerprint, toErd, topoTables } from "../server/create/design.js";
import { BLUEPRINTS, instantiate } from "../server/create/blueprints/index.js";
import { advise } from "../server/create/advisor.js";
import { generateRows } from "../server/create/seed.js";
import { mulberry32, inferArchetype } from "../server/create/archetypes.js";
import { parseCatalogType, parseCatalogDefault, isSafeWidening } from "../server/create/types.js";
import { describeOp, summarizeOps } from "../server/create/wording.js";
import { identCandidates, tableIdent, toSnake, singularize } from "../server/nl/candidates.js";

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
  assert.ok(!data["public.orders"].columns.includes("id") && !data["public.orders"].columns.includes("created_at"));
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
  assert.deepEqual(idents("create a table called invoices with number, amount, due date and status"), ["invoices", "number", "amount", "due_date", "due", "date", "status"]);
  assert.ok(idents("add first name and date of birth to patients").includes("date_of_birth"));
  assert.deepEqual(idents('add a column "Order Ref" to orders').slice(0, 1), ["order_ref"]);
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
