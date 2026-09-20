import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import * as introspect from "./introspect.js";
import * as nl from "./nl/index.js";
import * as create from "./create/index.js";
import * as saved from "./saved.js";
import { invalidateModel } from "./nl/model.js";
import { isConfigured as jevConfigured } from "./jev.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4477);
const HOST = "127.0.0.1"; // holds live database credentials: never listen on other interfaces
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

// Reject cross-origin browser requests so another site cannot drive the connected database.
app.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  if (origin && new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Cross-origin request refused" });
  next();
});

/**
 * An error's message, never blank. Connecting to "localhost" tries ::1 and 127.0.0.1; when both
 * fail Node raises an AggregateError whose own message is empty and whose reasons are in `.errors`.
 */
function errorText(err) {
  if (err?.message) return err.message;
  const inner = [...new Set((err?.errors ?? []).map((e) => e?.message).filter(Boolean))];
  return inner.join("; ") || err?.code || "The request failed, and the server gave no reason.";
}

const route = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const status = err.status ?? (err.code ? 400 : 500); // pg errors carry a SQLSTATE code
    res.status(status).json({ error: errorText(err), code: err.code, position: err.position, hint: err.hint, detail: err.detail });
  }
};

app.get("/api/status", route(async () => ({
  connected: db.isConnected(),
  connection: db.connectionInfo(),
  jev: jevConfigured(),
  defaultUrl: Boolean(process.env.DATABASE_URL),
})));

app.post("/api/connect", route(async (req) => {
  const body = req.body ?? {};
  invalidateModel();
  let info;
  if (body.useDefault) info = await db.connect({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" });
  // A saved connection is resolved here, so its password never travels through the browser.
  else if (body.saved) info = await db.connect(await saved.get(String(body.saved)));
  else info = await db.connect(body);
  if (body.saveAs) await saved.save(body.saveAs, db.currentConfig());
  return info;
}));

app.get("/api/saved", route(() => saved.list()));
app.delete("/api/saved/:name", route((req) => saved.remove(req.params.name)));

app.post("/api/switch-database", route(async (req) => {
  invalidateModel();
  return db.switchDatabase(req.body?.database);
}));

app.post("/api/disconnect", route(async () => {
  invalidateModel();
  await db.disconnect();
  return { connected: false };
}));

app.get("/api/tree", route(() => introspect.tree()));
app.get("/api/overview", route(() => introspect.overview()));
app.get("/api/relation/:schema/:name", route((req) => introspect.relation(req.params.schema, req.params.name)));
app.post("/api/relation/:schema/:name/rows", route((req) => introspect.browse(req.params.schema, req.params.name, req.body ?? {})));
app.get("/api/function/:oid", route((req) => introspect.functionDetail(req.params.oid)));
app.get("/api/sequences", route(() => introspect.sequences()));
app.get("/api/roles", route(() => introspect.roles()));
app.get("/api/activity", route(() => introspect.activity()));
app.get("/api/settings", route(() => introspect.settings()));
app.get("/api/databases", route(() => introspect.databases()));
app.get("/api/foreign-keys", route(() => introspect.foreignKeys()));
app.get("/api/search", route((req) => introspect.search(String(req.query.q ?? ""))));

app.post("/api/sql", route(async (req) => {
  const { sql, write = false, explain } = req.body ?? {};
  if (!sql || !String(sql).trim()) throw Object.assign(new Error("Nothing to run"), { status: 400 });
  let text = String(sql);
  if (explain === "plan") text = `explain (format text) ${text}`;
  // EXPLAIN ANALYZE executes the statement, so it stays inside the read-only transaction unless write is on.
  if (explain === "analyze") text = `explain (analyze, buffers, format text) ${text}`;
  const result = await db.runSql(text, [], { write: Boolean(write) });
  if (write) invalidateModel();
  return result;
}));

app.post("/api/nl/ask", route(async (req) => {
  const request = String(req.body?.request ?? "").trim();
  if (!request) throw Object.assign(new Error("Ask a question first"), { status: 400 });
  if (request.length > 600) throw Object.assign(new Error("Keep the question under 600 characters"), { status: 400 });
  return nl.answer(request, { mainOverride: req.body.mainOverride, context: req.body.context });
}));

app.get("/api/nl/suggestions", route(() => nl.suggestions()));
app.post("/api/nl/rerun", route((req) => nl.rerun(req.body?.plan)));

// Creator: natural-language schema design. A draft is a list of ops; nothing reaches the database before /apply.
app.post("/api/create/interpret", route((req) => create.interpret(req.body)));
app.post("/api/create/draft/compile", route((req) => create.compile(req.body)));
app.post("/api/create/apply", route((req) => create.apply(req.body)));
app.post("/api/create/database", route((req) => create.createDatabase(req.body)));
app.post("/api/create/advise", route((req) => create.advise(req.body)));
app.post("/api/create/seed", route((req) => create.seed(req.body)));
app.get("/api/create/history", route(() => create.listHistory()));
app.post("/api/create/undo", route((req) => create.undo(req.body)));
app.get("/api/create/starters", route(() => create.starters()));
app.get("/api/create/export", route(() => create.exportSql()));

app.listen(PORT, HOST, async () => {
  console.log(`Zynn Explorer → http://localhost:${PORT}`);
  if (!jevConfigured()) console.log("TYPESAFE_API_KEY is not set: natural-language queries are disabled.");
  if (process.env.DATABASE_URL) {
    try {
      const info = await db.connect({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" });
      console.log(`Connected to ${info.database} as ${info.user}`);
    } catch (err) {
      console.log(`Could not connect with DATABASE_URL: ${err.message}`);
    }
  }
});
