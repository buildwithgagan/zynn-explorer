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
  ["create tables for members and gym classes. each gym class has a name and a capacity. members have a name and an email", /^(create_table:members\[name,email\] create_table:gym_classes\[name,capacity\]|create_table:gym_classes\[name,capacity\] create_table:members\[name,email\])$/],
  ["add a loyalty points field and a birthday to customers", /^add_column:customers\.loyalty_points add_column:customers\.birthday$/],
  ["customers also need a required vat number", /^add_column:customers\.vat_number$/],
  ["make the sku on products optional", /^drop_not_null:products\.sku$/],
  ["change the quantity on order items to a big whole number", /^alter_column_type:order_items\.quantity$/],
  ["rename the body column on reviews to comment", /^rename_column:reviews\.body>comment$/],
  ["rename categories to collections", /^rename_table:categories>collections$/],
  ["remove the line2 column from addresses", /^drop_column:addresses\.line2$/],
  ["delete the payments table", /^drop_table:payments$/],
  ["each review belongs to an order", /^add_column:reviews\.order_id$/],
  ["products can have many categories and categories many products", /^create_table:product_categories$/],
  ["index orders by placed at", /^add_index:orders\(placed_at\)$/],
  ["fill every table with 50 sample rows", /^seed:50$/],
  ["add 10 fake rows to customers", /^seed:10$/],
  ["create a read-only role called analyst", /^create_role:analyst grant:analyst\[SELECT\]$/],
  ["let the support role read and edit orders", /^create_role:support grant:support\[SELECT,UPDATE\]$/],
  // An application's own roles and permissions are tables, not Postgres roles.
  ["create a roles table with name and description", /^create_table:roles$/],
  ["create a table called permissions with name and description", /^create_table:permissions$/],
  ["create a table called users with email and password hash", /^create_table:users$/],
  ["create a table called verification tokens with purpose (email verification, password reset), token hash and expires at", /^create_enum:verification_token_purpose create_table:verification_tokens$/],
  ["create a table called roles with name, description and is system", /^create_table:roles$/],
  ["the email on customers does not need to be unique", /^drop_constraint:customers$/],
  ["create a table called tickets with number and subject. ticket numbers must be unique", /^create_table:tickets\[number,subject\]$/],
  // Combined uniqueness, defaults, and what happens on delete.
  ["a customer can review a product only once", /^add_unique:reviews\((product_id,customer_id|customer_id,product_id)\)$/],
  ["sku and name together must be unique on products", /^add_unique:products\(name,sku\)$/],
  ["a product sku must be unique within a category", /^add_unique:products\(category_id,sku\)$/],
  ["is active on products should default to false", /^set_default:products\.is_active=false$/],
  ["the status of orders should default to paid", /^set_default:orders\.status=paid$/],
  ["do not allow deleting a category that still has products", /^set_fk_action:products>restrict$/],
  ["when a product is deleted, keep its order items but clear the product", /^drop_not_null:order_items\.product_id set_fk_action:order_items>set_null$/],
  // Calculated columns and relative defaults.
  ["add a line total to order items that is quantity times unit price", /^add_generated_column:order_items\.line_total=multiply\(quantity,unit_price\)$/],
  ["add a lowercase version of email called email lower to customers", /^add_generated_column:customers\.email_lower=lower\(email\)$/],
  ["add a margin to order items that is unit price minus quantity", /^add_generated_column:order_items\.margin=subtract\(unit_price,quantity\)$/],
  ["add a gap to order items: subtract quantity from unit price", /^add_generated_column:order_items\.gap=subtract\(unit_price,quantity\)$/],
  // Constants and conditions.
  ["add a gross price to products that is price times 1.2", /^add_generated_column:products\.gross_price=multiply\(price\)\*1\.2$/],
  ["add a vat to products that is 20 percent of price", /^add_generated_column:products\.vat=multiply\(price\)\*0\.2$/],
  ["add a dozens to order items that is quantity divided by 12", /^add_generated_column:order_items\.dozens=divide\(quantity\)\*12$/],
  ["add a remaining to order items that is 100 minus quantity", /^add_generated_column:order_items\.remaining=subtract\(quantity\)\*100 first$/],
  ["add an is bulk flag to order items that is true when quantity is over 100", /^add_generated_column:order_items\.is_bulk=when\(quantity gt 100\)$/],
  ["add a shipping fee to orders: 0 when total is over 50, otherwise 5", /^add_generated_column:orders\.shipping_fee=when\(total gt 50\)\?0:5$/],
  ["add a has phone flag to customers that is true when phone is filled in", /^add_generated_column:customers\.has_phone=when\(phone is_set\)$/],
  ["add an is paid flag to orders that is true when status is paid", /^add_generated_column:orders\.is_paid=when\(status eq paid\)$/],
  ["add an is overdue flag to orders that is true when placed at is before today", null],
  ["placed at on orders should default to 2 days from now", /^set_default:orders\.placed_at=now_plus$/],
  // Changing and removing a combination rule. The third item stages a rule first; the whole draft is compared.
  ["reviews should be unique per product, customer and rating instead", /^add_unique:reviews\(product_id,customer_id,rating\)$/, [{ id: "rule", kind: "add_unique", table: "public.reviews", columns: ["product_id", "customer_id"] }]],
  ["a customer no longer needs to be limited to one review per product, remove that rule", /^$/, [{ id: "rule", kind: "add_unique", table: "public.reviews", columns: ["product_id", "customer_id"] }]],
  // Several changes in one message.
  ["make the sku on products optional, rename categories to collections and index orders by placed at", /^drop_not_null:products\.sku rename_table:categories>collections add_index:orders\(placed_at\)$/],
  ["add a nickname to customers and make it required", /^add_column:customers\.nickname!$/],
  ["the phone on customers must be unique and required", /^(set_not_null:customers\.phone add_unique:customers\(phone\)|add_unique:customers\(phone\) set_not_null:customers\.phone)$/],
  ["create a table called notes with body. each note belongs to a customer. index notes by created at", /^create_table:notes add_index:notes\(created_at\)$/],
  ["rename categories to collections. what's the weather like", /^rename_table:categories>collections$/], // one part fails, the other still stages
  ["export the schema as sql", null],
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
    case "create_table": return `create_table:${o.name}${o.columns.some((c) => !c.ref) && ["invoices", "tickets", "members", "gym_classes"].includes(o.name) ? `[${o.columns.map((c) => c.name)}]` : ""}`;
    case "add_column": return `add_column:${t(o.table)}.${o.column.name}${o.column.nullable === false && /nickname/.test(o.column.name) ? "!" : ""}`;
    case "rename_column": return `rename_column:${t(o.table)}.${o.column}>${o.name}`;
    case "rename_table": return `rename_table:${t(o.table)}>${o.name}`;
    case "add_index": return `add_index:${t(o.table)}(${o.columns})`;
    case "seed": return `seed:${o.rows}`;
    case "add_generated_column": {
      const v = (c) => c?.column ?? c?.label ?? c?.text ?? (c?.bool != null ? String(c.bool) : c?.number);
      if (o.template === "when") return `add_generated_column:${t(o.table)}.${o.name}=when(${o.condition.column} ${o.condition.test}${o.condition.value ? " " + v(o.condition.value) : ""})${o.then ? `?${v(o.then)}:${v(o.else) ?? ""}` : ""}`;
      return `add_generated_column:${t(o.table)}.${o.name}=${o.template}(${o.columns})${o.constant ? `*${v(o.constant)}${o.constantFirst ? " first" : ""}` : ""}`;
    }
    case "add_unique": return `add_unique:${t(o.table)}(${o.columns})`;
    case "set_default": return `set_default:${t(o.table)}.${o.column}=${o.default.value ?? o.default.kind}`;
    case "set_fk_action": return `set_fk_action:${t(o.table)}>${o.onDelete}`;
    case "grant": return `grant:${o.role}[${o.privileges}]`;
    case "create_enum": case "create_role": return `${o.kind}:${o.name}`;
    default: return `${o.kind}:${t(o.table)}${o.column ? "." + o.column : ""}`;
  }
};

const status = await (await fetch(base + "/status")).json();
if (!status.connected || !status.jev) throw new Error("The app must be connected to a scratch database, with TYPESAFE_API_KEY set");
console.log(`database ${status.connection.database} · ${RUNS} runs each\n`);
let bad = 0, tokens = 0, ms = 0, calls = 0;
for (const [request, expect, preset] of CASES) {
  const seen = new Map();
  let weakest = 1;
  for (let i = 0; i < RUNS; i++) {
    const r = await post("/create/interpret", { request, ops: preset ?? [] });
    if (r.error) { seen.set(`ERROR ${r.error}`, 1); continue; }
    const added = new Set(r.added);
    const s = preset ? r.draft.ops.map(sig).join(" ") : r.draft.ops.filter((o) => added.has(o.id)).map(sig).join(" ") || "(nothing staged)";
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
