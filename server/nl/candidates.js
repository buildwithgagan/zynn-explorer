// Candidate extraction and date arithmetic live in code. Jev only *selects* among
// candidates found here; it cannot choose a value that was never offered.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100, thousand: 1000,
};

const STOPWORDS = new Set(`a an the of in on at to for from by with without and or not no is are was were be been
show me list give get find fetch display see what which who whose how many much all any every each per
that this these those have has had do does did can could would should will there their its it as than then
top bottom first last latest newest oldest recent most least highest lowest biggest smallest largest best worst
more less over under above below between at least exactly equal equals greater fewer
count number total sum average avg mean min max minimum maximum
today yesterday week month quarter year day days weeks months years ago past previous current
order ordered sort sorted sorting group grouped ascending descending asc desc whose where when
i we my our us you your please want need tell about only just also
instead now ones one them those these they it its same again too rather still but
remove drop ignore keep include exclude filter filters condition break down narrow limit`.split(/\s+/));

export const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

/** Numeric literals in the request, each with the phrase that carried it. */
export function numberCandidates(request) {
  const out = [];
  const seen = new Set();
  const add = (value, phrase) => {
    if (!Number.isFinite(value) || seen.has(value) || out.length >= 6) return;
    seen.add(value);
    out.push({ value, phrase });
  };
  for (const m of request.matchAll(/(?<![\w.])\$?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?(?![\w])/gi)) {
    let value = Number(m[1].replace(/,/g, ""));
    if (m[2]) value *= m[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
    add(value, m[0].trim());
  }
  for (const m of request.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    if (m[0] in NUMBER_WORDS && m[0] !== "one") add(NUMBER_WORDS[m[0]], m[0]);
  }
  return out;
}

export function yearCandidates(request) {
  return [...new Set([...request.matchAll(/\b(19\d\d|20\d\d)\b/g)].map((m) => Number(m[1])))].slice(0, 4);
}

/**
 * Possible search terms: quoted strings, emails, then 1–3 word n-grams made of words
 * that are neither filler nor names of things in the schema.
 */
export function textCandidates(request, schemaWords, max = 24) {
  const out = [];
  const add = (s) => {
    const v = s.trim();
    if (v.length >= 2 && v.length <= 80 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  let rest = request;
  for (const m of request.matchAll(/"([^"]+)"|'([^']+)'|“([^”]+)”/g)) {
    add(m[1] ?? m[2] ?? m[3]);
    rest = rest.replace(m[0], " | ");
  }
  for (const m of rest.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    add(m[0]);
    rest = rest.replace(m[0], " | ");
  }

  const singular = (w) => w.replace(/(ies)$/, "y").replace(/s$/, "");
  const isNoise = (w) => {
    const lower = w.toLowerCase();
    return STOPWORDS.has(lower) || lower in NUMBER_WORDS || MONTHS.includes(lower)
      || schemaWords.has(lower) || schemaWords.has(singular(lower)) || /^\d/.test(lower);
  };
  // Runs of consecutive meaningful words; punctuation and noise words break a run.
  const runs = [];
  let run = [];
  for (const token of rest.split(/(\s+|[|,;:!?()]+)/)) {
    if (!token || /^\s+$/.test(token)) continue;
    const word = token.replace(/^[^\w]+|[^\w]+$/g, "");
    if (!word || /^[|,;:!?()]+$/.test(token) || isNoise(word)) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(word);
  }
  if (run.length) runs.push(run);

  for (const words of runs) {
    for (let size = Math.min(3, words.length); size >= 1; size--) {
      for (let i = 0; i + size <= words.length; i++) {
        if (out.length < max) add(words.slice(i, i + size).join(" "));
      }
    }
  }
  return out;
}

const TIME_WORDS = new RegExp(
  `\\b(today|yesterday|tonight|daily|weekly|monthly|quarterly|yearly|annual|annually|ytd|since|ago|` +
  `days?|weeks?|months?|quarters?|years?|(19|20)\\d\\d|${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\b`,
  "i"
);

/** Whether the request contains any wording that could state a time period. A known rule, so code decides it. */
export function mentionsTime(request) {
  return TIME_WORDS.test(request);
}

const NEGATION_WORDS = /\b(not|no|non|none|never|neither|nor|without|except|excluding|exclude|excludes|other than|apart from|aside from|but|besides|outside|outside of|anything but|all but|everything but|everyone but|different from|rather than|minus|unlike|omit|omitting|skip|skipping|leaving out|isn't|isnt|aren't|arent|wasn't|weren't|don't|dont|doesn't|doesnt|didn't|haven't|hasn't)\b|n't\b/i;
/** Whether the request contains wording that could exclude something. Exclusion questions are only asked then. */
export function mentionsNegation(request) {
  return NEGATION_WORDS.test(request);
}

/** Whether the request contains wording that could join alternative conditions. */
export function mentionsOr(request) {
  return /\b(or|either)\b/i.test(request);
}

export const TIME_WINDOWS = {
  today: "only today: the request says 'today'",
  yesterday: "only yesterday: the request says 'yesterday'",
  last_7_days: "the past week / last 7 days, counted back from today",
  last_30_days: "the past month / last 30 days, counted back from today",
  last_90_days: "the past three months / last 90 days, counted back from today",
  last_12_months: "the past year / last 12 months, counted back from today",
  this_week: "the current calendar week",
  last_week: "the previous calendar week",
  this_month: "the current calendar month",
  last_month: "the previous calendar month",
  this_quarter: "the current calendar quarter",
  last_quarter: "the previous calendar quarter",
  this_year: "the current calendar year, or year to date",
  last_year: "the previous calendar year",
  named: "a specific calendar year and/or a named month, such as 'in 2024' or 'in March'",
};

const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));

/** Resolve a window key to a half-open [from, to) date range. */
export function resolveWindow(windowKey, { year, month } = {}, now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const monday = d - ((now.getUTCDay() + 6) % 7);
  const q = Math.floor(m / 3) * 3;
  const back = (days) => [utc(y, m, d - days + 1), utc(y, m, d + 1)];
  let range;
  switch (windowKey) {
    case "today": range = [utc(y, m, d), utc(y, m, d + 1)]; break;
    case "yesterday": range = [utc(y, m, d - 1), utc(y, m, d)]; break;
    case "last_7_days": range = back(7); break;
    case "last_30_days": range = back(30); break;
    case "last_90_days": range = back(90); break;
    case "last_12_months": range = [utc(y - 1, m, d + 1), utc(y, m, d + 1)]; break;
    case "this_week": range = [utc(y, m, monday), utc(y, m, monday + 7)]; break;
    case "last_week": range = [utc(y, m, monday - 7), utc(y, m, monday)]; break;
    case "this_month": range = [utc(y, m, 1), utc(y, m + 1, 1)]; break;
    case "last_month": range = [utc(y, m - 1, 1), utc(y, m, 1)]; break;
    case "this_quarter": range = [utc(y, q, 1), utc(y, q + 3, 1)]; break;
    case "last_quarter": range = [utc(y, q - 3, 1), utc(y, q, 1)]; break;
    case "this_year": range = [utc(y, 0, 1), utc(y + 1, 0, 1)]; break;
    case "last_year": range = [utc(y - 1, 0, 1), utc(y, 0, 1)]; break;
    case "named": {
      if (month == null && year == null) return null;
      if (month == null) range = [utc(year, 0, 1), utc(year + 1, 0, 1)];
      else {
        // A bare month name means its most recent occurrence.
        const yy = year ?? (month <= m ? y : y - 1);
        range = [utc(yy, month, 1), utc(yy, month + 1, 1)];
      }
      break;
    }
    default: return null;
  }
  return { from: iso(range[0]), to: iso(range[1]) };
}

// ---------------------------------------------------------------------------
// Creator: names for new things. Jev cannot invent an identifier, so every table, column, role or
// database name it can choose is a phrase taken from the request and normalised here.
// ---------------------------------------------------------------------------
const CREATOR_STOPWORDS = new Set(`a an the in on to for from by with without and or not no is are was were be been it its this that these those
i we my our us you your please want need would like can could should will let lets make makes create creates add adds adding new build set up
give put include including also plus then so into onto each every all some any has have having where which that whose as per
table tables column columns field fields attribute attributes property properties database db schema called named me them they
store stores storing track tracks tracking keep keeps hold holds record records contain contains containing
change rename drop remove delete alter modify update make required optional unique index indexed mandatory nullable
grant revoke read write only allow allowed
rows row sample fake dummy test data fill seed populate generate insert
should must need needs there their one many belongs belong between link linked relate related relation relationship reference references
type kind instead rather just but too well simple basic complete proper`.split(/\s+/));

const IRREGULAR = { person: "people", child: "children", man: "men", woman: "women", mouse: "mice", foot: "feet", tooth: "teeth", goose: "geese" };
const UNCOUNTABLE = new Set(["staff", "media", "data", "news", "series", "equipment", "information", "inventory", "stock", "feedback", "software", "hardware"]);

export function pluralize(word) {
  if (UNCOUNTABLE.has(word) || Object.values(IRREGULAR).includes(word) || /\d$/.test(word)) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(word)) return /(ies|[^s]s)$/.test(word) && !/(ss|us|is)$/.test(word) ? word : word + "es";
  return word + "s";
}

export function singularize(word) {
  for (const [one, many] of Object.entries(IRREGULAR)) if (word === many) return one;
  if (UNCOUNTABLE.has(word) || /(ss|us|is)$/.test(word)) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ch|sh|x|z|ss|us)es$/.test(word)) return word.slice(0, -2);
  return word.replace(/s$/, "");
}

/** "Date of Birth" → date_of_birth. Returns "" when nothing usable is left. */
export function toSnake(text) {
  return String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1").slice(0, 63);
}

/** A table name by convention: snake_case, last word plural ("order item" → order_items). */
export function tableIdent(text) {
  const parts = toSnake(text).split("_").filter(Boolean);
  if (!parts.length) return "";
  parts.push(pluralize(parts.pop()));
  return parts.join("_");
}

/**
 * Phrases in the request that could be the name of something: quoted strings, then 1–3 word n-grams
 * of words that are not filler. → [{ text, ident, run, start, end }], longest phrases of each run first.
 * `run`/`start`/`end` let the caller drop "first" and "name" once "first name" has been accepted.
 */
export function identCandidates(request, max = 36) {
  const out = [];
  const add = (text, run, start, end) => {
    const ident = toSnake(text);
    if (ident.length < 2 || out.length >= max || out.some((o) => o.ident === ident)) return;
    out.push({ text, ident, run, start, end });
  };
  let rest = request;
  let run = 0;
  for (const m of request.matchAll(/"([^"]{1,60})"|'([^']{1,60})'|“([^”]{1,60})”|`([^`]{1,60})`/g)) {
    add(m[1] ?? m[2] ?? m[3] ?? m[4], run++, 0, 1);
    rest = rest.replace(m[0], " | ");
  }
  const runs = [];
  let words = [];
  // "of" joins words inside a name (date of birth); "at" ends one (verified at, expires at). Neither can start a name.
  const close = () => { while (words.at(-1) === "of") words.pop(); if (words.length && !(words.length === 1 && /^(is|has)$/i.test(words[0]))) runs.push(words); words = []; };
  for (const token of rest.split(/(\s+|[|,;:!?()./]+)/)) {
    if (!token || /^\s+$/.test(token)) continue;
    const word = token.replace(/^[^\w]+|[^\w]+$/g, "").replace(/'s$/, "");
    const lower = word.toLowerCase();
    if (!word || /^[|,;:!?()./]+$/.test(token) || /^\d+$/.test(word) || lower in NUMBER_WORDS) close();
    else if (lower === "of") { if (words.length) words.push("of"); }
    // "is active", "has paid": a flag's name starts with is/has, but only at the start of a name. Mid-sentence it is a verb.
    else if ((lower === "is" || lower === "has") && !words.length) words.push(word);
    else if (lower === "at") { if (words.length && words.at(-1) !== "of") { words.push("at"); close(); } }
    else if (CREATOR_STOPWORDS.has(lower)) close();
    else words.push(word);
  }
  close();
  // Whole phrases of every run first, then their parts: a long request must not spend the budget on the
  // fragments of its first names and lose its last ones.
  const grams = (list, id, sizes) => {
    for (const size of sizes) {
      for (let i = 0; i + size <= list.length; i++) {
        const slice = list.slice(i, i + size);
        if (slice[0] === "of" || slice.at(-1) === "of" || slice[0] === "at" || (size === 1 && /^(is|has)$/i.test(slice[0]))) continue;
        add(slice.join(" "), id, i, i + size);
      }
    }
  };
  runs.forEach((list, n) => grams(list, run + n, [Math.min(3, list.length)]));
  runs.forEach((list, n) => grams(list, run + n, [2, 1].filter((size) => size < Math.min(3, list.length))));
  return out;
}

/**
 * "status (draft, sent, paid)": a parenthesised list straight after a name is the list of its allowed values.
 * That is syntax, so code reads it. → [{ field: "status", values: ["draft", "sent", "paid"] }] as identifiers.
 */
export function valueLists(request) {
  const out = [];
  for (const m of request.matchAll(/([A-Za-z][\w ]{0,60}?)\s*\(([^()]{3,200})\)/g)) {
    const values = m[2].split(/,|\bor\b|\band\b|\/|\|/i).map(toSnake).filter((v) => v.length >= 1 && v.length <= 40);
    const words = m[1].trim().split(/\s+/).slice(-3);
    if (values.length < 2 || new Set(values).size !== values.length) continue;
    // The name is the tail of the text before the bracket: try "a b c", then "b c", then "c".
    out.push({ fields: words.map((_, i) => toSnake(words.slice(i).join(" "))).filter(Boolean), values });
  }
  return out;
}
