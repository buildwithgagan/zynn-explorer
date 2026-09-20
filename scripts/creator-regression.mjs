// Jev regression for Creator. Sends each request several times through the running app and compares what was
// staged, because a judgment near a threshold can flip between identical calls. Nothing is applied.
//
//   node scripts/creator-regression.mjs [http://127.0.0.1:4477] [runs=3]
//
// Connect the app to a scratch database first (never a real one: table and column names go to TypeSafe).
// The "live" cases expect the online-store blueprint to have been applied there.
const base = (process.argv[2] ?? "http://127.0.0.1:4477") + "/api";
const RUNS = Number(process.argv[3] ?? 3);

// [request, what the staged ops must look like] — a regex over "kind:name kind:name …", or null for "stage nothing".
const CASES = [
  ["build me a database for a vet clinic", /create_table:owners.*create_table:patients.*create_table:appointments/],
  ["I need a blog with tags and comments", /create_table:posts.*create_table:post_tags.*create_table:comments/],
  ["design an HR database", /create_table:departments.*create_table:employees/],
  ["create a table called invoices with number, amount, due date and status (draft, sent, paid)", /create_enum:invoice_status create_table:invoices\[number,amount,due_date,status\]/],
  ["create tables for members and gym classes. each gym class has a name and a capacity. members have a name and an email", /create_table:members.*create_table:gym_classes|create_table:gym_classes.*create_table:members/],
  ["add a loyalty points field and a birthday to customers", /^add_column:customers\.loyalty_points add_column:customers\.birthday$/],
  ["customers also need a required vat number", /^add_column:customers\.vat_number$/],
  ["make the sku on products optional", /^drop_not_null:products\.sku$/],
  ["change the quantity on order items to a big whole number", /^alter_column_type:order_items\.quantity$/],
  ["rename the body column on reviews to comment", /^rename_column:reviews\.body>comment$/],
  ["rename categories to collections", /^rename_table:categories>collections$/],
  ["remove the line2 column from addresses", /^drop_column:addresses\.line2$/],
  ["delete the payments table", /^drop_table:payments$/],
  ["each review belongs to an order", /^add_column:reviews\.order_id$/],
  ["products can have many categories and categories many products", /^create_table:category_products$/],
  ["index orders by placed at", /^add_index:orders\(placed_at\)$/],
  ["fill every table with 50 sample rows", /^seed:50$/],
  ["add 10 fake rows to customers", /^seed:10$/],
  ["create a read-only role called analyst", /^create_role:analyst grant:analyst\[SELECT\]$/],
  ["let the support role read and edit orders", /^create_role:support grant:support\[SELECT,UPDATE\]$/],
  ["review my schema", null],
  ["how many orders were placed last month", null],
  ["asdf qwerty lorem", null],
  ["what's the weather like", null],
  ['create a table called x"; drop table customers; --', null],
];

const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const sig = (o) => {
  const t = (id) => String(id ?? "").split(".").pop();
  switch (o.kind) {
    case "create_table": return `create_table:${o.name}${o.columns.some((c) => !c.ref) && o.name === "invoices" ? `[${o.columns.map((c) => c.name)}]` : ""}`;
    case "add_column": return `add_column:${t(o.table)}.${o.column.name}`;
    case "rename_column": return `rename_column:${t(o.table)}.${o.column}>${o.name}`;
    case "rename_table": return `rename_table:${t(o.table)}>${o.name}`;
    case "add_index": return `add_index:${t(o.table)}(${o.columns})`;
    case "seed": return `seed:${o.rows}`;
    case "grant": return `grant:${o.role}[${o.privileges}]`;
    case "create_enum": case "create_role": return `${o.kind}:${o.name}`;
    default: return `${o.kind}:${t(o.table)}${o.column ? "." + o.column : ""}`;
  }
};

const status = await (await fetch(base + "/status")).json();
if (!status.connected || !status.jev) throw new Error("The app must be connected to a scratch database, with TYPESAFE_API_KEY set");
console.log(`database ${status.connection.database} · ${RUNS} runs each\n`);
let bad = 0, tokens = 0, ms = 0, calls = 0;
for (const [request, expect] of CASES) {
  const seen = new Map();
  let weakest = 1;
  for (let i = 0; i < RUNS; i++) {
    const r = await post("/create/interpret", { request, ops: [] });
    if (r.error) { seen.set(`ERROR ${r.error}`, 1); continue; }
    const added = new Set(r.added);
    const s = r.draft.ops.filter((o) => added.has(o.id)).map(sig).join(" ") || "(nothing staged)";
    seen.set(s, (seen.get(s) ?? 0) + 1);
    for (const j of r.judgments) if (j.applied && !j.rule) weakest = Math.min(weakest, j.p);
    tokens += r.usage?.input_tokens ?? 0; ms += r.ms; calls++;
  }
  const stable = seen.size === 1;
  const [first] = seen.keys();
  const right = expect ? expect.test(first) : first === "(nothing staged)";
  if (!stable || !right) bad++;
  console.log(`${stable && right ? "ok  " : !stable ? "FLIP" : "WRONG"} ${request}\n       ${[...seen].map(([k, n]) => `${n}× ${k}`).join("\n       ")}${weakest < 0.7 ? `\n       weakest applied judgment ${weakest.toFixed(2)}` : ""}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} stable and correct · avg ${Math.round(tokens / calls)} tokens, ${Math.round(ms / calls)} ms per request`);
process.exit(bad ? 1 : 0);
