import { typeLabel, defaultLabel, GENERATED, TESTS } from "./types.js";

// Jev cannot write prose, so everything Creator says is composed here.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items, max = 6) => {
  const shown = items.slice(0, max);
  const tail = items.length > max ? ` and ${items.length - max} more` : "";
  return shown.length <= 1 ? shown.join("") + tail : tail ? shown.join(", ") + tail : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};
const tableName = (id) => String(id ?? "").split(".").pop();

function columnPhrase(c) {
  const bits = [c.ref ? `→ ${tableName(c.ref.table)}` : typeLabel(c.type)];
  if (c.nullable === false) bits.push("required");
  if (c.unique) bits.push("unique");
  if (c.default) bits.push(`default ${defaultLabel(c.default)}`);
  return `${c.name} (${bits.join(", ")})`;
}

const describeCalculated = (op, t) => (GENERATED[op.template]?.arity === 1 ? `Add ${op.name} to ${t}, always the ${GENERATED[op.template].symbol} ${op.columns[0]}`
  : `Add ${op.name} to ${t}, always ${op.columns[0]} ${GENERATED[op.template]?.symbol ?? "?"} ${op.columns[1]}`);

/** One line describing an op, for the Changes list and for history. */
export function describeOp(op) {
  const t = tableName(op.table);
  switch (op.kind) {
    case "create_schema": return `Create schema ${op.name}`;
    case "create_table": return `Create table ${op.name}${op.columns.length ? ` with ${list(op.columns.map((c) => c.name))}` : ""}`;
    case "rename_table": return `Rename ${t} to ${op.name}`;
    case "drop_table": return `Drop table ${t}`;
    case "set_comment": return `Describe ${op.column ? `${t}.${op.column}` : t}`;
    case "add_column": return `Add ${columnPhrase(op.column)} to ${t}`;
    case "add_generated_column": {
      const say = (c) => (typeof c !== "object" ? String(c) : c.text != null ? `"${c.text}"` : String(c.number));
      if (op.template === "when" && op.condition) {
        const k = op.condition, v = k.value;
        const right = !v ? "" : ` ${v.column ?? v.label?.replace(/_/g, " ") ?? (v.bool != null ? (v.bool ? "yes" : "no") : say(v))}`;
        const when = `${k.column} ${TESTS[k.test]?.words ?? "?"}${right}`;
        return op.then ? `Add ${op.name} to ${t}: ${say(op.then)} when ${when}${op.else ? `, otherwise ${say(op.else)}` : ""}` : `Add ${op.name} to ${t}: yes when ${when}`;
      }
      if (op.constant) return `Add ${op.name} to ${t}, always ${op.constantFirst ? `${say(op.constant)} ${GENERATED[op.template]?.symbol} ${op.columns[0]}` : `${op.columns[0]} ${GENERATED[op.template]?.symbol} ${say(op.constant)}`}`;
      return describeCalculated(op, t);
    }
    case "create_view": {
      const v = (c) => (!c.value ? "" : ` ${c.value.clock ?? c.value.column ?? c.value.label?.replace(/_/g, " ") ?? (c.value.bool != null ? (c.value.bool ? "yes" : "no") : c.value.text != null ? `"${c.value.text}"` : c.value.number)}`);
      const when = (c) => `${c.column} ${TESTS[c.test]?.words ?? "?"}${v(c)}`;
      const flags = op.flags.map((f) => `${f.name} (yes when ${when(f.condition)})`);
      return `Create view ${op.name}: ${t}${op.filter ? ` where ${when(op.filter)}` : ""}${flags.length ? `, with ${list(flags)}` : ""}`;
    }
    case "drop_view": return `Drop view ${tableName(op.view)}`;
    case "drop_column": return `Drop ${t}.${op.column}`;
    case "rename_column": return `Rename ${t}.${op.column} to ${op.name}`;
    case "alter_column_type": return `Change ${t}.${op.column} to ${typeLabel(op.type)}`;
    case "set_not_null": return `Make ${t}.${op.column} required`;
    case "drop_not_null": return `Make ${t}.${op.column} optional`;
    case "set_default": return `Default ${t}.${op.column} to ${defaultLabel(op.default)}`;
    case "drop_default": return `Remove the default of ${t}.${op.column}`;
    case "add_pk": return `Make (${op.columns.join(", ")}) the primary key of ${t}`;
    case "add_fk": return `Link ${t}.${op.columns.join(", ")} to ${tableName(op.refTable)}`;
    case "set_fk_action": return op.onDelete === "cascade" ? `Delete ${t} rows together with the row they belong to (${op.name})`
      : op.onDelete === "set_null" ? `Keep ${t} rows when the row they belong to is deleted, clearing the link (${op.name})`
      : `Block deleting a row while ${t} rows still point at it (${op.name})`;
    case "add_unique": return op.columns.length > 1 ? `Allow each combination of ${op.columns.join(" + ")} only once in ${t}` : `Make ${t} (${op.columns.join(", ")}) unique`;
    case "add_check": return `Require ${t}.${op.column} to be ${String(op.template).replace(/_/g, " ")}`;
    case "drop_constraint": return `Remove the rule ${op.name} from ${t}`;
    case "add_index": return `${op.unique ? "Unique index" : "Index"} on ${t} (${op.columns.join(", ")})`;
    case "drop_index": return `Drop index ${op.name}`;
    case "create_enum": return `Create type ${op.name}: ${list(op.values, 8)}`;
    case "add_enum_value": return `Add "${op.value}" to ${tableName(op.enum)}`;
    case "drop_enum": return `Drop type ${tableName(op.enum)}`;
    case "create_role": return `Create role ${op.name} (no login)`;
    case "drop_role": return `Drop role ${op.name}`;
    case "grant": return `Let ${op.role} ${list(op.privileges.map((p) => p.toLowerCase()))} ${op.allIn ? `every table in ${op.allIn}` : t}`;
    case "revoke": return `Stop ${op.role} from ${list(op.privileges.map((p) => p.toLowerCase()))} on ${op.allIn ? `every table in ${op.allIn}` : t}`;
    case "enable_rls": return `Turn on row-level security for ${t}`;
    case "disable_rls": return `Turn off row-level security for ${t}`;
    case "create_policy": return op.template === "read_all" ? `Let ${op.role ?? "everyone"} read every row of ${t}`
      : op.template === "owner_column" ? `Limit ${t} to rows where ${op.column} is the current user`
      : `Limit ${t} to rows of the current tenant (${op.column})`;
    case "drop_policy": return `Drop policy ${op.name} on ${t}`;
    case "seed": return `Add ${plural(op.rows, "sample row")} to ${op.tables.length ? list(op.tables.map(tableName)) : "every table"}`;
    default: return op.kind;
  }
}

export function summarizeOps(ops) {
  if (!ops.length) return "No changes";
  const tables = ops.filter((o) => o.kind === "create_table");
  if (tables.length > 1 && tables.length >= ops.length / 2) return `Create ${plural(tables.length, "table")}: ${list(tables.map((o) => o.name), 5)}`;
  return ops.length === 1 ? describeOp(ops[0]) : `${describeOp(ops[0])}, and ${plural(ops.length - 1, "more change")}`;
}

export const CONVENTIONS = {
  id: { label: "id primary key", why: "A bigint identity column: a key that never changes, even when names and emails do." },
  timestamps: { label: "created_at / updated_at", why: "timestamptz, filled in by default. Cheap now, impossible to add retroactively." },
  fkIndex: { label: "index every foreign key", why: "Postgres does not do this on its own, and joins and parent deletes depend on it." },
};

/** What the assistant says after staging ops. */
export function stagedReply(ops, { blueprint, suggestions = 0 } = {}) {
  const tables = ops.filter((o) => o.kind === "create_table");
  let text;
  if (blueprint) {
    const title = /^[A-Z]{2,}$/.test(blueprint.title) ? blueprint.title : blueprint.title.toLowerCase(); // keep CRM, HR
    text = `I drafted ${/^([aeio]|hr$)/i.test(title) ? "an" : "a"} ${title} schema: ${plural(tables.length, "table")} (${list(tables.map((o) => o.name), 8)}).`;
  }
  else if (ops.length === 1) text = `Staged: ${describeOp(ops[0]).replace(/^./, (c) => c.toLowerCase())}.`;
  else text = `Staged ${plural(ops.length, "change")}: ${list(ops.map((o) => describeOp(o).replace(/^./, (c) => c.toLowerCase())), 4)}.`;
  text += " Nothing has touched the database yet. Review it on the right, then press Apply.";
  if (suggestions) text += ` I also left ${plural(suggestions, "suggestion")} I was less sure about.`;
  return text;
}

export const DECLINES = {
  other: "That doesn't look like a change to this database. I can create tables, add or change columns, link tables, add indexes and enums, manage roles and row-level security, fill tables with sample data, and review the schema.",
  data_question: "That sounds like a question about the data rather than a change to the schema. Ask answers those.",
  no_names: "I understood what you want to do, but not what to call it. I can only use names that appear in your message, so say it with the name, for example: \"create a table called invoices with number, amount and due date\".",
  no_target: "I couldn't tell which table you mean. Name it the way it appears in the list on the left.",
  no_column: "I couldn't tell which column you mean. Name it exactly as it appears in the table.",
  nothing: "I read that as a change, but every part of it fell below the confidence I need before staging it. The suggestions below are my best guesses. Add the ones that are right.",
};

export function noBlueprintReply(titles, generic) {
  const covered = `The domains I have a full design for are ${list(titles.map((t) => t.toLowerCase()), 12)}.`;
  return generic.length
    ? `I don't have a ready-made design for that, so I started plain tables for ${list(generic)} with an id, a name and timestamps. Tell me the fields each one needs. ${covered}`
    : `I don't have a ready-made design for that domain, and I couldn't pick out the things it should store. Name them, for example: "tables for members, classes and bookings". ${covered}`;
}
