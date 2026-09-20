import { quoteIdent, qualified, quoteLiteral } from "../db.js";
import { topoTables } from "./design.js";
import { typeLabel, CHECKS, ON_DELETE, POLICY_COMMANDS } from "./types.js";

// The schema and its history as SQL files, so a database designed in Create can leave this machine.
// Nothing here is executed by the app. Where the design only has Postgres's own text for something
// (a hand-written check, an unusual default, an index on an expression), that text is used as given.

const pad = (n) => String(n).padStart(4, "0");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "migration";
const header = (lines) => lines.map((l) => `-- ${l}`).join("\n") + "\n\n";

function defaultSql(d) {
  if (!d) return null;
  if (d.raw) return d.raw;
  switch (d.kind) {
    case "now": return "now()";
    case "now_plus": return `now() + interval '${Number(d.amount) | 0} ${d.unit}'`;
    case "uuid": return "gen_random_uuid()";
    case "current_date": return "CURRENT_DATE";
    case "bool": return d.value ? "true" : "false";
    case "number": return String(Number(d.value));
    case "empty_json": return "'{}'::jsonb";
    default: return quoteLiteral(d.value);
  }
}

const typeSql = (design, type) => {
  if (type.enum) { const e = design.enums[type.enum]; return e ? qualified(e.schema, e.name) : type.enum; }
  return typeLabel(type);
};

/** The whole schema as it stands, in an order that runs on an empty database. */
export function schemaSql(design, { at = new Date() } = {}) {
  const out = [header([`${design.database}: schema as of ${at.toISOString()}`, "Written by Zynn Explorer from the live catalog. Runs on an empty database.", "Roles are cluster-wide, so they are listed at the end as comments rather than created here."])];
  out.push("BEGIN;\n");
  for (const name of design.schemas) if (name !== "public") out.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(name)};\n`);
  for (const e of Object.values(design.enums)) out.push(`CREATE TYPE ${qualified(e.schema, e.name)} AS ENUM (${e.values.map(quoteLiteral).join(", ")});\n`);

  const { order, deferred } = topoTables(design);
  const late = new Set(deferred.map((d) => `${d.table}\0${d.fk}`));
  const tail = [];
  for (const id of order) {
    const t = design.tables[id];
    const target = qualified(t.schema, t.name);
    const lines = t.columns.map((c) => {
      let line = `  ${quoteIdent(c.name)} ${typeSql(design, c.type)}`;
      if (c.identity) line += ` GENERATED ${c.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (c.generated) line += ` GENERATED ALWAYS AS (${c.generatedExpr ?? "NULL /* expression not available */"}) STORED`;
      else if (c.default) line += ` DEFAULT ${defaultSql(c.default)}`;
      if (!c.nullable && !c.identity) line += " NOT NULL";
      return line;
    });
    if (t.pk) lines.push(`  CONSTRAINT ${quoteIdent(t.pk.name)} PRIMARY KEY (${t.pk.columns.map(quoteIdent).join(", ")})`);
    for (const u of t.uniques) lines.push(`  CONSTRAINT ${quoteIdent(u.name)} UNIQUE (${u.columns.map(quoteIdent).join(", ")})`);
    for (const k of t.checks) lines.push(`  CONSTRAINT ${quoteIdent(k.name)} ${k.definition ?? `CHECK (${CHECKS[k.template](quoteIdent(k.column))})`}`);
    const fkLine = (f) => {
      const p = design.tables[f.refTable];
      return `CONSTRAINT ${quoteIdent(f.name)} FOREIGN KEY (${f.columns.map(quoteIdent).join(", ")}) REFERENCES ${p ? qualified(p.schema, p.name) : f.refTable} (${f.refColumns.map(quoteIdent).join(", ")}) ON DELETE ${ON_DELETE[f.onDelete] ?? "NO ACTION"}`;
    };
    for (const f of t.fks) {
      // A link that closes a cycle, or points at the table itself before its key exists, is added once every table is there.
      if (late.has(`${id}\0${f.name}`)) tail.push(`ALTER TABLE ${target} ADD ${fkLine(f)};\n`);
      else lines.push(`  ${fkLine(f)}`);
    }
    out.push(`CREATE TABLE ${target} (\n${lines.join(",\n")}\n);\n`);
    for (const i of t.indexes) out.push(`${i.definition ?? `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(i.name)} ON ${target} (${i.columns.map(quoteIdent).join(", ")})`};\n`);
    if (t.comment) out.push(`COMMENT ON TABLE ${target} IS ${quoteLiteral(t.comment)};\n`);
    for (const c of t.columns) if (c.comment) out.push(`COMMENT ON COLUMN ${target}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};\n`);
  }
  out.push(...tail);
  for (const v of Object.values(design.views ?? {})) if (v.definition) out.push(`CREATE VIEW ${qualified(v.schema, v.name)} AS\n${v.definition.trim().replace(/;$/, "")};\n`);

  const access = [];
  const roles = new Set();
  for (const t of Object.values(design.tables)) {
    const target = qualified(t.schema, t.name);
    if (t.rls) access.push(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`);
    for (const p of t.policies) {
      p.roles.forEach((r) => r !== "public" && roles.add(r));
      access.push(`CREATE POLICY ${quoteIdent(p.name)} ON ${target} FOR ${POLICY_COMMANDS[p.command] ?? "ALL"} TO ${p.roles.map((r) => (r === "public" ? "PUBLIC" : quoteIdent(r))).join(", ")}` +
        (p.using ? ` USING (${p.using})` : "") + (p.check ? ` WITH CHECK (${p.check})` : "") + ";");
    }
  }
  out.push("COMMIT;\n");

  // Grants depend on roles that may not exist where this runs, so they are kept apart and commented.
  const grants = [];
  for (const t of Object.values(design.tables)) for (const g of t.grants) { roles.add(g.role); grants.push(`GRANT ${g.privileges.join(", ")} ON ${qualified(t.schema, t.name)} TO ${quoteIdent(g.role)};`); }
  const owned = new Set(["postgres", "PUBLIC", "public"]);
  const needed = [...roles].filter((r) => !owned.has(r)).sort();
  if (access.length || needed.length) {
    out.push(header(["Access. Uncomment once the roles exist on the target server."]).trimEnd());
    for (const r of needed) out.push(`-- CREATE ROLE ${quoteIdent(r)} NOLOGIN;`);
    const schemas = [...new Set(Object.values(design.tables).map((t) => t.schema))];
    for (const r of needed) for (const sc of schemas) out.push(`-- GRANT USAGE ON SCHEMA ${quoteIdent(sc)} TO ${quoteIdent(r)};`);
    for (const g of grants.filter((x) => needed.some((r) => x.endsWith(`TO ${quoteIdent(r)};`)))) out.push(`-- ${g}`);
    for (const a of access) out.push(`-- ${a}`);
    out.push("");
  }
  return out.join("\n");
}

/** One numbered file per migration Create applied here, oldest first. Sample data is noted, not reproduced. */
export function migrationFiles(entries, database) {
  const oldestFirst = [...entries].reverse();
  return oldestFirst.map((e, i) => {
    const statements = (e.sql ?? []).map((sql) => (/^-- sample data:/.test(sql) ? `${sql}\n-- (rows were generated by Zynn Explorer; they are not part of the schema and are not reproduced here)` : sql));
    const schemaChanges = statements.filter((x) => !x.startsWith("--")).length;
    return {
      name: `${pad(i + 1)}_${slug(e.summary)}.sql`,
      content: header([`${database}: migration ${i + 1} of ${oldestFirst.length}`, e.summary, `Applied ${e.at} through Zynn Explorer`]) +
        (schemaChanges ? `BEGIN;\n\n${statements.join("\n\n")}\n\nCOMMIT;\n` : `${statements.join("\n\n")}\n`),
    };
  });
}

/** A tar archive (ustar) of text files, so numbered migrations download as one file without any dependency. */
export function tar(files, mtime = Math.floor(Date.now() / 1000)) {
  const enc = new TextEncoder();
  const blocks = [];
  for (const f of files) {
    const body = enc.encode(f.content);
    const head = new Uint8Array(512);
    const put = (text, at, len) => head.set(enc.encode(text).slice(0, len), at);
    put(f.name, 0, 100);
    put("0000644\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    put(mtime.toString(8).padStart(11, "0") + "\0", 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\0", 257, 6); put("00", 263, 2);
    const sum = head.reduce((a, b) => a + b, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(head, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}
