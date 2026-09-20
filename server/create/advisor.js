import { typeLabel } from "./types.js";
import { isReserved } from "./validate.js";

// The schema review a DBA would give, as plain rules over the design. No model is involved:
// every finding is something that can be checked, and most come with the ops that fix it.

const MONEY_NAME = /(^|_)(price|amount|total|cost|fee|salary|balance|subtotal)$/;
const singular = (w) => w.replace(/ies$/, "y").replace(/(ss|us)$/, "$1").replace(/([^s])s$/, "$1");
const leads = (k, columns) => k && columns.every((c, i) => k.columns[i] === c);

/**
 * @param design  the design to review (normally the draft, so fixed findings disappear)
 * @param values  optional: { "schema.table": { column: [known values] } } from pg_stats, for the text-to-enum rule
 */
export function advise(design, values = {}) {
  const findings = [];
  const add = (severity, rule, target, title, why, ops = []) => findings.push({ id: `${rule}:${target}`, severity, rule, target, title, why, ops });
  const tables = Object.entries(design.tables);
  const plural = tables.filter(([, t]) => singular(t.name) !== t.name).length;

  for (const [id, t] of tables) {
    if (!t.pk) {
      const hasId = t.columns.find((c) => c.name === "id" && !c.nullable);
      add("high", "no_pk", id, `${t.name} has no primary key`, "Rows cannot be told apart, updated safely or referenced by other tables. Replication tools also refuse tables without a key.",
        hasId ? [{ kind: "add_pk", table: id, columns: ["id"] }] : []);
    }
    for (const f of t.fks) {
      if (![t.pk, ...t.uniques, ...t.indexes].some((k) => leads(k, f.columns))) {
        add("medium", "fk_index", `${id}.${f.columns.join(",")}`, `${t.name}.${f.columns.join(", ")} is a foreign key with no index`,
          `Postgres does not index foreign keys for you. Joins to ${design.tables[f.refTable]?.name ?? f.refTable} scan the whole table, and deleting a parent row has to as well.`,
          [{ kind: "add_index", table: id, columns: f.columns }]);
      }
    }
    const seen = new Map();
    for (const i of t.indexes) {
      const key = `${i.method}:${i.columns.join(",")}`;
      if (i.columns.length && seen.has(key)) {
        add("low", "duplicate_index", `${id}.${i.name}`, `${t.name} has two indexes on (${i.columns.join(", ")})`, `${i.name} repeats ${seen.get(key)}. Every write pays for both and reads only ever use one.`,
          [{ kind: "drop_index", table: id, name: i.name }]);
      } else seen.set(key, i.name);
    }
    if (t.rls && !t.policies.length) {
      add("high", "rls_no_policy", id, `${t.name} has row-level security on but no policy`, "With no policy, every role except the owner sees an empty table.");
    }
    if (t.name !== t.name.toLowerCase() || /[^a-z0-9_]/.test(t.name)) {
      add("low", "table_case", id, `${t.name} is not snake_case`, "Mixed-case or punctuated names must be double-quoted in every query, forever.");
    } else if (plural > tables.length / 2 && singular(t.name) === t.name && tables.length > 2 && !isReserved(t.name + "s")) {
      add("low", "table_plural", id, `${t.name} is singular; most tables here are plural`, "A schema reads more easily when table names follow one convention.",
        [{ kind: "rename_table", table: id, name: /(s|x|ch|sh)$/.test(t.name) ? t.name + "es" : /[^aeiou]y$/.test(t.name) ? t.name.slice(0, -1) + "ies" : t.name + "s" }]);
    }

    for (const c of t.columns) {
      const at = `${id}.${c.name}`;
      const label = `${t.name}.${c.name}`;
      const inFk = t.fks.some((f) => f.columns.includes(c.name));
      if (c.type.base === "timestamp") {
        add("medium", "timestamp_tz", at, `${label} is a timestamp without a time zone`, "It stores wall-clock digits with no record of where they were taken, so the moment is ambiguous as soon as two time zones are involved. timestamptz stores the instant.",
          [{ kind: "alter_column_type", table: id, column: c.name, type: { base: "timestamptz" } }]);
      }
      if (MONEY_NAME.test(c.name) && (["real", "double precision"].includes(c.type.base) || c.type.raw === "money")) {
        add("high", "float_money", at, `${label} stores money as ${typeLabel(c.type)}`, "Binary floating point cannot represent most decimal fractions, so totals drift by cents. numeric is exact.",
          c.type.raw ? [] : [{ kind: "alter_column_type", table: id, column: c.name, type: { base: "numeric", args: [12, 2] } }]);
      }
      if (c.type.base === "varchar" && c.type.args?.[0] === 255) {
        add("low", "varchar_255", at, `${label} is varchar(255)`, "255 is a habit from other databases. In Postgres text is just as fast, and an arbitrary limit only produces errors later.",
          [{ kind: "alter_column_type", table: id, column: c.name, type: { base: "text" } }]);
      }
      if (c.type.base === "boolean" && c.nullable) {
        add("low", "nullable_boolean", at, `${label} is a yes/no column that can also be empty`, "Three states (true, false, unknown) make every condition on it harder to get right. If empty means no, set a default and make it required.",
          c.default ? [{ kind: "set_not_null", table: id, column: c.name }] : [{ kind: "set_default", table: id, column: c.name, default: { kind: "bool", value: false } }, { kind: "set_not_null", table: id, column: c.name }]);
      }
      if (/^nextval\(/.test(c.default?.raw ?? "")) {
        add("low", "serial", at, `${label} uses serial`, "Identity columns are the SQL-standard replacement: the sequence belongs to the column, and permissions and dumps behave as expected. Worth using for new tables; converting an existing one is a manual job.");
      }
      if (/_id$/.test(c.name) && !inFk && !t.pk?.columns.includes(c.name)) {
        const stem = c.name.slice(0, -3);
        const match = tables.find(([oid, o]) => oid !== id && o.schema === t.schema && [stem, stem + "s", stem + "es", stem.replace(/y$/, "ies")].includes(o.name)
          && o.pk?.columns.length === 1 && typeLabel(o.columns.find((x) => x.name === o.pk.columns[0]).type) === typeLabel(c.type));
        if (match) {
          add("medium", "missing_fk", at, `${label} looks like a reference to ${match[1].name} but has no foreign key`, "Without the constraint nothing stops it pointing at a row that does not exist, and tools cannot see the relationship.",
            [{ kind: "add_fk", table: id, columns: [c.name], refTable: match[0], onDelete: "restrict" }]);
        }
      }
      const known = values[id]?.[c.name];
      const prose = /(body|notes?|description|comment|content|message|summary|bio|text|title|name)$/.test(c.name);
      if (!prose && known?.length >= 2 && known.length <= 12 && t.estRows >= known.length * 10 && ["text", "varchar"].includes(c.type.base) && known.every((v) => v.length <= 40) && !inFk) {
        add("low", "text_enum", at, `${label} only ever holds ${known.length} values`, `It holds ${known.slice(0, 6).join(", ")}${known.length > 6 ? ", …" : ""}. An enum (or a lookup table) rejects typos and documents the allowed values. Converting existing data is a manual migration, so this one is advice only.`);
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
