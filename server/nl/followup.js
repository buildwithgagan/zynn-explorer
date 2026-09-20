// Follow-up questions. Jev keeps no conversation state, so the context carried between turns is
// the previous question and its structured plan. A follow-up ("only the cancelled ones", "what about
// last month", "how many is that") is read on its own and then merged into that plan here, in code.

import { compile } from "./compile.js";
import { conditionPhrases, conditionsText } from "./assistant.js";

const SHAPE_WORDS = { rows: "a list of", count: "a count of", aggregate: "one calculated figure over", breakdown: "a breakdown of", share: "a percentage of" };
const words = (name) => String(name).replace(/_/g, " ");

/**
 * Validate a plan that came back from the browser. It is untrusted: it only becomes context if it
 * compiles against the live catalog, which proves every table, column and operator in it is real.
 */
export function validContext(model, context) {
  const plan = context?.plan;
  const request = typeof context?.request === "string" ? context.request.slice(0, 600) : "";
  if (!plan || typeof plan !== "object" || !request) return null;
  try {
    const clean = {
      main: plan.main, joins: Array.isArray(plan.joins) ? plan.joins : [], intent: plan.intent,
      agg: plan.agg ?? undefined, group: plan.group ?? undefined, order: plan.order ?? null,
      limit: Number.isInteger(plan.limit) ? plan.limit : null,
      show: Array.isArray(plan.show) ? plan.show : [], filters: Array.isArray(plan.filters) ? plan.filters : [],
      time: plan.time ?? null,
    };
    compile(model, clean);
    return { request, plan: clean, conditions: conditionList(model, clean), reading: describePlan(model, clean) };
  } catch {
    return null;
  }
}

/** The previous plan's removable conditions, in a fixed order, each with the phrase Jev is shown. */
export function conditionList(model, plan) {
  const phrases = conditionPhrases(model, plan);
  const list = plan.filters.map((f, i) => ({ kind: "filter", index: i, phrase: phrases[i] }));
  if (plan.time) list.push({ kind: "time", phrase: phrases[phrases.length - 1] });
  return list;
}

/** One sentence telling Jev what the previous answer was about. */
export function describePlan(model, plan) {
  const noun = words(model.tables.get(plan.main)?.name ?? "records");
  const where = conditionsText(model, plan);
  const group = plan.intent === "breakdown" && plan.group ? ` grouped by ${words(plan.group.column.split(".").pop())}` : "";
  const calc = plan.agg?.column && plan.agg.fn !== "count" ? ` (${plan.agg.fn} of ${words(plan.agg.column.split(".").pop())})` : "";
  return `${SHAPE_WORDS[plan.intent] ?? "a list of"} ${noun}${calc}${group}${where ? ` where ${where}` : ""}`;
}

/**
 * Merge a follow-up into the previous plan.
 *
 * `fresh` is the follow-up read on its own (its conditions, sort, limit and, when the shape changes,
 * its grouping and calculation). `shape` is "keep" or a new result shape. `dropped` holds the
 * previous conditions the follow-up asked to remove.
 */
export function mergeFollowUp({ prev, fresh, shape, dropped = [], confident = {} }) {
  const droppedFilters = new Set(dropped.filter((d) => d.kind === "filter").map((d) => d.index));
  const timeDropped = dropped.some((d) => d.kind === "time");
  // A new condition on a column replaces the old one on it: "what about Brazil" after "in Japan".
  // An alternative ("… or refunded") widens the question rather than restating it, so it replaces nothing.
  // The measured part of a percentage is likewise an addition: "what percent of those were refunded".
  const replaced = new Set(fresh.filters.filter((f) => f.or !== true && f.part !== true).map((f) => f.column));
  const intent = shape === "keep" ? prev.intent : shape;
  // Percentage after percentage. Asked again ("what percent are in review"), the new conditions are a
  // new numerator and the old one goes. Refined without restating it ("and in triage?"), a condition
  // on the column that was being measured takes over as the numerator.
  const measuredBefore = new Set(prev.filters.filter((f) => f.part).map((f) => f.column));
  const again = prev.intent === "share" && shape === "share";
  const freshFilters = fresh.filters.map((f) => (intent === "share" && shape === "keep" && measuredBefore.has(f.column) ? { ...f, part: true } : f));
  const kept = prev.filters.filter((f, i) => !droppedFilters.has(i) && !replaced.has(f.column) && !(again && f.part)
    && !(f.part && freshFilters.some((n) => n.part && n.column === f.column)));

  const plan = {
    main: prev.main,
    joins: [...new Set([...(prev.joins ?? []), ...(fresh.joins ?? [])])],
    intent,
    filters: [...kept.map((f) => ({ ...f, carried: true })), ...freshFilters],
    time: fresh.time ?? (timeDropped ? null : prev.time ? { ...prev.time, carried: true } : null),
    show: fresh.show?.length ? fresh.show : prev.show ?? [],
    limit: fresh.limit ?? (intent === prev.intent ? prev.limit ?? null : null),
    order: fresh.order ?? (intent === prev.intent ? prev.order ?? null : null),
  };

  if (intent === "aggregate" || intent === "breakdown") {
    // The calculation carries over ("break that down by country" keeps "total revenue") unless the
    // follow-up clearly names another one.
    const prevAgg = prev.agg && (prev.intent === "aggregate" || prev.intent === "breakdown") ? prev.agg : null;
    plan.agg = confident.agg || !prevAgg ? fresh.agg ?? prevAgg ?? { fn: "count", column: null } : prevAgg;
  }
  if (intent === "breakdown") {
    plan.group = (shape !== "keep" || confident.group) && fresh.group ? fresh.group : prev.group ?? fresh.group;
    if (!plan.group) { plan.intent = plan.agg && plan.agg.fn !== "count" ? "aggregate" : "count"; }
    // A ranking only makes sense on the measure or the group itself.
    if (plan.order && plan.order.column !== "__measure__" && plan.order.column !== plan.group?.column) plan.order = prev.intent === "breakdown" ? prev.order ?? null : null;
  } else if (plan.order?.column === "__measure__") plan.order = null;
  if (plan.intent === "count" || plan.intent === "aggregate" || plan.intent === "share") { plan.limit = null; plan.order = null; }
  // Outside a percentage nothing is "measured": a condition that was the numerator becomes an ordinary one.
  if (plan.intent !== "share") plan.filters = plan.filters.map(({ part, ...f }) => f);
  return plan;
}
