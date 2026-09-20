import { columnFromArchetype } from "../archetypes.js";
import { newId } from "../ops.js";

// Whole-domain designs. Jev cannot invent a schema, so the designs live here as data: Jev picks the
// blueprint that fits a request, which optional parts it asks for, and which of the user's own words
// rename an entity. Everything below is declarative, so adding a domain is adding an object.
//
// entity: { id, table, describe, aliases?, columns: [[name, archetype, overrides?]], refs?: [{ to, column?, onDelete?, required? }], join? }
//   - a column override `{ enum: [...] }` creates an enum type for it, defaulting to the first value
//   - `join: true` marks a many-to-many table: no surrogate id, the primary key is the pair of references

const person = (extra = []) => [["name", "person_name"], ["email", "email"], ["phone", "phone"], ...extra];
const REQ = { nullable: false };

const customers = { id: "customers", table: "customers", describe: "people who buy or are served", aliases: ["clients", "buyers", "shoppers"], columns: person() };
const addresses = { id: "addresses", table: "addresses", describe: "postal addresses of a customer", columns: [["line1", "address_line", REQ], ["line2", "address_line"], ["city", "city", REQ], ["postal_code", "postal_code"], ["country", "country", REQ]], refs: [{ to: "customers", onDelete: "cascade" }] };
const categories = { id: "categories", table: "categories", describe: "groupings of items", aliases: ["collections", "departments"], columns: [["name", "title"], ["slug", "slug"]] };
const products = { id: "products", table: "products", describe: "things that are sold or stocked", aliases: ["items", "goods", "merchandise"], columns: [["name", "title"], ["sku", "external_id", REQ], ["description", "long_text"], ["price", "money"], ["is_active", "boolean_flag", { default: { kind: "bool", value: true } }]], refs: [{ to: "categories", required: false, onDelete: "set_null" }] };
const tags = { id: "tags", table: "tags", describe: "free-form labels", aliases: ["labels", "topics"], columns: [["name", "short_label", { nullable: false, unique: true }]] };
const invoices = (owner) => ({ id: "invoices", table: "invoices", describe: "bills issued", aliases: ["bills"], columns: [["number", "external_id", REQ], ["status", "status", { enum: ["draft", "sent", "paid", "void"] }], ["total", "money"], ["due_date", "date"], ["issued_at", "timestamp"]], refs: [{ to: owner }] });
const payments = (parent) => ({ id: "payments", table: "payments", describe: "money received", aliases: ["transactions"], columns: [["amount", "money"], ["method", "status", { enum: ["card", "cash", "bank_transfer"] }], ["paid_at", "timestamp", REQ], ["reference", "external_id"]], refs: [{ to: parent }] });

export const BLUEPRINTS = [
  {
    id: "ecommerce", title: "Online store",
    describe: "Selling products to customers: a shop, store, e-commerce site, marketplace, catalogue with orders and checkout.",
    entities: [customers, addresses, categories, products,
      { id: "orders", table: "orders", describe: "purchases made by a customer", aliases: ["purchases", "sales"], columns: [["status", "status", { enum: ["pending", "paid", "shipped", "delivered", "cancelled"] }], ["total", "money"], ["placed_at", "timestamp", { nullable: false, default: { kind: "now" } }]], refs: [{ to: "customers" }, { to: "addresses", column: "shipping_address_id", required: false, onDelete: "set_null" }] },
      { id: "order_items", table: "order_items", describe: "the products in an order", aliases: ["line_items"], columns: [["quantity", "quantity", { default: { kind: "number", value: 1 }, check: "positive" }], ["unit_price", "money"]], refs: [{ to: "orders", onDelete: "cascade" }, { to: "products" }] },
      payments("orders")],
    optional: [
      { id: "reviews", describe: "customers can review or rate products", entities: [{ id: "reviews", table: "reviews", describe: "product reviews", aliases: ["ratings"], columns: [["rating", "rating", REQ], ["body", "long_text"]], refs: [{ to: "products", onDelete: "cascade" }, { to: "customers", onDelete: "cascade" }] }] },
      { id: "coupons", describe: "discount codes, coupons or promotions", entities: [{ id: "coupons", table: "coupons", describe: "discount codes", aliases: ["discounts", "promotions"], columns: [["code", "slug"], ["percent_off", "percentage", REQ], ["expires_at", "timestamp"]] }] },
    ],
  },
  {
    id: "blog_cms", title: "Blog or CMS",
    describe: "Publishing written content: a blog, news site, magazine, content management system with posts, authors and comments.",
    entities: [
      { id: "authors", table: "authors", describe: "people who write", aliases: ["writers", "editors"], columns: person([["bio", "long_text"]]) },
      categories, tags,
      { id: "posts", table: "posts", describe: "published articles", aliases: ["articles", "stories", "entries"], columns: [["title", "title"], ["slug", "slug"], ["body", "long_text", REQ], ["status", "status", { enum: ["draft", "published", "archived"] }], ["published_at", "timestamp"]], refs: [{ to: "authors" }, { to: "categories", required: false, onDelete: "set_null" }] },
      { id: "post_tags", table: "post_tags", describe: "which tags a post has", join: true, columns: [], refs: [{ to: "posts", onDelete: "cascade" }, { to: "tags", onDelete: "cascade" }] },
      { id: "comments", table: "comments", describe: "reader comments on a post", aliases: ["replies"], columns: [["author_name", "person_name"], ["body", "long_text", REQ], ["is_approved", "boolean_flag"]], refs: [{ to: "posts", onDelete: "cascade" }] }],
    optional: [
      { id: "media", describe: "uploaded images, files or media attached to posts", entities: [{ id: "media", table: "media_files", describe: "uploaded files", aliases: ["attachments", "images", "uploads"], columns: [["url", "url", REQ], ["alt_text", "plain_text"], ["mime_type", "short_label"]], refs: [{ to: "posts", required: false, onDelete: "set_null" }] }] },
    ],
  },
  {
    id: "crm", title: "CRM",
    describe: "Managing sales relationships: a CRM with companies, contacts, leads, deals, a sales pipeline and follow-up activities.",
    entities: [
      { id: "sales_reps", table: "sales_reps", describe: "staff who own deals", aliases: ["reps", "owners", "salespeople"], columns: person() },
      { id: "companies", table: "companies", describe: "organisations you sell to", aliases: ["accounts", "organizations", "organisations"], columns: [["name", "title"], ["website", "url"], ["industry", "short_label"], ["city", "city"], ["country", "country"]] },
      { id: "contacts", table: "contacts", describe: "people at those companies", aliases: ["leads", "people"], columns: person([["job_title", "short_label"]]), refs: [{ to: "companies", required: false, onDelete: "set_null" }] },
      { id: "deals", table: "deals", describe: "sales opportunities", aliases: ["opportunities"], columns: [["name", "title"], ["stage", "status", { enum: ["lead", "qualified", "proposal", "won", "lost"] }], ["amount", "money"], ["expected_close_date", "date"]], refs: [{ to: "companies" }, { to: "contacts", required: false, onDelete: "set_null" }, { to: "sales_reps", column: "owner_id", required: false, onDelete: "set_null" }] },
      { id: "activities", table: "activities", describe: "calls, emails and meetings logged against a deal", aliases: ["interactions", "touchpoints"], columns: [["kind", "status", { enum: ["call", "email", "meeting", "note"] }], ["notes", "long_text"], ["happened_at", "timestamp", { nullable: false, default: { kind: "now" } }]], refs: [{ to: "deals", onDelete: "cascade" }, { to: "sales_reps", required: false, onDelete: "set_null" }] }],
    optional: [],
  },
  {
    id: "saas_multitenant", title: "Multi-tenant SaaS",
    describe: "A software-as-a-service product: organisations or workspaces with member users, plans, subscriptions and billing.",
    entities: [
      { id: "organizations", table: "organizations", describe: "tenant accounts", aliases: ["workspaces", "teams", "tenants", "accounts"], columns: [["name", "title"], ["slug", "slug"]] },
      { id: "users", table: "users", describe: "people who sign in", aliases: ["members"], columns: [["name", "person_name"], ["email", "email"], ["last_login_at", "timestamp"]] },
      { id: "memberships", table: "memberships", describe: "which users belong to which organization, and as what", columns: [["role", "status", { enum: ["owner", "admin", "member"] }]], refs: [{ to: "organizations", onDelete: "cascade" }, { to: "users", onDelete: "cascade" }], unique: [["organization", "user"]] },
      { id: "plans", table: "plans", describe: "pricing tiers", aliases: ["tiers"], columns: [["name", "title"], ["monthly_price", "money"], ["seat_limit", "count"]] },
      { id: "subscriptions", table: "subscriptions", describe: "an organization's plan over time", columns: [["status", "status", { enum: ["trialing", "active", "past_due", "cancelled"] }], ["started_at", "timestamp", { nullable: false, default: { kind: "now" } }], ["ends_at", "timestamp"]], refs: [{ to: "organizations", onDelete: "cascade" }, { to: "plans" }] },
      invoices("organizations")],
    optional: [
      { id: "api_keys", describe: "API keys or access tokens", entities: [{ id: "api_keys", table: "api_keys", describe: "API credentials", aliases: ["tokens"], columns: [["label", "plain_text"], ["token", "uuid_token"], ["revoked_at", "timestamp"]], refs: [{ to: "organizations", onDelete: "cascade" }] }] },
      { id: "audit", describe: "an audit log or activity history of who did what", entities: [{ id: "audit_logs", table: "audit_logs", describe: "who did what", aliases: ["audit_trail", "events"], columns: [["action", "short_label", REQ], ["details", "json_data"]], refs: [{ to: "organizations", onDelete: "cascade" }, { to: "users", required: false, onDelete: "set_null" }] }] },
    ],
  },
  {
    id: "booking_clinic", title: "Clinic or booking system",
    describe: "Appointments with professionals: a clinic, vet, dentist, salon, studio or any practice where clients book visits with staff.",
    entities: [
      { id: "patients", table: "patients", describe: "who is seen or treated", aliases: ["clients", "pets", "animals", "customers", "guests"], columns: [["name", "person_name"], ["date_of_birth", "date"], ["notes", "long_text"]] },
      { id: "practitioners", table: "practitioners", describe: "staff who see them", aliases: ["doctors", "vets", "dentists", "stylists", "therapists", "staff", "providers"], columns: person([["specialty", "short_label"]]) },
      { id: "services", table: "services", describe: "what can be booked", aliases: ["treatments", "procedures"], columns: [["name", "title"], ["duration", "duration"], ["price", "money"]] },
      { id: "appointments", table: "appointments", describe: "a booked visit", aliases: ["bookings", "visits", "reservations"], columns: [["starts_at", "timestamp", REQ], ["ends_at", "timestamp"], ["status", "status", { enum: ["booked", "confirmed", "completed", "cancelled", "no_show"] }], ["notes", "long_text"]], refs: [{ to: "patients" }, { to: "practitioners" }, { to: "services", required: false, onDelete: "set_null" }] }],
    optional: [
      { id: "owners", describe: "the one being seen has an owner or guardian, as with pets at a vet or children", entities: [{ id: "owners", table: "owners", describe: "the person responsible for a patient", aliases: ["guardians", "parents"], columns: person() }], addRefs: [{ from: "patients", to: "owners" }] },
      { id: "billing", describe: "invoices, billing or payments for visits", entities: [invoices("patients"), payments("invoices")] },
      { id: "prescriptions", describe: "prescriptions or medication", entities: [{ id: "prescriptions", table: "prescriptions", describe: "medication prescribed at a visit", aliases: ["medications"], columns: [["medication", "title"], ["dosage", "plain_text"], ["instructions", "long_text"]], refs: [{ to: "appointments", onDelete: "cascade" }] }] },
    ],
  },
  {
    id: "inventory", title: "Inventory",
    describe: "Tracking stock: inventory or warehouse management with suppliers, stock levels, purchase orders and stock movements.",
    entities: [
      { id: "suppliers", table: "suppliers", describe: "who you buy from", aliases: ["vendors"], columns: [["name", "title"], ["email", "email", { unique: false, nullable: true }], ["phone", "phone"]] },
      categories, { ...products, refs: [...products.refs, { to: "suppliers", required: false, onDelete: "set_null" }] },
      { id: "warehouses", table: "warehouses", describe: "where stock is kept", aliases: ["locations", "stores"], columns: [["name", "title"], ["city", "city"]] },
      { id: "stock_levels", table: "stock_levels", describe: "how much of a product is in a warehouse", columns: [["quantity", "quantity"], ["reorder_point", "quantity"]], refs: [{ to: "products", onDelete: "cascade" }, { to: "warehouses", onDelete: "cascade" }], unique: [["product", "warehouse"]] },
      { id: "purchase_orders", table: "purchase_orders", describe: "orders placed with a supplier", columns: [["status", "status", { enum: ["draft", "ordered", "received", "cancelled"] }], ["ordered_at", "timestamp"], ["expected_date", "date"]], refs: [{ to: "suppliers" }] },
      { id: "purchase_order_items", table: "purchase_order_items", describe: "the products on a purchase order", columns: [["quantity", "quantity", { check: "positive", default: { kind: "number", value: 1 } }], ["unit_cost", "money"]], refs: [{ to: "purchase_orders", onDelete: "cascade" }, { to: "products" }] },
      { id: "stock_movements", table: "stock_movements", describe: "every change to stock, and why", aliases: ["adjustments"], columns: [["change", "count", REQ], ["reason", "status", { enum: ["purchase", "sale", "adjustment", "transfer"] }]], refs: [{ to: "products" }, { to: "warehouses" }] }],
    optional: [],
  },
  {
    id: "lms", title: "Courses and learning",
    describe: "Teaching: a school, course platform or learning management system with courses, lessons, students and enrolments.",
    entities: [
      { id: "instructors", table: "instructors", describe: "who teaches", aliases: ["teachers", "tutors"], columns: person([["bio", "long_text"]]) },
      { id: "students", table: "students", describe: "who learns", aliases: ["learners", "pupils"], columns: person() },
      { id: "courses", table: "courses", describe: "what is taught", aliases: ["classes", "programs"], columns: [["title", "title"], ["slug", "slug"], ["description", "long_text"], ["price", "money"], ["is_published", "boolean_flag"]], refs: [{ to: "instructors" }] },
      { id: "lessons", table: "lessons", describe: "the parts of a course", aliases: ["modules", "units"], columns: [["title", "title"], ["position", "count", REQ], ["content", "long_text"], ["video_url", "url"]], refs: [{ to: "courses", onDelete: "cascade" }] },
      { id: "enrollments", table: "enrollments", describe: "a student taking a course", aliases: ["registrations"], columns: [["status", "status", { enum: ["active", "completed", "dropped"] }], ["progress", "percentage"], ["enrolled_at", "timestamp", { nullable: false, default: { kind: "now" } }]], refs: [{ to: "students", onDelete: "cascade" }, { to: "courses", onDelete: "cascade" }], unique: [["student", "course"]] }],
    optional: [
      { id: "assignments", describe: "assignments, homework, quizzes or grades", entities: [
        { id: "assignments", table: "assignments", describe: "work set in a course", aliases: ["homework", "quizzes"], columns: [["title", "title"], ["instructions", "long_text"], ["due_at", "timestamp"]], refs: [{ to: "courses", onDelete: "cascade" }] },
        { id: "submissions", table: "submissions", describe: "a student's answer to an assignment", columns: [["content", "long_text"], ["grade", "percentage"], ["submitted_at", "timestamp", { nullable: false, default: { kind: "now" } }]], refs: [{ to: "assignments", onDelete: "cascade" }, { to: "students", onDelete: "cascade" }] }] },
    ],
  },
  {
    id: "helpdesk", title: "Helpdesk",
    describe: "Customer support: a helpdesk or ticketing system with tickets, support agents and conversations.",
    entities: [customers,
      { id: "agents", table: "agents", describe: "support staff", aliases: ["support_staff", "operators"], columns: person() },
      { id: "tickets", table: "tickets", describe: "support requests", aliases: ["issues", "cases", "requests"], columns: [["subject", "title"], ["status", "status", { enum: ["open", "pending", "solved", "closed"] }], ["priority", "status", { enum: ["low", "normal", "high", "urgent"], default: "normal" }], ["closed_at", "timestamp"]], refs: [{ to: "customers" }, { to: "agents", column: "assignee_id", required: false, onDelete: "set_null" }] },
      { id: "ticket_messages", table: "ticket_messages", describe: "the conversation on a ticket", aliases: ["replies", "messages"], columns: [["body", "long_text", REQ], ["is_internal", "boolean_flag"]], refs: [{ to: "tickets", onDelete: "cascade" }, { to: "agents", required: false, onDelete: "set_null" }] }],
    optional: [
      { id: "tags", describe: "tags or labels on tickets", entities: [tags, { id: "ticket_tags", table: "ticket_tags", describe: "which tags a ticket has", join: true, columns: [], refs: [{ to: "tickets", onDelete: "cascade" }, { to: "tags", onDelete: "cascade" }] }] },
      { id: "articles", describe: "a knowledge base or help articles", entities: [{ id: "articles", table: "articles", describe: "help centre articles", aliases: ["knowledge_base", "faqs"], columns: [["title", "title"], ["slug", "slug"], ["body", "long_text", REQ], ["is_published", "boolean_flag"]] }] },
    ],
  },
  {
    id: "hr", title: "HR",
    describe: "Managing staff: human resources with employees, departments, job positions and leave or time-off requests.",
    entities: [
      { id: "departments", table: "departments", describe: "parts of the organisation", aliases: ["teams", "divisions"], columns: [["name", "title"]] },
      { id: "positions", table: "positions", describe: "job titles", aliases: ["roles", "jobs"], columns: [["title", "title"], ["level", "short_label"]] },
      { id: "employees", table: "employees", describe: "people who work here", aliases: ["staff", "workers"], columns: person([["hire_date", "date", REQ], ["is_active", "boolean_flag", { default: { kind: "bool", value: true } }]]), refs: [{ to: "departments" }, { to: "positions", required: false, onDelete: "set_null" }, { to: "employees", column: "manager_id", required: false, onDelete: "set_null" }] },
      { id: "leave_requests", table: "leave_requests", describe: "time off asked for", aliases: ["time_off", "vacations", "absences"], columns: [["kind", "status", { enum: ["vacation", "sick", "parental", "unpaid"] }], ["start_date", "date", REQ], ["end_date", "date", REQ], ["status", "status", { enum: ["pending", "approved", "rejected"] }]], refs: [{ to: "employees", onDelete: "cascade" }] }],
    optional: [
      { id: "salaries", describe: "salaries, pay or compensation history", entities: [{ id: "salaries", table: "salaries", describe: "what an employee is paid over time", aliases: ["compensation", "pay"], columns: [["amount", "money"], ["effective_from", "date", REQ], ["effective_to", "date"]], refs: [{ to: "employees", onDelete: "cascade" }] }] },
      { id: "reviews", describe: "performance reviews or appraisals", entities: [{ id: "performance_reviews", table: "performance_reviews", describe: "periodic appraisals", aliases: ["appraisals"], columns: [["period", "short_label", REQ], ["rating", "rating"], ["comments", "long_text"]], refs: [{ to: "employees", onDelete: "cascade" }] }] },
    ],
  },
  {
    id: "finance_ledger", title: "Accounting ledger",
    describe: "Bookkeeping: double-entry accounting with a chart of accounts, journal entries, debits and credits.",
    entities: [
      { id: "ledger_accounts", table: "ledger_accounts", describe: "the chart of accounts", aliases: ["accounts", "chart_of_accounts"], columns: [["code", "external_id", REQ], ["name", "title"], ["kind", "status", { enum: ["asset", "liability", "equity", "income", "expense"] }]] },
      { id: "journal_entries", table: "journal_entries", describe: "a dated, balanced set of lines", aliases: ["transactions", "entries"], columns: [["entry_date", "date", REQ], ["memo", "long_text"], ["posted_at", "timestamp"]] },
      { id: "journal_lines", table: "journal_lines", describe: "one debit or credit", aliases: ["postings", "lines"], columns: [["debit", "money", { default: { kind: "number", value: 0 } }], ["credit", "money", { default: { kind: "number", value: 0 } }]], refs: [{ to: "journal_entries", onDelete: "cascade" }, { to: "ledger_accounts" }] }],
    optional: [
      { id: "budgets", describe: "budgets per account and period", entities: [{ id: "budgets", table: "budgets", describe: "planned amounts", columns: [["period", "short_label", REQ], ["amount", "money"]], refs: [{ to: "ledger_accounts", onDelete: "cascade" }] }] },
    ],
  },
];

export const blueprintById = (id) => BLUEPRINTS.find((b) => b.id === id) ?? null;
export const singular = (w) => w.replace(/ies$/, "y").replace(/(ss|us)$/, "$1").replace(/(ch|sh|x|ss)es$/, "$1").replace(/([^s])s$/, "$1");

/** Every entity a blueprint would create with these optional parts switched on. */
export function entitiesOf(blueprint, optional = new Set()) {
  const chosen = blueprint.optional.filter((o) => optional.has(o.id));
  const entities = [...blueprint.entities, ...chosen.flatMap((o) => o.entities)].map((e) => ({ ...e, refs: [...(e.refs ?? [])] }));
  for (const o of chosen) for (const r of o.addRefs ?? []) entities.find((e) => e.id === r.from)?.refs.push({ to: r.to });
  return entities;
}

/**
 * Turn a blueprint into ops, parents before children.
 * @param picks { optional: Set<optionId>, renames: { entityId: tableName }, schema }
 */
export function instantiate(blueprint, { optional = new Set(), renames = {}, schema = "public", existing = new Set() } = {}) {
  const entities = entitiesOf(blueprint, optional);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const tableOf = (id) => renames[id] ?? byId.get(id).table;
  const ordered = [], state = new Map();
  const visit = (e) => {
    state.set(e.id, "open");
    for (const r of e.refs) { const parent = byId.get(r.to); if (parent && parent !== e && !state.has(parent.id)) visit(parent); }
    state.set(e.id, "done");
    ordered.push(e);
  };
  for (const e of entities) if (!state.has(e.id)) visit(e);

  const ops = [], skipped = [];
  for (const e of ordered) {
    const table = tableOf(e.id);
    if (existing.has(`${schema}.${table}`)) { skipped.push(table); continue; }
    const columns = [];
    for (const r of e.refs) {
      if (!byId.has(r.to)) continue;
      const required = r.required !== false;
      columns.push({ name: r.column ?? `${singular(tableOf(r.to))}_id`, ref: { table: `${schema}.${tableOf(r.to)}`, onDelete: r.onDelete ?? "restrict" }, nullable: !required });
    }
    for (const [name, archetype, overrides = {}] of e.columns) {
      const { enum: values, default: def, ...rest } = overrides;
      if (values) {
        const typeName = `${singular(table)}_${name}`;
        ops.push({ id: newId(), kind: "create_enum", schema, name: typeName, values });
        columns.push({ name, archetype, type: { enum: `${schema}.${typeName}` }, nullable: false, default: { kind: "enum_label", value: typeof def === "string" ? def : values[0] } });
      } else columns.push(columnFromArchetype(name, archetype, def === undefined ? rest : { ...rest, default: def }));
    }
    const refColumns = columns.filter((c) => c.ref).map((c) => c.name);
    ops.push({
      id: newId(), kind: "create_table", schema, name: table, columns, comment: e.describe.replace(/^./, (c) => c.toUpperCase()),
      conventions: { id: !e.join, timestamps: !e.join, fkIndex: true }, ...(e.join ? { pk: refColumns } : {}),
    });
    for (const pair of e.unique ?? []) {
      ops.push({ id: newId(), kind: "add_unique", table: `${schema}.${table}`, columns: pair.map((p) => columns.find((c) => c.ref && c.name.startsWith(p))?.name ?? p) });
    }
  }
  return { ops, skipped };
}
