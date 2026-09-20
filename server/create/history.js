import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// A local log of applied migrations, per database. Kept in a file rather than in the database so it never
// shows up as a table in the explorer, in Ask or in the advisor, and needs no privileges to write.

const FILE = process.env.PGX_MIGRATIONS
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations.local.json");
const MAX_PER_DATABASE = 200;

async function readAll() {
  try {
    const data = JSON.parse(await readFile(FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function writeAll(data) {
  await writeFile(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(FILE, 0o600);
}

export const databaseKey = (info) => `${info.host}:${info.port}/${info.database}`;

export async function list(key) {
  return (await readAll())[key] ?? [];
}

export async function append(key, entry) {
  const all = await readAll();
  const saved = { id: randomUUID(), at: new Date().toISOString(), ...entry };
  all[key] = [saved, ...(all[key] ?? [])].slice(0, MAX_PER_DATABASE);
  await writeAll(all);
  return saved;
}

export async function get(key, id) {
  return (await list(key)).find((e) => e.id === id) ?? null;
}
