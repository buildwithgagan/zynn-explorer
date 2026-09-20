// What a DBA would do with a field, written down once. Jev only recognises *which* archetype a field is;
// the type, constraints and defaults that follow are decided here, and so is the sample data for it.

const FIRST = ["Ava", "Liam", "Noah", "Mia", "Zoe", "Omar", "Ines", "Kenji", "Priya", "Lucas", "Sofia", "Mateo", "Hana", "Elias", "Nora", "Tariq", "Freya", "Diego", "Amara", "Jonas"];
const LAST = ["Okafor", "Lindqvist", "Tanaka", "Moreau", "Silva", "Novak", "Haddad", "Petrov", "Nguyen", "Campbell", "Rossi", "Kowalski", "Mbeki", "Larsen", "Ortega", "Bauer", "Iyer", "Doyle", "Sato", "Varga"];
const NOUNS = ["Atlas", "Harbor", "Juniper", "Lantern", "Meridian", "Orchard", "Quarry", "Summit", "Willow", "Beacon", "Cobalt", "Drift", "Ember", "Fable", "Garnet"];
const ADJECTIVES = ["Quiet", "Bright", "Northern", "Amber", "Swift", "Gentle", "Bold", "Rustic", "Modern", "Coastal", "Golden", "Silver"];
const WORDS = "steady river carries small boats past the old mill while morning light settles over open fields and distant hills".split(" ");
const CITIES = ["Lisbon", "Osaka", "Nairobi", "Toronto", "Lima", "Oslo", "Austin", "Mumbai", "Prague", "Accra", "Seoul", "Dublin"];
const COUNTRIES = ["Portugal", "Japan", "Kenya", "Canada", "Peru", "Norway", "United States", "India", "Czechia", "Ghana", "South Korea", "Ireland"];
const STREETS = ["Maple", "Harbour", "Cedar", "Station", "Mill", "Orchard", "Victoria", "Lake", "Hill", "Garden"];
const COLORS = ["#2f6fed", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#0091ff", "#d6409f", "#12a594"];

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pad = (n, width) => String(n).padStart(width, "0");
const hex = (rng, n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const daysAgo = (rng, max) => new Date(Date.UTC(2026, 0, 1) - int(rng, 0, max) * 86_400_000 - int(rng, 0, 86_399) * 1000);
const sentence = (rng, n) => { const s = Array.from({ length: n }, () => pick(rng, WORDS)).join(" "); return s[0].toUpperCase() + s.slice(1) + "."; };

const T = (base, ...args) => (args.length ? { base, args } : { base });

/** id → { describe (what Jev reads), column (defaults a DBA would pick), gen(rng, i) → sample value } */
export const ARCHETYPES = {
  person_name: { describe: "A person's full name. Examples: name of a customer, contact name, author.", column: { type: T("text"), nullable: false, check: "not_blank" }, gen: (r) => `${pick(r, FIRST)} ${pick(r, LAST)}` },
  first_name: { describe: "A person's first or given name.", column: { type: T("text"), nullable: false }, gen: (r) => pick(r, FIRST) },
  last_name: { describe: "A person's last name, surname or family name.", column: { type: T("text"), nullable: false }, gen: (r) => pick(r, LAST) },
  title: { describe: "The name or title of a thing, not a person. Examples: product name, post title, project name, company name, subject.", column: { type: T("text"), nullable: false, check: "not_blank" }, gen: (r) => `${pick(r, ADJECTIVES)} ${pick(r, NOUNS)}` },
  short_label: { describe: "A short label, code or category written as free text. Examples: sku, code, type, kind, breed, species, department name.", column: { type: T("text") }, gen: (r) => pick(r, NOUNS).toLowerCase() },
  long_text: { describe: "Long free text. Examples: description, notes, body, content, bio, comment, message, summary, instructions.", column: { type: T("text") }, gen: (r) => sentence(r, int(r, 8, 16)) },
  slug: { describe: "A URL slug or handle: a short unique lowercase identifier used in links. Examples: slug, handle, username.", column: { type: T("text"), nullable: false, unique: true, check: "lowercase" }, gen: (r, i) => `${slugify(pick(r, ADJECTIVES) + " " + pick(r, NOUNS))}-${i + 1}` },
  email: { describe: "An email address.", column: { type: T("text"), nullable: false, unique: true, check: "lowercase" }, gen: (r, i) => `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase()}${i + 1}@example.com` },
  phone: { describe: "A phone or mobile number.", column: { type: T("text") }, gen: (r) => `+1-555-${pad(int(r, 0, 9999), 4)}` },
  url: { describe: "A web address or link. Examples: website, url, link, avatar url, image url.", column: { type: T("text") }, gen: (r) => `https://example.com/${slugify(pick(r, NOUNS))}/${hex(r, 6)}` },
  country: { describe: "A country.", column: { type: T("text") }, gen: (r) => pick(r, COUNTRIES) },
  city: { describe: "A city or town.", column: { type: T("text") }, gen: (r) => pick(r, CITIES) },
  postal_code: { describe: "A postal code or zip code.", column: { type: T("text") }, gen: (r) => pad(int(r, 1000, 99999), 5) },
  address_line: { describe: "A street address or address line.", column: { type: T("text") }, gen: (r) => `${int(r, 1, 240)} ${pick(r, STREETS)} Street` },
  money: { describe: "An amount of money. Examples: price, cost, total, amount, fee, salary, balance, budget.", column: { type: T("numeric", 12, 2), nullable: false, check: "non_negative" }, gen: (r) => (int(r, 100, 250_000) / 100).toFixed(2) },
  quantity: { describe: "A whole-number quantity of things. Examples: quantity, stock, seats, capacity, number of items.", column: { type: T("integer"), nullable: false, default: { kind: "number", value: 0 }, check: "non_negative" }, gen: (r) => int(r, 0, 120) },
  count: { describe: "A whole number that is not a quantity of stock. Examples: age, position, sort order, level, floor, year, number of views.", column: { type: T("integer") }, gen: (r) => int(r, 1, 90) },
  decimal_number: { describe: "A measurement with decimals. Examples: weight, height, distance, latitude, longitude, temperature, score.", column: { type: T("numeric") }, gen: (r) => (int(r, 10, 99_999) / 100).toFixed(2) },
  percentage: { describe: "A percentage between 0 and 100. Examples: discount percent, tax rate, completion.", column: { type: T("numeric", 5, 2), check: "percent" }, gen: (r) => (int(r, 0, 10_000) / 100).toFixed(2) },
  rating: { describe: "A rating from 1 to 5. Examples: rating, stars.", column: { type: T("smallint"), check: "rating" }, gen: (r) => int(r, 1, 5) },
  boolean_flag: { describe: "A yes/no flag. Examples: active, is admin, published, verified, completed, paid, archived.", column: { type: T("boolean"), nullable: false, default: { kind: "bool", value: false } }, gen: (r) => r() < 0.5 },
  status: { describe: "A status or state that takes one of a few fixed values. Examples: status, state, stage, priority, role.", column: { type: T("text"), nullable: false }, gen: (r) => pick(r, ["new", "active", "done"]) },
  date: { describe: "A calendar date with no time of day. Examples: birthday, date of birth, due date, start date, hire date.", column: { type: T("date") }, gen: (r) => daysAgo(r, 3650).toISOString().slice(0, 10) },
  timestamp: { describe: "A moment in time, with time of day. Examples: published at, scheduled time, appointment time, last login, expires at.", column: { type: T("timestamptz") }, gen: (r) => daysAgo(r, 400).toISOString() },
  duration: { describe: "A length of time. Examples: duration, length of a visit, time spent.", column: { type: T("interval") }, gen: (r) => `${int(r, 5, 180)} minutes` },
  json_data: { describe: "Free-form structured data. Examples: metadata, settings, preferences, attributes, payload, extra data.", column: { type: T("jsonb"), nullable: false, default: { kind: "empty_json" } }, gen: (r) => JSON.stringify({ source: pick(r, ["web", "import", "api"]), rank: int(r, 1, 9) }) },
  uuid_token: { describe: "A random unique token or public identifier. Examples: token, api key, public id, uuid.", column: { type: T("uuid"), nullable: false, unique: true, default: { kind: "uuid" } }, gen: (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}` },
  external_ref: { describe: "The identifier something has in another system. Examples: provider user id, stripe customer id, github id.", column: { type: T("text") }, gen: (r, i) => `ext_${hex(r, 10)}${i + 1}` },
  external_id: { describe: "An identifier that comes from another system. Examples: external id, stripe id, reference number, order number, invoice number.", column: { type: T("text"), unique: true }, gen: (r, i) => `REF-${pad(i + 1, 5)}-${hex(r, 4).toUpperCase()}` },
  password_hash: { describe: "A hashed password. Never the password itself.", column: { type: T("text"), nullable: false }, gen: (r) => `$argon2id$v=19$m=65536,t=3,p=4$${hex(r, 22)}$${hex(r, 43)}` },
  secret_hash: { describe: "The hash of a secret token, such as a session token, reset token or API key. Examples: token hash, key hash, secret hash.", column: { type: T("text"), nullable: false, unique: true }, gen: (r) => hex(r, 64) },
  ip_address: { describe: "An IP address.", column: { type: T("inet") }, gen: (r) => `10.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}` },
  color: { describe: "A colour.", column: { type: T("text") }, gen: (r) => pick(r, COLORS) },
  plain_text: { describe: "Some other short piece of text that fits none of the other descriptions.", column: { type: T("text") }, gen: (r) => `${pick(r, ADJECTIVES)} ${pick(r, NOUNS)}`.toLowerCase() },
};

// A name that settles the question on its own is decided here, not asked: a checkable rule belongs in code.
const NAME_RULES = [
  [/(^|_)(password|passwd|pass)(_hash|_digest)?$/, "password_hash"], [/(^|_)(token|secret|key|code)_(hash|digest)$/, "secret_hash"],
  [/(^|_)ip(_address|_addr)?$/, "ip_address"], [/^user_agent$/, "long_text"],
  [/(^|_)e?mail$/, "email"], [/(^|_)(phone|mobile|tel)(_number)?$/, "phone"], [/(_at|_time|timestamp)$/, "timestamp"],
  [/^(is|has|can|was)_/, "boolean_flag"], [/(^|_)(price|amount|total|cost|fee|salary|balance|subtotal|budget)$/, "money"],
  [/(^|_)(url|website|link)$/, "url"], [/^(first|given)_name$/, "first_name"], [/^(last|family)_name$|^surname$/, "last_name"],
  [/(^|_)(quantity|qty|stock)$/, "quantity"], [/(^|_)(description|notes?|body|content|bio|summary)$/, "long_text"],
  [/^slug$|^handle$/, "slug"], [/(_date|^date|^birthday|^dob)$/, "date"], [/^(zip|zip_code|postal_code|postcode)$/, "postal_code"],
  [/^(status|state|stage)$/, "status"], [/^(metadata|settings|preferences|payload)$/, "json_data"], [/^rating$|^stars$/, "rating"],
  [/^(name|title|label)$/, "title"], [/^country$/, "country"], [/_id$/, "external_ref"], [/^city$/, "city"], [/^(address|street)(_line)?\d?$/, "address_line"],
];

export function archetypeByName(name) {
  for (const [pattern, id] of NAME_RULES) if (pattern.test(name)) return id;
  return null;
}

const BY_TYPE = {
  text: "plain_text", varchar: "plain_text", smallint: "count", integer: "count", bigint: "count", numeric: "decimal_number", real: "decimal_number",
  "double precision": "decimal_number", boolean: "boolean_flag", date: "date", timestamp: "timestamp", timestamptz: "timestamp", interval: "duration",
  uuid: "uuid_token", json: "json_data", jsonb: "json_data", inet: "ip_address",
};

/** The archetype of a column that already exists, judged from its name and then its type. Null when Creator cannot fill it. */
export function inferArchetype(column) {
  const base = column.type?.base;
  const byName = archetypeByName(column.name);
  if (byName && BY_TYPE[ARCHETYPES[byName].column.type.base] === BY_TYPE[base]) return byName;
  if (/name$/.test(column.name) && (base === "text" || base === "varchar")) return /^(full_)?name$/.test(column.name) ? "title" : "person_name";
  return BY_TYPE[base] ?? null;
}

/** A column spec for an op, from an archetype. `overrides` win (the user said "optional", "unique", …). */
export function columnFromArchetype(name, id, overrides = {}) {
  const base = ARCHETYPES[Object.hasOwn(ARCHETYPES, id) ? id : "plain_text"].column;
  return { name, archetype: id, nullable: true, ...structuredClone(base), ...overrides };
}

/** Deterministic PRNG, so the same seed always produces the same sample rows. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
