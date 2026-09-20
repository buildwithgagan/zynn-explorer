import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Saved connections live in a git-ignored, owner-only file next to the project.
// Passwords in it never leave the server: the browser only ever sees `publicView`.
const FILE = process.env.PGX_CONNECTIONS
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "connections.local.json");

async function readAll() {
  try {
    const list = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(list) ? list.filter((c) => c && c.name && c.host && c.user) : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw Object.assign(new Error(`Could not read ${path.basename(FILE)}: ${err.message}`), { status: 500 });
  }
}

async function writeAll(list) {
  await fs.writeFile(FILE, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(FILE, 0o600);
}

const publicView = (c) => ({
  name: c.name, host: c.host, port: c.port, database: c.database, user: c.user,
  ssl: Boolean(c.ssl), needsPassword: Boolean(c.askPassword) && !c.password,
});

export async function list() {
  return (await readAll()).map(publicView);
}

/** Full config for connecting, password included. Server-side use only. */
export async function get(name) {
  const found = (await readAll()).find((c) => c.name === name);
  if (!found) throw Object.assign(new Error(`No saved connection named "${name}"`), { status: 404 });
  return found;
}

export async function save(name, config) {
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) throw Object.assign(new Error("Give the connection a name to save it"), { status: 400 });
  const entry = {
    name: clean, host: config.host, port: config.port, database: config.database, user: config.user,
    ...(config.password ? { password: config.password } : {}),
    ...(config.ssl ? { ssl: true } : {}),
  };
  const all = await readAll();
  const at = all.findIndex((c) => c.name === clean);
  if (at >= 0) all[at] = entry; else all.push(entry);
  await writeAll(all);
  return publicView(entry);
}

export async function remove(name) {
  const all = await readAll();
  await writeAll(all.filter((c) => c.name !== name));
  return { removed: name };
}
