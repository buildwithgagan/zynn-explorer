// The only column types, defaults, checks and actions Creator can emit. SQL text for any of these
// is assembled from the keys of these tables, never from a string that arrived in an op.

export const TYPES = {
  text: {}, varchar: { args: [[1, 10_485_760]] },
  smallint: {}, integer: {}, bigint: {},
  numeric: { args: [[1, 1000], [0, 1000]], optionalArgs: true }, real: {}, "double precision": {},
  boolean: {}, date: {}, time: {}, timestamp: {}, timestamptz: {}, interval: {},
  uuid: {}, json: {}, jsonb: {}, bytea: {}, inet: {}, "text[]": {},
};

// format_type() spelling → the base names above.
const CATALOG_NAMES = {
  "character varying": "varchar", "timestamp without time zone": "timestamp", "timestamp with time zone": "timestamptz",
  "time without time zone": "time", int2: "smallint", int4: "integer", int8: "bigint", bool: "boolean",
  float4: "real", float8: "double precision",
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/** Validate a column type from an op. Returns a fresh `{base,args}` or `{enum}`; anything else throws. */
export function cleanType(raw) {
  if (typeof raw === "string") raw = { base: raw };
  if (!raw || typeof raw !== "object") throw fail("A column needs a type");
  if (typeof raw.enum === "string") return { enum: raw.enum };
  const base = String(raw.base ?? "");
  const spec = Object.hasOwn(TYPES, base) ? TYPES[base] : null;
  if (!spec) throw fail(`"${base.slice(0, 40)}" is not a column type Creator can use`);
  const given = Array.isArray(raw.args) ? raw.args : [];
  if (!spec.args || (!given.length && spec.optionalArgs)) return { base };
  if (given.length !== spec.args.length && !(base === "numeric" && given.length === 1)) {
    if (base === "varchar" && !given.length) return { base: "text" };
    throw fail(`${base} needs ${spec.args.length} size value${spec.args.length === 1 ? "" : "s"}`);
  }
  const args = given.map((v, i) => {
    const n = Number(v);
    const [min, max] = spec.args[i];
    if (!Number.isInteger(n) || n < min || n > max) throw fail(`${base} size must be a whole number between ${min} and ${max}`);
    return n;
  });
  if (base === "numeric" && args.length === 2 && args[1] > args[0]) throw fail("numeric scale cannot exceed its precision");
  return { base, args };
}

/** SQL for a cleaned type. `enumSql` renders an enum id that the caller has already resolved. */
export function typeSql(type, enumSql) {
  if (type.enum) return enumSql(type.enum);
  if (!Object.hasOwn(TYPES, type.base)) throw fail("Unknown column type");
  return type.args?.length ? `${type.base}(${type.args.map((n) => Number(n) | 0).join(",")})` : type.base;
}

export function typeLabel(type) {
  if (!type) return "?";
  if (type.raw) return type.raw;
  if (type.enum) return type.enum.replace(/^public\./, "");
  return type.args?.length ? `${type.base}(${type.args.join(",")})` : type.base;
}

/** A catalog column type as a design type. Types outside the whitelist are kept as `{raw}` for display only. */
export function parseCatalogType(formatted, enumId) {
  if (enumId) return { enum: enumId };
  const m = /^([a-z ]+?)(?:\((\d+)(?:,(\d+))?\))?( with(?:out)? time zone)?(\[\])?$/.exec(formatted ?? "");
  if (!m) return { raw: formatted };
  const name = (m[1] + (m[4] ?? "")).trim();
  const base = (CATALOG_NAMES[name] ?? name) + (m[5] ?? "");
  if (!Object.hasOwn(TYPES, base)) return { raw: formatted };
  const args = m[2] != null && TYPES[base].args ? [Number(m[2]), ...(m[3] != null ? [Number(m[3])] : [])] : undefined;
  return args ? { base, args } : { base };
}

export const sameType = (a, b) => typeLabel(a) === typeLabel(b);

const INTS = ["smallint", "integer", "bigint"];
/** Whether changing `from` to `to` can never lose data or fail on existing rows. */
export function isSafeWidening(from, to) {
  if (!from?.base || !to?.base) return false;
  if (sameType(from, to)) return true;
  if (INTS.includes(from.base) && INTS.includes(to.base)) return INTS.indexOf(to.base) > INTS.indexOf(from.base);
  if (INTS.includes(from.base) && to.base === "numeric" && !to.args) return true;
  if (from.base === "varchar" && to.base === "text") return true;
  if (from.base === "varchar" && to.base === "varchar") return (to.args?.[0] ?? 0) >= (from.args?.[0] ?? Infinity);
  if (from.base === "real" && to.base === "double precision") return true;
  if (from.base === "json" && to.base === "jsonb") return true;
  if (from.base === "timestamp" && to.base === "timestamptz") return true; // reinterpreted in the session time zone, never rejected
  return false;
}

export const ON_DELETE = { restrict: "RESTRICT", cascade: "CASCADE", set_null: "SET NULL", no_action: "NO ACTION" };
export const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];
export const POLICY_COMMANDS = { all: "ALL", select: "SELECT", insert: "INSERT", update: "UPDATE", delete: "DELETE" };
export const POLICY_TEMPLATES = ["owner_column", "tenant_setting", "read_all"];

/** Check constraints by template. `c` is an already-quoted column identifier. */
export const CHECKS = {
  non_negative: (c) => `${c} >= 0`,
  positive: (c) => `${c} > 0`,
  percent: (c) => `${c} >= 0 AND ${c} <= 100`,
  rating: (c) => `${c} >= 1 AND ${c} <= 5`,
  lowercase: (c) => `${c} = lower(${c})`,
  not_blank: (c) => `length(trim(${c})) > 0`,
};

export const DEFAULT_KINDS = ["now", "uuid", "current_date", "bool", "number", "string", "empty_json", "enum_label"];

/** Validate a column default from an op. */
export function cleanDefault(raw) {
  if (raw == null) return null;
  const kind = String(raw.kind ?? "");
  if (!DEFAULT_KINDS.includes(kind)) throw fail("That default is not one Creator can set");
  if (kind === "bool") return { kind, value: Boolean(raw.value) };
  if (kind === "number") {
    const value = Number(raw.value);
    if (!Number.isFinite(value)) throw fail("A numeric default must be a number");
    return { kind, value };
  }
  if (kind === "string" || kind === "enum_label") {
    const value = String(raw.value ?? "");
    if (value.length > 200 || value.includes("\0")) throw fail("That default text is too long");
    return { kind, value };
  }
  return { kind };
}

/** A default read from the catalog. Unrecognised expressions are kept as `{raw}` for display only. */
export function parseCatalogDefault(expr) {
  if (expr == null) return null;
  const e = expr.trim();
  if (/^(now\(\)|CURRENT_TIMESTAMP|transaction_timestamp\(\))$/i.test(e)) return { kind: "now" };
  if (/^gen_random_uuid\(\)$/i.test(e)) return { kind: "uuid" };
  if (/^CURRENT_DATE$/i.test(e)) return { kind: "current_date" };
  if (/^(true|false)$/i.test(e)) return { kind: "bool", value: /^true$/i.test(e) };
  if (/^-?\d+(\.\d+)?$/.test(e)) return { kind: "number", value: Number(e) };
  if (/^'\{\}'::jsonb?$/.test(e)) return { kind: "empty_json" };
  const s = /^'((?:[^']|'')*)'::(text|character varying)$/.exec(e);
  if (s) return { kind: "string", value: s[1].replace(/''/g, "'") };
  const l = /^'((?:[^']|'')*)'::[\w."]+$/.exec(e);
  if (l) return { kind: "enum_label", value: l[1].replace(/''/g, "'") };
  return { raw: e };
}

export function defaultLabel(d) {
  if (!d) return null;
  if (d.raw) return d.raw;
  return { now: "now()", uuid: "gen_random_uuid()", current_date: "current_date", empty_json: "{}" }[d.kind] ?? String(d.value);
}
