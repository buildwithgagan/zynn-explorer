import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

// Return int8 / numeric as strings (pg default) but parse int8 counts when safe.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

// Dates and timestamps stay as Postgres prints them; JS Date would shift and truncate them.
for (const oid of [1082, 1114, 1184, 1083, 1266, 1186]) pg.types.setTypeParser(oid, (v) => v);

let pool = null;
let info = null;

export function isConnected() {
  return pool !== null;
}

export function connectionInfo() {
  return info;
}

function describe(config) {
  const c = new pg.Client(config);
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    ssl: Boolean(config.ssl),
  };
}

let baseConfig = null; // what the user connected with; reused when switching database

function buildConfig(input) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  let config;
  if (typeof input.connectionString === "string" && input.connectionString.trim()) {
    // Parsed into fields up front: pg lets a connection string override explicit fields,
    // which would make switching database impossible.
    if (!/^postgres(ql)?:\/\//i.test(input.connectionString.trim())) throw fail("A connection URL starts with postgres:// or postgresql://");
    let parsed;
    try {
      parsed = parseConnectionString(input.connectionString.trim());
    } catch {
      throw fail("That connection URL could not be parsed");
    }
    if (!parsed.host) throw fail("The connection URL needs a host");
    config = { host: parsed.host, port: Number(parsed.port || 5432), user: parsed.user || undefined, database: parsed.database || undefined };
    if (parsed.password) config.password = parsed.password;
    if (parsed.ssl) config.ssl = { rejectUnauthorized: false };
  } else {
    const host = String(input.host ?? "").trim();
    const user = String(input.user ?? "").trim();
    const port = Number(input.port || 5432);
    if (!host) throw fail("Host is required");
    if (!user) throw fail("User is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("Port must be between 1 and 65535");
    config = { host, port, user, database: String(input.database ?? "").trim() || user };
    if (input.password) config.password = String(input.password);
  }
  if (input.ssl) config.ssl = { rejectUnauthorized: false };
  return config;
}

async function open(config) {
  const next = new pg.Pool({
    ...config, max: 6, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000, application_name: "zynn-explorer",
  });
  next.on("error", () => {}); // idle client errors must not crash the server
  try {
    const { rows } = await next.query(
      "select version() as version, current_database() as database, current_user as usr"
    );
    const previous = pool;
    pool = next;
    baseConfig = config;
    info = { ...describe(config), version: rows[0].version, user: rows[0].usr, database: rows[0].database };
    if (previous) previous.end().catch(() => {});
    return info;
  } catch (err) {
    next.end().catch(() => {});
    throw err;
  }
}

/** Connect with either { connectionString } or { host, port, database, user, password }, plus optional ssl. */
export async function connect(input) {
  return open(buildConfig(input ?? {}));
}

/** The live connection's config, password included. Server-side only: used to save a connection. */
export function currentConfig() {
  return baseConfig ? { ...baseConfig, ssl: Boolean(baseConfig.ssl) } : null;
}

/** Reconnect to another database on the same server with the credentials already in memory. */
export async function switchDatabase(database) {
  if (!baseConfig) throw Object.assign(new Error("Not connected to a database"), { status: 409 });
  const name = String(database ?? "").trim();
  if (!name) throw Object.assign(new Error("Database name is required"), { status: 400 });
  // `database` overrides the one inside a connection string, so both config shapes work.
  return open({ ...baseConfig, database: name });
}

export async function disconnect() {
  const previous = pool;
  pool = null;
  info = null;
  baseConfig = null;
  if (previous) await previous.end().catch(() => {});
}

function requirePool() {
  if (!pool) {
    const err = new Error("Not connected to a database");
    err.status = 409;
    throw err;
  }
  return pool;
}

/** Catalog / internal queries. */
export async function query(text, params = []) {
  return requirePool().query(text, params);
}

/**
 * Run user-facing SQL inside a transaction with a statement timeout.
 * Read-only unless `write` is set; read-only work is always rolled back.
 */
export async function runSql(text, params = [], { write = false, timeoutMs = 30_000, rowLimit = 5_000 } = {}) {
  const client = await requirePool().connect();
  const started = performance.now();
  try {
    await client.query(write ? "begin" : "begin read only");
    await client.query(`set local statement_timeout = ${Number(timeoutMs) | 0}`);
    const raw = await client.query({ text, values: params, rowMode: "array" });
    await client.query(write ? "commit" : "rollback");

    // Multi-statement input returns an array of results; report the last one.
    const result = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const rows = result.rows ?? [];
    return {
      command: result.command,
      rowCount: result.rowCount,
      fields: (result.fields ?? []).map((f) => ({ name: f.name, typeId: f.dataTypeID })),
      rows: rows.slice(0, rowLimit),
      truncated: rows.length > rowLimit,
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn(exec)` on one client inside one transaction, so a migration either lands whole or not at all.
 * `exec(sql, params)` runs a single statement. With `dryRun` the work is always rolled back.
 */
export async function withTransaction(fn, { lockTimeoutMs = 3_000, statementTimeoutMs = 60_000, dryRun = false } = {}) {
  const client = await requirePool().connect();
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = ${Number(lockTimeoutMs) | 0}`);
    await client.query(`set local statement_timeout = ${Number(statementTimeoutMs) | 0}`);
    await client.query("set local standard_conforming_strings = on");
    const value = await fn((text, params = []) => client.query({ text, values: params, rowMode: "array" }));
    await client.query(dryRun ? "rollback" : "commit");
    return value;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** CREATE DATABASE cannot run inside a transaction, so it goes straight to the pool. */
export async function createDatabase(name) {
  await requirePool().query(`create database ${quoteIdent(name)}`);
}

/** A string literal. Relies on standard_conforming_strings, which withTransaction switches on. */
export function quoteLiteral(value) {
  const s = String(value);
  if (s.includes("\0")) throw Object.assign(new Error("Text cannot contain a NUL character"), { status: 400 });
  return "'" + s.replace(/'/g, "''") + "'";
}

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function qualified(schema, name) {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
