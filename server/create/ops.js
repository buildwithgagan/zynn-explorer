import { randomUUID } from "node:crypto";
import { cleanType, cleanDefault, CHECKS, ON_DELETE, PRIVILEGES, POLICY_COMMANDS, POLICY_TEMPLATES, GENERATED, TESTS, cleanConstant } from "./types.js";

// An op is one staged change. Ops arrive from the browser, so every one is rebuilt here field by field:
// what is not listed for its kind is dropped, and what is listed is coerced to a known shape.

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const str = (v, max = 200) => (v == null ? undefined : String(v).slice(0, max));
const strList = (v, max = 32) => (Array.isArray(v) ? v.slice(0, max).map((x) => String(x).slice(0, 200)) : []);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (v == null ? fallback : Boolean(v));

function cleanColumn(raw) {
  if (!raw || typeof raw !== "object") throw fail("A column needs a name");
  const col = { name: str(raw.name, 80) };
  if (raw.ref && typeof raw.ref === "object") {
    col.ref = { table: str(raw.ref.table), onDelete: oneOf(raw.ref.onDelete, Object.keys(ON_DELETE), "restrict") };
  } else col.type = cleanType(raw.type);
  col.nullable = bool(raw.nullable, true);
  if (raw.default != null) col.default = cleanDefault(raw.default);
  if (raw.unique) col.unique = true;
  if (raw.check != null) col.check = oneOf(raw.check, Object.keys(CHECKS), undefined);
  if (raw.archetype != null) col.archetype = str(raw.archetype, 40);
  if (raw.comment != null) col.comment = str(raw.comment, 300);
  return col;
}

const SHAPES = {
  create_schema: (r) => ({ name: str(r.name, 80) }),
  create_table: (r) => ({
    schema: str(r.schema, 80) ?? "public", name: str(r.name, 80),
    columns: (Array.isArray(r.columns) ? r.columns : []).slice(0, 80).map(cleanColumn),
    pk: r.pk ? strList(r.pk, 8) : undefined,
    conventions: { id: bool(r.conventions?.id, true), timestamps: bool(r.conventions?.timestamps, true), fkIndex: bool(r.conventions?.fkIndex, true) },
    comment: str(r.comment, 300),
  }),
  rename_table: (r) => ({ table: str(r.table), name: str(r.name, 80) }),
  drop_table: (r) => ({ table: str(r.table) }),
  set_comment: (r) => ({ table: str(r.table), column: str(r.column), comment: str(r.comment, 300) ?? "" }),
  add_column: (r) => ({ table: str(r.table), column: cleanColumn(r.column), index: bool(r.index, true) }),
  // A column Postgres calculates from others in the same row. The calculation is a template name, never an expression.
  // `constant` stands in for the second value ("price times 1.2"). `template: "when"` is a test on a column that gives
  // yes/no, or one of two constants ("0 when total is over 50, otherwise 5").
  add_generated_column: (r) => ({
    table: str(r.table), name: str(r.name, 80), template: oneOf(r.template, [...Object.keys(GENERATED), "when"], undefined), columns: strList(r.columns, 2),
    constant: cleanConstant(r.constant), constantFirst: r.constantFirst ? true : undefined,
    condition: r.condition && typeof r.condition === "object" ? {
      column: str(r.condition.column), test: oneOf(r.condition.test, Object.keys(TESTS), undefined),
      value: r.condition.value == null ? undefined : typeof r.condition.value === "object" && r.condition.value.column != null ? { column: str(r.condition.value.column) }
        : typeof r.condition.value === "object" && r.condition.value.label != null ? { label: str(r.condition.value.label, 63) }
        : typeof r.condition.value === "object" && r.condition.value.bool != null ? { bool: Boolean(r.condition.value.bool) } : cleanConstant(r.condition.value),
    } : undefined,
    then: cleanConstant(r.then), else: cleanConstant(r.else),
  }),
  drop_column: (r) => ({ table: str(r.table), column: str(r.column) }),
  rename_column: (r) => ({ table: str(r.table), column: str(r.column), name: str(r.name, 80) }),
  alter_column_type: (r) => ({ table: str(r.table), column: str(r.column), type: cleanType(r.type) }),
  set_not_null: (r) => ({ table: str(r.table), column: str(r.column) }),
  drop_not_null: (r) => ({ table: str(r.table), column: str(r.column) }),
  set_default: (r) => ({ table: str(r.table), column: str(r.column), default: cleanDefault(r.default) ?? (() => { throw fail("A default is required"); })() }),
  drop_default: (r) => ({ table: str(r.table), column: str(r.column) }),
  add_pk: (r) => ({ table: str(r.table), columns: strList(r.columns, 8) }),
  add_fk: (r) => ({
    table: str(r.table), columns: strList(r.columns, 8), refTable: str(r.refTable), refColumns: r.refColumns ? strList(r.refColumns, 8) : undefined,
    onDelete: oneOf(r.onDelete, Object.keys(ON_DELETE), "restrict"), index: bool(r.index, true),
  }),
  // Postgres cannot alter a foreign key's action in place: the constraint is dropped and re-added in one statement.
  set_fk_action: (r) => ({ table: str(r.table), name: str(r.name), onDelete: oneOf(r.onDelete, Object.keys(ON_DELETE), "restrict") }),
  add_unique: (r) => ({ table: str(r.table), columns: strList(r.columns, 8) }),
  add_check: (r) => ({ table: str(r.table), column: str(r.column), template: oneOf(r.template, Object.keys(CHECKS), undefined) }),
  drop_constraint: (r) => ({ table: str(r.table), name: str(r.name) }),
  add_index: (r) => ({ table: str(r.table), columns: strList(r.columns, 8), unique: bool(r.unique, false) }),
  drop_index: (r) => ({ table: str(r.table), name: str(r.name) }),
  create_enum: (r) => ({ schema: str(r.schema, 80) ?? "public", name: str(r.name, 80), values: strList(r.values, 100).map((v) => v.slice(0, 63)) }),
  add_enum_value: (r) => ({ enum: str(r.enum), value: str(r.value, 63) }),
  drop_enum: (r) => ({ enum: str(r.enum) }),
  // Roles made here can never log in: a password is not something to pass through a chat box or a model.
  create_role: (r) => ({ name: str(r.name, 80) }),
  drop_role: (r) => ({ name: str(r.name) }),
  grant: (r) => ({ role: str(r.role), privileges: strList(r.privileges, 8).map((p) => p.toUpperCase()).filter((p) => PRIVILEGES.includes(p)), table: str(r.table), allIn: str(r.allIn, 80) }),
  revoke: (r) => ({ role: str(r.role), privileges: strList(r.privileges, 8).map((p) => p.toUpperCase()).filter((p) => PRIVILEGES.includes(p)), table: str(r.table), allIn: str(r.allIn, 80) }),
  enable_rls: (r) => ({ table: str(r.table) }),
  disable_rls: (r) => ({ table: str(r.table) }),
  create_policy: (r) => ({
    table: str(r.table), name: str(r.name, 80), template: oneOf(r.template, POLICY_TEMPLATES, undefined),
    column: str(r.column), command: oneOf(r.command, Object.keys(POLICY_COMMANDS), "all"), role: str(r.role), setting: str(r.setting, 80),
  }),
  drop_policy: (r) => ({ table: str(r.table), name: str(r.name) }),
  seed: (r) => ({
    tables: strList(r.tables, 60), rows: Math.min(1000, Math.max(1, Math.trunc(Number(r.rows)) || 25)),
    seedValue: (Math.trunc(Number(r.seedValue)) || 1) >>> 0,
  }),
};

export const OP_KINDS = Object.keys(SHAPES);

/** Rebuild an untrusted op. Throws a 400 for an unknown kind or a malformed field. */
export function cleanOp(raw) {
  if (!raw || typeof raw !== "object" || !Object.hasOwn(SHAPES, raw.kind)) throw fail("That change is not one Creator understands");
  const op = { id: /^[\w-]{1,64}$/.test(raw.id ?? "") ? raw.id : randomUUID(), kind: raw.kind, ...SHAPES[raw.kind](raw) };
  if (typeof raw.why === "string") op.why = raw.why.slice(0, 300);
  for (const k of Object.keys(op)) if (op[k] === undefined) delete op[k];
  return op;
}

export function cleanOps(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 400) throw fail("A draft holds at most 400 changes");
  return raw.map(cleanOp);
}

export const newId = () => randomUUID();
