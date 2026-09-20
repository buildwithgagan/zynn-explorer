import { runSql } from "../db.js";
import { ask, choice, noul } from "../jev.js";
import { loadModel, joinPath } from "./model.js";
import { compile } from "./compile.js";
import { validContext, mergeFollowUp } from "./followup.js";
import { summarize, conditionPhrases, catalogAnswer, describeAnswer, suggestions as buildSuggestions } from "./assistant.js";
import {
  numberCandidates, yearCandidates, textCandidates, resolveWindow, mentionsTime, mentionsNegation, mentionsOr, TIME_WINDOWS, MONTHS,
} from "./candidates.js";

const NONE = "__none__";
const LIMIT = "__limit__";
const MEASURE = "__measure__";
const ACCEPT = 0.5; // a filter is applied when Jev gives it at least this probability
const MAX_TABLES = 150;
const MAX_JOINS = 4;
const MAX_COLUMNS = 120;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function describeTable(t) {
  const names = t.columns.slice(0, 14).map((c) => c.name).join(", ");
  const more = t.columns.length > 14 ? `, … (${t.columns.length} columns)` : "";
  const kind = t.kind === "v" || t.kind === "m" ? "view. " : "";
  return truncate(`${kind}${t.comment ? t.comment + ". " : ""}Columns: ${names}${more}`, 400);
}

function describeColumn(c) {
  const bits = [c.kind === "enum" ? "category" : c.type];
  if (c.isPk) bits.push("primary key");
  if (c.references) bits.push(`references ${c.references}`);
  if (c.values) bits.push(`values: ${c.values.slice(0, 12).join(", ")}`);
  if (c.comment) bits.push(c.comment);
  return truncate(bits.join("; "), 220);
}

/** Rank a Choice answer's options, most probable first. */
function ranked(answer) {
  return Object.entries(answer?.probabilities ?? {})
    .map(([value, p]) => ({ value, p }))
    .sort((a, b) => b.p - a.p);
}

// ---------------------------------------------------------------------------
// Stage 1 — route the request to tables.
// ---------------------------------------------------------------------------
async function routeTables(model, request, context) {
  const tables = [...model.tables.values()].slice(0, MAX_TABLES);
  const state = {
    request,
    ...(context ? { previous_request: context.request, previous_answer: context.reading } : {}),
    tables: Object.fromEntries(tables.map((t) => [t.label, describeTable(t)])),
  };
  const questions = {
    main: choice(
      "A user typed `request` to query a database whose tables are described in `tables`. " +
      "Which table holds the records the user wants listed, counted, or totalled? " +
      "Choose the table whose rows are the subject of the request, not a table that is only used to filter or label them.",
      {
        ...Object.fromEntries(tables.map((t) => [t.label, describeTable(t)])),
        [NONE]: "The request is not a question about the data in any of these tables.",
      }
    ),
  };
  if (context) {
    questions.followup = choice(
      "The user first asked `previous_request` and was shown `previous_answer`. Now they typed `request`. " +
      "Is `request` a follow-up that builds on the previous answer, or a new question that stands on its own?",
      {
        refine: "A follow-up. It only makes sense together with the previous answer: it narrows, widens, re-sorts, re-counts or regroups the same records. " +
          "Typical signs: words like 'them', 'those', 'that', 'these', 'it', 'now', 'only', 'also', 'instead', 'what about', 'and', or no mention of what kind of record is meant. " +
          "Examples: 'only the cancelled ones', 'what about last month', 'how many is that', 'sort them by date', 'group those by country', 'just the top 5', 'remove the date filter'.",
        fresh: "A new question. It names what it is about and can be answered without knowing the previous one. Examples: 'how many customers are there', 'top products by revenue', 'what tables exist'.",
      }
    );
  }
  questions.kind = choice("What is `request` asking for?", {
    data: "Records, counts, totals or other figures taken from the data stored in the tables. Example: 'orders last month', 'how many users', 'top customers'.",
    catalog: "What the database itself contains: which tables or schemas exist, an overview of the database. Example: 'what's in the db', 'list the tables', 'what data do you have'.",
    structure: "The structure of one table: which columns or fields it has, what it stores, how it is defined. Example: 'what columns does orders have', 'describe the users table'.",
    other: "Something that is not about this database at all.",
  });
  for (const t of tables) {
    questions[`uses:${t.label}`] = noul(
      `To answer \`request\`, is data stored in the table "${t.label}" needed — for a condition, a grouping, a calculation, or a value to display?`,
      {
        true: `The request mentions or depends on something stored in "${t.label}".`,
        false: `The request can be answered without reading "${t.label}".`,
      }
    );
  }
  const response = await ask(state, questions);
  return { tables, response };
}

// ---------------------------------------------------------------------------
// Stage 2 — every judgment about the chosen tables, asked at once.
// ---------------------------------------------------------------------------
function buildQuestions(request, columns, numbers, years, texts, context) {
  const negated = mentionsNegation(request);
  const byKind = (kind) => columns.filter((c) => c.kind === kind);
  const options = (cols) => Object.fromEntries(cols.map((c) => [c.label, describeColumn(c)]));
  const q = {};

  q.intent = choice("What shape of result is `request` asking for?", {
    rows: "A list of individual records, possibly filtered or sorted. Example: 'show recent orders', 'customers in Berlin'.",
    count: "One number: how many records match. Example: 'how many users signed up last month'.",
    aggregate: "One computed number over all matching records, such as a total, average, minimum or maximum. Example: 'total revenue this year'.",
    breakdown: "One result row per group, category or time period, each with a count or computed number — including rankings of groups. Example: 'orders per status', 'revenue by month', 'top 5 customers by revenue'.",
    share: "A percentage, share, proportion, ratio or rate: what fraction of the records meet a condition. Example: 'what percent of orders were cancelled', 'share of users who are admins', 'cancellation rate', 'how many out of all orders shipped'.",
  });

  q.agg_fn = choice(
    "Assume `request` asks for a computed number per record group or overall. Which calculation produces that number? " +
    "Ranking words such as 'top', 'best', 'most' or 'highest' describe the sort order of the results, not the calculation.",
    {
      count: "counting how many records there are: 'how many', 'number of', 'most orders'",
      sum: "adding values up into a total: 'total', 'revenue', 'sales', 'spend', 'by revenue', 'top customers by revenue'",
      avg: "an average or mean value: 'average', 'typical', 'mean'",
      min: "the single smallest value of a column: 'cheapest price', 'earliest date', 'minimum'",
      max: "the single largest value of a column: 'most expensive price', 'latest date', 'maximum'",
    }
  );
  q.agg_col = choice(
    "Assume `request` asks for a computed number. Which numeric column in `columns` is the calculation applied to?",
    { ...options(byKind("number").filter((c) => !c.isPk)), [NONE]: "No numeric column: the request only counts records." }
  );

  q.group_col = choice(
    "Does `request` ask for results per group — phrased like 'by X', 'per X', 'for each X', or a ranking of X? Which column in `columns` identifies the group? Prefer a readable name column over an id column.",
    { ...options(columns), [NONE]: "The request does not group results." }
  );
  q.group_bucket = choice("If `request` groups results by a time period, which period is it?", {
    day: "per day, daily", week: "per week, weekly", month: "per month, monthly",
    quarter: "per quarter, quarterly", year: "per year, yearly, annual",
    [NONE]: "The request does not group by a time period.",
  });

  q.order_col = choice("Which value should the results of `request` be sorted by?", {
    ...options(columns),
    [MEASURE]: "The computed number (the count, total or average) — e.g. 'top customers by revenue', 'most orders'.",
    [NONE]: "The request does not imply any sort order.",
  });
  q.order_dir = choice("In which direction should the results of `request` be sorted?", {
    desc: "Largest, highest, most, newest, latest or most recent first. 'Top N' rankings are this.",
    asc: "Smallest, lowest, least, oldest or earliest first; or alphabetical order.",
  });

  q.show_specific = noul(
    "Does `request` name particular fields to display (e.g. 'names and emails of…'), rather than asking for the records in general?"
  );
  for (const c of columns.slice(0, 60)) {
    q[`show:${c.label}`] = noul(`Does \`request\` explicitly ask to see the "${c.name}" of ${c.label.split(".").slice(0, -1).join(".")} in the output?`);
  }

  // One yes/no per known value rather than one Choice per column: a request may name several
  // values ("Japan or Brazil"), and independent judgments let each stand on its own.
  for (const { column: c, index, value } of categoryQuestions(columns)) {
    q[`cat:${c.label}:${index}`] = noul(
      `Does \`request\` ask for records whose "${c.label}" is "${value}"? Answer yes as well when "${value}" is one of several values the request accepts.`,
      {
        true: `The request names or clearly means "${value}" as a wanted ${c.name}.`,
        false: `The request does not mention "${value}", or it excludes it.`,
      }
    );
    // Exclusion is asked separately, and only when the request contains negation wording at all.
    if (negated) {
      q[`not:${c.label}:${index}`] = noul(
        `Does \`request\` exclude records whose "${c.label}" is "${value}" — asking for everything except those?`,
        {
          true: `The request rules "${value}" out: 'not ${value}', 'other than ${value}', 'except ${value}', 'excluding ${value}', 'without ${value}'.`,
          false: `The request does not rule "${value}" out. Asking FOR "${value}", or not mentioning it, is a no.`,
        }
      );
    }
  }

  // Missing values carry meaning ("never logged in", "not yet shipped", "still employed").
  for (const c of columns.filter((c) => c.nullable).slice(0, 24)) {
    q[`null:${c.label}`] = choice(
      `The column "${c.label}" can be empty. Does \`request\` depend on whether it is empty or filled in? ${describeColumn(c)}`,
      {
        is_null: `Only records where "${c.name}" is empty: it never happened, is missing, not set, or not yet done.`,
        not_null: `Only records where "${c.name}" has a value: it has happened or has been set.`,
        [NONE]: `The request says nothing about whether "${c.name}" is empty.`,
      }
    );
  }

  const numeric = byKind("number");
  numbers.forEach((n, i) => {
    q[`num:${i}:use`] = choice(
      `In \`request\`, the number ${n.value} appears (written as "${n.phrase}"). What is that number used for?`,
      {
        ...Object.fromEntries(numeric.map((c) => [c.label, `A condition comparing ${c.label} to ${n.value}. ${describeColumn(c)}`])),
        [LIMIT]: `How many results to return, as in 'top ${n.value}' or 'first ${n.value}'.`,
        [NONE]: "Neither: it is part of a date, a year, a time period like 'last 30 days', or a name.",
      }
    );
    // With negation in play the two judgments are kept orthogonal: this one names the comparison word
    // itself, and `num:i:not` says whether it is negated. Code applies the negation exactly once.
    q[`num:${i}:op`] = choice(negated
      ? `In \`request\`, which comparison wording is used next to the number ${n.value}? Judge the comparison word itself and ignore any 'not', 'no' or 'never' in front of it: for 'not over ${n.value}' the answer is 'greater than'.`
      : `In \`request\`, how is a value being compared to the number ${n.value}?`, {
      gt: `greater than ${n.value}: more than, over, above, exceeding`,
      gte: `${n.value} or more: at least, minimum of`,
      lt: `less than ${n.value}: under, below, fewer than`,
      lte: `${n.value} or less: at most, up to, no more than`,
      eq: `exactly ${n.value}: equal to, is, with id/number ${n.value}`,
      neq: `anything other than ${n.value}`,
    });
    if (negated) {
      q[`num:${i}:not`] = noul(`In \`request\`, is the comparison with ${n.value} negated — as in 'not over ${n.value}', 'not more than ${n.value}', 'no less than ${n.value}'?`);
    }
  });

  // Time filters are only considered when the request contains time wording at all.
  const temporal = mentionsTime(request) ? byKind("time") : [];
  if (temporal.length) {
    q.time_col = choice(
      "Does `request` limit results to a time period? If so, which date column in `columns` does that period apply to?",
      { ...options(temporal), [NONE]: "The request does not limit results to a time period." }
    );
    q.time_window = choice(
      "Which time period does `request` explicitly limit results to? Only count a period that is stated in words, such as 'today', 'last month' or 'in 2024'. `current_date` gives the date right now.",
      {
        ...TIME_WINDOWS,
        [NONE]: "No time period is stated. Present-tense wording such as 'are', 'is' or 'have' is not a time period.",
      }
    );
    q.time_month = choice("Does `request` name a calendar month as the period to filter by? Which one?", {
      ...Object.fromEntries(MONTHS.map((m) => [m, null])), [NONE]: "No calendar month is named.",
    });
    if (years.length) {
      q.time_year = choice("Which calendar year does `request` limit results to?", {
        ...Object.fromEntries(years.map((y) => [String(y), null])), [NONE]: "No specific calendar year is a filter.",
      });
    }
  }

  const searchable = byKind("text").filter((c) => !c.values).slice(0, 30);
  if (searchable.length) {
    texts.forEach((t, i) => {
      q[`text:${i}`] = choice(
        `In \`request\`, is the phrase "${t}" a specific value to look up in the data — such as a person, company, product, place, email or keyword? If so, which column in \`columns\` would contain it?`,
        {
          ...options(searchable),
          [NONE]: `"${t}" is not a value to search for: it is ordinary wording, a description of the kind of record, or only part of a longer name.`,
        }
      );
      if (negated) {
        q[`nottext:${i}`] = noul(
          `Does \`request\` exclude records that match "${t}" — asking for the ones that are NOT "${t}"?`,
          { true: `"${t}" is ruled out: 'not ${t}', 'except ${t}', 'other than ${t}', 'without ${t}'.`, false: `The request looks FOR "${t}", or does not rule it out.` }
        );
      }
    });
  }
  // A word the planner could not use must not vanish silently. For each single-word candidate, ask
  // whether it names something records are required to be; unused ones that do are reported back.
  texts.filter((t) => !/\s/.test(t)).slice(0, 10).forEach((t) => {
    q[`term:${t}`] = noul(
      `In \`request\`, does the word "${t}" name a specific state, category, label or value that the wanted records must have?`,
      { true: `Yes: "${t}" restricts which records are wanted, like a status ('shipped', 'failed', 'active') or a named thing.`,
        false: `No: "${t}" is ordinary phrasing, such as a verb describing the request ('placed', 'made', 'happened') or a word for the kind of record.` }
    );
  });

  if (context) {
    q.fu_shape = choice(
      `\`request\` is a follow-up. The earlier question was "${context.request}", answered with ${context.reading}. Does \`request\` ask for a different kind of result than that?`,
      {
        keep: "No. It only changes conditions, sorting or how many to show. Examples: 'only the cancelled ones', 'what about last month', 'sort by date', 'just the top 5'.",
        rows: "Yes: it now asks to see or list the individual records. Examples: 'show them', 'list those', 'which ones'.",
        count: "Yes: it now asks how many there are. Examples: 'how many is that', 'count them'.",
        aggregate: "Yes: it now asks for one calculated figure such as a total or an average. Examples: 'what is their total value', 'average amount of those'.",
        breakdown: "Yes: it now asks for one row per group or per time period. Examples: 'break that down by country', 'group them by status', 'per month'.",
        share: "Yes: it now asks what percentage, share, proportion or rate of those records meet a condition. Examples: 'what percent of those were shipped', 'how many of them are active, as a share', 'what fraction failed'.",
      }
    );
    context.conditions.forEach((c, i) => {
      q[`fu_drop:${i}`] = noul(
        `The previous answer was limited by this condition: "${c.phrase}". Does \`request\` ask to remove, ignore or lift that condition?`,
        { true: `The request says to drop it, e.g. 'remove that filter', 'all of them', 'regardless of ${c.phrase.split(" ")[0]}', 'any ${c.phrase.split(" ")[0]}'.`,
          false: "The request does not ask to remove it. Adding or changing other conditions does not count." }
      );
    });
  }
  return q;
}

const MAX_CATEGORY_QUESTIONS = 200;

/** The (column, value) pairs that get a yes/no question, within a fixed budget. */
function categoryQuestions(columns) {
  const out = [];
  for (const column of columns.filter((c) => c.values)) {
    if (out.length + column.values.length > MAX_CATEGORY_QUESTIONS) continue;
    column.values.forEach((value, index) => out.push({ column, index, value }));
  }
  return out;
}

function assemblePlan({ answers, main, joins, columns, numbers, years, texts, now, request, intentOverride }) {
  const byLabel = new Map(columns.map((c) => [c.label, c]));
  const judgments = [];
  const judge = (key, title, answer, { applied = true, labels = {}, soft = false } = {}) => {
    const alts = ranked(answer).slice(0, 4).map((a) => ({ ...a, label: labels[a.value] ?? a.value }));
    judgments.push({ key, title, value: alts[0]?.label, p: alts[0]?.p ?? 0, confidence: answer?.confidence, alternatives: alts.slice(1).filter((a) => a.p >= 0.05), applied, soft });
  };
  const friendly = { [NONE]: "none", [MEASURE]: "computed value", [LIMIT]: "row limit" };

  // intent, with structural fallbacks enforced in code
  // A follow-up that keeps the previous shape is read as a plain list here; only its conditions,
  // sort and limit are taken from it, and the shape is restored when it is merged.
  let intent = intentOverride ?? answers.intent.choice;
  const groupLabel = answers.group_col.choice;
  if (!intentOverride) judge("intent", "Result shape", answers.intent);
  if (intent === "breakdown" && groupLabel === NONE) {
    const runnerUp = ranked(answers.group_col).find((a) => a.value !== NONE);
    if (!runnerUp || runnerUp.p < 0.15) intent = answers.agg_fn.choice === "count" ? "count" : "aggregate";
  }

  // "monthly signups", "orders per week": an explicit period word plus a confident bucket means one row
  // per period, even when the overall shape was read as a plain list.
  const PERIOD_WORDS = /\b(daily|weekly|monthly|quarterly|yearly|annual(ly)?|(per|by|each|every) (day|week|month|quarter|year))\b/i;
  const bucketPick = answers.group_bucket.choice;
  if (!intentOverride && intent === "rows" && PERIOD_WORDS.test(request) && bucketPick !== NONE && answers.group_bucket.probabilities[bucketPick] >= 0.6
    && columns.some((c) => c.kind === "time")) {
    intent = "breakdown";
  }

  const plan = { main: main.id, joins: joins.map((t) => t.id), intent, filters: [], show: [], limit: null, time: null };

  if (intent === "aggregate" || intent === "breakdown") {
    const aggCol = byLabel.get(answers.agg_col.choice);
    plan.agg = { fn: answers.agg_fn.choice, column: aggCol?.id ?? null };
    judge("agg_fn", "Calculation", answers.agg_fn);
    if (plan.agg.fn !== "count") judge("agg_col", "Calculated on", answers.agg_col, { labels: friendly });
    if (plan.agg.fn !== "count" && !aggCol) {
      const fallback = ranked(answers.agg_col).find((a) => byLabel.has(a.value));
      if (fallback) plan.agg.column = byLabel.get(fallback.value).id;
      else plan.agg.fn = "count";
    }
  }
  if (intent === "breakdown") {
    const label = groupLabel !== NONE ? groupLabel : ranked(answers.group_col).find((a) => a.value !== NONE).value;
    let groupCol = byLabel.get(label);
    // "per month" can only be grouped on a date. When Jev is sure the grouping is a time period but
    // picked a non-date column, code takes the best date column instead: Jev's own next choice, else
    // the main table's first date.
    const bucketChoice = answers.group_bucket.choice;
    const wantsPeriod = bucketChoice !== NONE && answers.group_bucket.probabilities[bucketChoice] >= 0.6;
    let corrected = false;
    if (wantsPeriod && groupCol.kind !== "time") {
      const dated = ranked(answers.group_col).map((a) => byLabel.get(a.value)).find((c) => c?.kind === "time")
        ?? columns.find((c) => c.kind === "time" && c.table === main.id) ?? columns.find((c) => c.kind === "time");
      if (dated) { groupCol = dated; corrected = true; }
    }
    plan.group = { column: groupCol.id, bucket: null };
    if (corrected) judgments.push({ key: "group_col", title: "Grouped by", value: groupCol.label, p: answers.group_bucket.probabilities[bucketChoice], alternatives: [], applied: true });
    else judge("group_col", "Grouped by", answers.group_col, { labels: friendly });
    if (groupCol.kind === "time") {
      plan.group.bucket = answers.group_bucket.choice === NONE ? "month" : answers.group_bucket.choice;
      judge("group_bucket", "Time bucket", answers.group_bucket, { labels: friendly });
    }
  }

  // ordering
  const orderChoice = answers.order_col.choice;
  // A weak sort preference flips between calls; below this bar the compiler's default order applies.
  if (orderChoice !== NONE && answers.order_col.probabilities[orderChoice] >= 0.6) {
    const col = byLabel.get(orderChoice);
    const valid = orderChoice === MEASURE ? intent === "breakdown" : intent === "rows" || col?.id === plan.group?.column;
    if (valid) {
      plan.order = { column: orderChoice === MEASURE ? MEASURE : col.id, dir: answers.order_dir.choice };
      judge("order_col", "Sorted by", answers.order_col, { labels: friendly, soft: true });
      judge("order_dir", "Direction", answers.order_dir, { labels: { desc: "descending", asc: "ascending" }, soft: true });
    }
  }

  // displayed columns
  if (intent === "rows" && answers.show_specific.noul >= 0.6) {
    plan.show = columns.filter((c) => (answers[`show:${c.label}`]?.noul ?? 0) >= 0.6).map((c) => c.id);
    if (plan.show.length) {
      judgments.push({ key: "show", title: "Columns shown", value: plan.show.map((id) => id.split(".").pop()).join(", "), p: answers.show_specific.noul, alternatives: [], applied: true });
    }
  }

  // categorical filters
  const claimed = new Set(); // text already consumed by a categorical value
  const byColumn = new Map();
  for (const { column, index, value } of categoryQuestions(columns)) {
    const p = answers[`cat:${column.label}:${index}`]?.noul ?? 0;
    const not = answers[`not:${column.label}:${index}`]?.noul ?? 0;
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column).push({ value, p, not });
  }
  // Values hovering around 0.5 flip between calls, so a category value needs a clear yes.
  const ACCEPT_VALUE = 0.6;
  for (const [c, scored] of byColumn) {
    // "orders per status" names the column, not a value of it: grouping already covers every value.
    if (plan.group?.column === c.id) continue;
    // A value that is ruled out cannot also be wanted: "not cancelled" mentions cancelled, and the
    // exclusion judgment is the more specific of the two.
    const excluded = scored.filter((v) => v.not >= ACCEPT_VALUE && v.not >= v.p);
    // "not cancelled" makes Jev lean towards every other status being wanted, at a probability that
    // hovers around the bar, so only some get through. When something is ruled out, a wanted value
    // only counts if the request actually names it ("paid but not refunded").
    const named = (v) => new RegExp(`\\b${String(v.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/s$/i, "")}`, "i").test(request);
    const picked = scored.filter((v) => v.p >= ACCEPT_VALUE && !excluded.includes(v) && (!excluded.length || named(v)));
    const maybe = scored.filter((v) => v.p >= 0.3 && v.p < ACCEPT_VALUE && !excluded.includes(v)).sort((x, y) => y.p - x.p);
    // Every value accepted is no restriction at all.
    // Every value accepted is no restriction at all, unless the column only has the one known value.
    if (picked.length && (picked.length < scored.length || scored.length === 1)) {
      const p = Math.min(...picked.map((v) => v.p));
      const values = picked.map((v) => v.value);
      plan.filters.push(values.length === 1
        ? { column: c.id, op: "eq", value: values[0], label: c.label, source: "category", p }
        : { column: c.id, op: "in", value: values, label: c.label, source: "category", p });
      values.forEach((v) => claimed.add(v.toLowerCase()));
      judgments.push({
        key: `cat:${c.label}`, title: values.length === 1 ? `${c.label} is` : `${c.label} is one of`, value: values.join(", "), p,
        alternatives: maybe.slice(0, 3).map((v) => ({ value: v.value, label: v.value, p: v.p })), applied: true,
      });
    } else if (excluded.length && excluded.length < scored.length) {
      // Naming the wanted values already excludes the rest, so an exclusion only applies on its own.
      const p = Math.min(...excluded.map((v) => v.not));
      const values = excluded.map((v) => v.value);
      plan.filters.push(values.length === 1
        ? { column: c.id, op: "neq", value: values[0], label: c.label, source: "category", p }
        : { column: c.id, op: "not_in", value: values, label: c.label, source: "category", p });
      values.forEach((v) => claimed.add(v.toLowerCase()));
      judgments.push({ key: `not:${c.label}`, title: `${c.label} is not`, value: values.join(", "), p, alternatives: [], applied: true });
    } else if (maybe.length) {
      judgments.push({ key: `cat:${c.label}`, title: `${c.label} is`, value: maybe[0].value, p: maybe[0].p, alternatives: [], applied: false });
    }
  }

  // A word like "review" can be a value in more than one column. One mention is one condition: keep
  // the column on the main table, otherwise the most probable, and drop the echoes.
  const valueKey = (f) => (Array.isArray(f.value) ? f.value : [f.value]).map((v) => String(v).toLowerCase());
  const categoryFilters = plan.filters.filter((f) => f.source === "category" && (f.op === "eq" || f.op === "in"));
  for (const f of categoryFilters) {
    const rival = categoryFilters.find((g) => g !== f && plan.filters.includes(g) && valueKey(f).every((v) => valueKey(g).includes(v))
      && ((g.column.startsWith(main.id + ".") && !f.column.startsWith(main.id + ".")) || (g.column.startsWith(main.id + ".") === f.column.startsWith(main.id + ".") && (g.p > f.p || (g.p === f.p && valueKey(g).length > valueKey(f).length)))));
    if (!rival) continue;
    plan.filters.splice(plan.filters.indexOf(f), 1);
    const at = judgments.findIndex((j) => j.key === `cat:${f.label}`);
    if (at >= 0) Object.assign(judgments[at], { applied: false, title: `${f.label} is (same word as ${rival.label})` });
  }

  // numbers: either the row limit or a comparison
  numbers.forEach((n, i) => {
    const use = answers[`num:${i}:use`];
    if (!use || use.choice === NONE) return;
    const p = use.probabilities[use.choice];
    const applied = p >= ACCEPT;
    if (use.choice === LIMIT) {
      if (applied && Number.isInteger(n.value) && plan.limit == null) plan.limit = n.value;
    } else if (applied) {
      const col = byLabel.get(use.choice);
      // "not over 500" is "at most 500": a negated comparison flips to its complement.
      const FLIP = { gt: "lte", gte: "lt", lt: "gte", lte: "gt", eq: "neq", neq: "eq" };
      const stated = answers[`num:${i}:op`].choice;
      const op = (answers[`num:${i}:not`]?.noul ?? 0) >= 0.7 ? FLIP[stated] : stated;
      plan.filters.push({ column: col.id, op, value: n.value, label: col.label, source: "number", p: Math.min(p, answers[`num:${i}:op`].probabilities[stated]) });
      if (op !== stated) judgments.push({ key: `num:${i}:not`, title: `Comparison with ${n.value} negated`, value: "yes", p: answers[`num:${i}:not`].noul, alternatives: [], applied: true });
      judge(`num:${i}:op`, `Comparison with ${n.value}`, answers[`num:${i}:op`], { labels: { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠" } });
    }
    judge(`num:${i}:use`, `Number ${n.value}`, use, { applied, labels: friendly });
  });

  // time window
  if (answers.time_window && answers.time_window.choice !== NONE) {
    const windowKey = answers.time_window.choice;
    const pWindow = answers.time_window.probabilities[windowKey];
    const colPick = ranked(answers.time_col).find((a) => a.value !== NONE);
    const month = answers.time_month.choice !== NONE ? MONTHS.indexOf(answers.time_month.choice) : null;
    const yearPick = answers.time_year?.choice;
    const year = yearPick && yearPick !== NONE ? Number(yearPick) : null;
    const range = resolveWindow(windowKey, { month, year }, now);
    // A wrong date range hides most of the data, so a coin-flip is not enough.
    const applied = Boolean(range) && pWindow >= 0.6 && colPick && colPick.p >= 0.2;
    if (applied) {
      const col = byLabel.get(colPick.value);
      const label = windowKey === "named"
        ? [month != null ? MONTHS[month] : null, year ?? (month != null ? range.from.slice(0, 4) : null)].filter(Boolean).join(" ")
        : windowKey.replace(/_/g, " ");
      plan.time = { column: col.id, label: col.label, window: label, ...range, p: Math.min(pWindow, colPick.p) };
      judge("time_col", "Date column", answers.time_col, { labels: friendly });
    }
    if (applied || pWindow >= 0.3) judge("time_window", "Time period", answers.time_window, { applied, labels: friendly });
  }

  // empty / filled-in conditions. A stricter bar: a wrong one silently removes rows.
  for (const c of columns.filter((c) => c.nullable)) {
    const a = answers[`null:${c.label}`];
    if (!a || a.choice === NONE) continue;
    const p = a.probabilities[a.choice];
    // Stated conditions ("never logged in") score near 1; inferred ones sit mid-range and are only suggested.
    const applied = p >= 0.85 && plan.time?.column !== c.id;
    if (applied) plan.filters.push({ column: c.id, op: a.choice, value: "", label: c.label, source: "null", p });
    if (applied || p >= 0.35) judge(`null:${c.label}`, c.label, a, { applied, labels: { is_null: "is empty", not_null: "has a value", [NONE]: "none" } });
  }

  // free-text search terms; a longer accepted phrase absorbs its own fragments
  const accepted = [];
  texts.forEach((t, i) => {
    const a = answers[`text:${i}`];
    if (!a || a.choice === NONE || claimed.has(t.toLowerCase())) return;
    const p = a.probabilities[a.choice];
    const ruledOut = (answers[`nottext:${i}`]?.noul ?? 0) >= 0.6;
    if (p >= ACCEPT) accepted.push({ text: t, column: byLabel.get(a.choice), p, answer: a, index: i, ruledOut });
    else if (p >= 0.3) judge(`text:${i}`, `"${t}" searched in`, a, { applied: false, labels: friendly });
  });
  accepted.sort((a, b) => b.text.length - a.text.length);
  const kept = [];
  for (const cand of accepted) {
    const lower = cand.text.toLowerCase();
    if (kept.some((k) => k.column.id === cand.column.id && k.text.toLowerCase().includes(lower))) continue;
    kept.push(cand);
    plan.filters.push({ column: cand.column.id, op: cand.ruledOut ? "not_contains" : "contains", value: cand.text, label: cand.column.label, source: "text", p: cand.p });
    judge(`text:${cand.index}`, cand.ruledOut ? `"${cand.text}" excluded from` : `"${cand.text}" searched in`, cand.answer, { labels: friendly });
  }

  // Words that look like required values but ended up in no condition.
  const used = plan.filters.flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value])).map((v) => String(v).toLowerCase());
  const unused = texts.filter((t) => !/\s/.test(t) && (answers[`term:${t}`]?.noul ?? 0) >= 0.6
    && !claimed.has(t.toLowerCase()) && !used.some((v) => v.includes(t.toLowerCase()) || t.toLowerCase().includes(v)));
  return { plan, judgments, unused };
}

// ---------------------------------------------------------------------------

/** Today's calendar date on this machine, carried as a UTC date so window arithmetic never crosses a day. */
function localToday() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export async function answer(request, { mainOverride, context: rawContext, now = localToday() } = {}) {
  const started = performance.now();
  const model = await loadModel();
  if (!model.tables.size) {
    const err = new Error("This database has no tables or views to query");
    err.status = 400;
    throw err;
  }
  const usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
  const track = (r) => {
    usage.input_tokens += r.usage?.input_tokens ?? 0;
    usage.output_tokens += r.usage?.output_tokens ?? 0;
    usage.requests++;
  };

  // Stage 1
  const context = mainOverride ? null : validContext(model, rawContext);
  const { tables, response: routed } = await routeTables(model, request, context);
  track(routed);
  const byLabel = new Map(tables.map((t) => [t.label, t]));
  const mainRanking = ranked(routed.answers.main);
  // A follow-up stays on the previous answer's table; everything else about routing is skipped.
  const fu = context ? routed.answers.followup : null;
  const refining = Boolean(fu) && fu.choice === "refine" && fu.probabilities.refine >= 0.6 && model.tables.has(context.plan.main);
  const mainLabel = refining ? model.tables.get(context.plan.main).label
    : mainOverride && byLabel.has(mainOverride) ? mainOverride : routed.answers.main.choice;
  const tableJudgment = {
    key: "main", title: "Main table", value: mainLabel === NONE ? "none" : mainLabel,
    p: routed.answers.main.probabilities[mainLabel] ?? 0, confidence: routed.answers.main.confidence,
    alternatives: mainRanking.filter((a) => a.value !== mainLabel && a.value !== NONE && a.p >= 0.03).slice(0, 4)
      .map((a) => ({ ...a, label: a.value })),
    applied: true, overridable: true,
  };
  if (refining) Object.assign(tableJudgment, { p: fu.probabilities.refine, alternatives: [], overridable: false, title: "Table (from before)" });
  // Questions about the database itself are answered from the catalog model; nothing is queried.
  const kind = routed.answers.kind;
  const kindP = kind.probabilities[kind.choice];
  const kindJudgment = {
    key: "kind", title: "Question type", value: { data: "data", catalog: "about the database", structure: "table structure", other: "unrelated" }[kind.choice],
    p: kindP, alternatives: [], applied: true,
  };
  const meta = { request, model: routed.model, usage, plan: null, sql: null, notes: [] };
  if (!refining && !mainOverride && kind.choice === "catalog" && kindP >= 0.6) {
    const a = catalogAnswer(model);
    return { ok: true, kind: "catalog", ...meta, ms: Math.round(performance.now() - started), confidence: kindP, judgments: [kindJudgment], ...a };
  }
  if (!refining && !mainOverride && kind.choice === "structure" && kindP >= 0.6 && mainLabel !== NONE) {
    const a = describeAnswer(byLabel.get(mainLabel));
    return {
      ok: true, kind: "structure", ...meta, ms: Math.round(performance.now() - started),
      confidence: Math.min(kindP, tableJudgment.p), judgments: [kindJudgment, { ...tableJudgment, title: "Table" }], ...a,
    };
  }
  // A near-tie between tables is a question for the user, not a guess to act on.
  const runnerUp = mainRanking.find((a) => a.value !== mainLabel && a.value !== NONE);
  if (!refining && !mainOverride && mainLabel !== NONE && tableJudgment.p < 0.6 && runnerUp && runnerUp.p >= 0.2) {
    const options = mainRanking.filter((a) => a.value !== NONE && a.p >= 0.1).slice(0, 4).map((a) => {
      const t = byLabel.get(a.value);
      return { table: a.value, p: a.p, rows: t.estRows >= 0 ? t.estRows : null, columns: t.columns.slice(0, 6).map((c) => c.name).join(", ") };
    });
    return {
      ok: false, clarify: options, request, model: routed.model, usage, ms: Math.round(performance.now() - started),
      message: "That could mean more than one table here. Which one do you mean?",
      judgments: [kindJudgment, tableJudgment],
    };
  }
  if (mainLabel === NONE) {
    const unrelated = kind.choice === "other";
    return {
      ok: false, request, model: routed.model, usage, ms: Math.round(performance.now() - started),
      message: unrelated
        ? "I answer questions about this database: what it contains, how its tables are built, and the data inside them. Try one of the suggestions below."
        : "I couldn't tell which table that is about. Try naming the kind of record you are after, or ask what's in this database.",
      judgments: [kindJudgment, tableJudgment],
    };
  }

  const main = byLabel.get(mainLabel);
  const joins = tables
    .filter((t) => t.id !== main.id)
    .map((t) => ({ table: t, p: routed.answers[`uses:${t.label}`]?.noul ?? 0 }))
    // Tables the previous answer joined stay available, so a follow-up can keep filtering on them.
    .map((j) => (refining && context.plan.joins.includes(j.table.id) ? { ...j, p: 1 } : j))
    .filter((j) => j.p >= 0.5 && joinPath(model, main.id, j.table.id))
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_JOINS);

  // Columns of every table on the join paths are fair game for stage 2.
  const involved = new Map([[main.id, main]]);
  for (const j of joins) {
    for (const step of joinPath(model, main.id, j.table.id)) involved.set(step.right, model.tables.get(step.right));
  }
  const columns = [...involved.values()].flatMap((t) => t.columns).slice(0, MAX_COLUMNS);

  // Stage 2
  const schemaWords = new Set();
  for (const t of involved.values()) {
    for (const w of [t.name, ...t.columns.map((c) => c.name)]) {
      for (const part of w.toLowerCase().split(/[^a-z0-9]+/)) if (part) schemaWords.add(part).add(part.replace(/s$/, ""));
    }
  }
  const numbers = numberCandidates(request);
  const years = yearCandidates(request);
  const texts = textCandidates(request, schemaWords);
  const state = {
    request,
    // The previous question is deliberately NOT part of this state. Every judgment here reads the
    // state, and its words would leak into them ("review" from the last question becoming a filter on
    // "show them"). Only the follow-up questions quote it, inside their own instructions.
    current_date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }),
    columns: Object.fromEntries(columns.map((c) => [c.label, describeColumn(c)])),
  };
  const planned = await ask(state, buildQuestions(request, columns, numbers, years, texts, refining ? context : null));
  track(planned);

  let shape = null;
  if (refining) {
    const pick = planned.answers.fu_shape;
    shape = pick.choice !== "keep" && pick.probabilities[pick.choice] >= 0.6 ? pick.choice : "keep";
  }
  let { plan, judgments, unused } = assemblePlan({
    answers: planned.answers, main, joins: joins.map((j) => j.table), columns, numbers, years, texts, now, request,
    intentOverride: refining ? (shape === "keep" ? "rows" : shape) : undefined,
  });
  // For a percentage, the conditions in this question are what is measured; anything carried over from
  // before (and any time period) defines what the percentage is taken of.
  if (plan.intent === "share") for (const f of plan.filters) f.part = true;

  // Alternatives are settled on the question as asked, before any merge: a follow-up's "or" condition
  // must be added to what came before, never substituted for an earlier condition on the same column.
  const either = await markAlternatives(request, model, plan, track);
  if (either) judgments.push(either);
  if (refining) {
    const a = planned.answers;
    const dropped = context.conditions.filter((_, i) => (a[`fu_drop:${i}`]?.noul ?? 0) >= 0.7);
    const sure = (answer) => answer && answer.choice !== NONE && answer.probabilities[answer.choice] >= 0.6;
    const prev = context.plan;
    plan = mergeFollowUp({ prev, fresh: plan, shape, dropped, confident: { agg: sure(a.agg_col), group: sure(a.group_col) } });
    const carried = conditionPhrases(model, { ...plan, filters: plan.filters.filter((f) => f.carried), time: plan.time?.carried ? plan.time : null });
    judgments = [
      { key: "followup", title: "Follows up on", value: context.request, p: fu.probabilities.refine, alternatives: [], applied: true },
      shape !== "keep" && { key: "fu_shape", title: "New result shape", value: shape, p: a.fu_shape.probabilities[shape], alternatives: [], applied: true },
      carried.length && { key: "carried", title: "Kept from before", value: carried.join(" · "), p: 1, alternatives: [], applied: true, soft: true },
      dropped.length && { key: "dropped", title: "Removed", value: dropped.map((d) => d.phrase).join(" · "), p: Math.min(...dropped.map((d) => a[`fu_drop:${context.conditions.indexOf(d)}`].noul)), alternatives: [], applied: true },
      ...judgments,
    ].filter(Boolean);
  }
  // Joins that nothing references would only risk duplicating rows; drop them.
  plan.joins = prunedJoins(model, plan);

  if (joins.length) {
    judgments.splice(0, 0, {
      key: "joins", title: "Related tables", value: joins.map((j) => j.table.label).join(", "),
      p: Math.min(...joins.map((j) => j.p)), alternatives: [], applied: true,
    });
  }
  const notes = [];
  if (unused.length) {
    const list = unused.map((t) => `“${t}”`).join(", ");
    notes.push(`I could not find ${list} in this data, so ${unused.length === 1 ? "it was" : "they were"} not used. No column I looked at has ${unused.length === 1 ? "that value" : "those values"}.`);
  }
  if (plan.intent === "share" && !plan.filters.some((f) => f.part)) {
    return {
      ok: false, request, model: planned.model, usage, ms: Math.round(performance.now() - started),
      followsUp: refining ? context.request : null,
      message: `I can't work out that percentage: ${unused.length ? `I could not find ${unused.map((t) => `“${t}”`).join(", ")} anywhere in ${main.label} or the tables linked to it, so there is nothing to measure.` : "I couldn't tell which condition to measure."} Try naming a value that exists, or ask what values a column has.`,
      judgments: [tableJudgment, ...judgments],
    };
  }
  const result = await execute(model, plan);
  result.notes = [...notes, ...(result.notes ?? [])];
  // Sort order is a harmless preference: it never lowers the headline confidence.
  const applied = [tableJudgment, ...judgments].filter((j) => j.applied && !j.soft && j.key !== "joins");
  return {
    ok: true, request, model: planned.model, usage, ms: Math.round(performance.now() - started),
    // An ignored word means part of the question went unanswered, whatever the other judgments say.
    confidence: Math.min(...applied.map((j) => j.p), unused.length ? 0.4 : 1),
    judgments: [tableJudgment, ...judgments],
    kind: "data",
    followsUp: refining ? context.request : null,
    plan,
    editor: editorOptions(model, plan),
    ...result,
    summary: summarize(model, plan, result.result, result.error),
  };
}

// ---------------------------------------------------------------------------
// Stage 3, only when needed — which conditions are alternatives ("cancelled OR over 1000")?
// This can only be asked once the conditions are known, so it is a request of its own. It runs
// when the request says "or"/"either" and produced conditions on at least two different columns.
// ---------------------------------------------------------------------------
async function markAlternatives(request, model, plan, track) {
  const fresh = plan.filters.filter((f) => !f.carried);
  if (!mentionsOr(request) || new Set(fresh.map((f) => f.column)).size < 2) return null;
  const phrases = conditionPhrases(model, plan);
  const items = plan.filters.map((f, i) => ({ f, phrase: phrases[i] })).filter(({ f }) => !f.carried);
  const state = { request, conditions: Object.fromEntries(items.map((it, i) => [`c${i + 1}`, it.phrase])) };
  const questions = Object.fromEntries(items.map((it, i) => [`or:${i}`, noul(
    `\`request\` was read as the conditions in \`conditions\`. Is the condition "${it.phrase}" one side of an "or" between different conditions — so that a record qualifies by meeting this condition OR another one, without having to meet them all?`,
    {
      true: `Yes: the request joins "${it.phrase}" to another condition with "or" or "either … or". Example: 'cancelled or over 1000', 'either remote or in Berlin'.`,
      false: `No: every record must meet "${it.phrase}". An "or" that only lists several values of one thing, such as 'Japan or Brazil', does not make it an alternative.`,
    }
  )]));
  const response = await ask(state, questions);
  track(response);
  const scored = items.map((it, i) => ({ ...it, p: response.answers[`or:${i}`].noul }));
  const either = scored.filter((x) => x.p >= 0.6);
  if (either.length < 2) return null;
  for (const x of either) x.f.or = true;
  return { key: "either", title: "Either of", value: either.map((x) => x.phrase).join("  or  "), p: Math.min(...either.map((x) => x.p)), alternatives: [], applied: true };
}

function prunedJoins(model, plan) {
  const referenced = new Set();
  const note = (id) => id && id !== MEASURE && referenced.add(id.split(".").slice(0, -1).join("."));
  plan.filters.forEach((f) => note(f.column));
  plan.show.forEach(note);
  note(plan.time?.column); note(plan.group?.column); note(plan.agg?.column); note(plan.order?.column);
  return plan.joins.filter((id) => referenced.has(id));
}

/** Column choices for the plan editor in the UI. */
function editorOptions(model, plan) {
  const ids = new Set([plan.main]);
  for (const j of plan.joins) for (const s of joinPath(model, plan.main, j) ?? []) ids.add(s.right);
  return {
    columns: [...ids].flatMap((id) => model.tables.get(id).columns.map((c) => ({ id: c.id, label: c.label, kind: c.kind }))),
  };
}

async function execute(model, plan) {
  const compiled = compile(model, plan);
  try {
    const result = await runSql(compiled.sql, compiled.params, { timeoutMs: 20_000 });
    return { sql: compiled.display, notes: compiled.notes, result };
  } catch (err) {
    return { sql: compiled.display, notes: compiled.notes, result: null, error: err.message };
  }
}

/** Re-run a plan the user edited. No inference: judgments stay, only composition changes. */
export async function rerun(input) {
  if (!input || typeof input !== "object") throw Object.assign(new Error("A plan is required"), { status: 400 });
  const arr = (v) => (Array.isArray(v) ? v : []);
  const plan = { ...input, joins: arr(input.joins), filters: arr(input.filters), show: arr(input.show) };
  const model = await loadModel();
  const result = await execute(model, plan);
  return { ok: true, kind: "data", plan, editor: editorOptions(model, plan), ...result, summary: summarize(model, plan, result.result, result.error) };
}

/** Example questions for the connected database, built from its schema. */
export async function suggestions() {
  return buildSuggestions(await loadModel());
}
