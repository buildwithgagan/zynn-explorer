// Sample rows that make sense as rows. Each value is first generated on its own (archetypes.js); this pass then reads the
// row as a whole and fixes what cannot be true together: a session that expires before it was created, a yearly price
// below the monthly one, a cancellation date on an active subscription. Everything here is a rule on column names and
// types. Nothing is asked of a model, and a column the rules do not recognise is left exactly as generated.

const DAY = 86_400_000, HOUR = 3_600_000;
const MOMENT = ["timestamptz", "timestamp", "date"];
const isMoment = (c) => MOMENT.includes(c.type?.base);
const between = (rng, min, max) => min + rng() * Math.max(0, max - min);

const CREATED = /^(created|inserted|registered|signed_up|joined)_(at|on)$/;
const UPDATED = /^(updated|modified|changed)_(at|on)$/;
const START = /^(starts?|started|begins?|began|placed|ordered|issued|opened|published|scheduled|enrolled|hired?|happened|entry|effective_from|valid_from|given)(_at|_on|_date|_time)?$|(^|_)(start|from)(_date|_at|_on)?$/;
// An end that is often still ahead: expiry, due dates, the end of a period.
const AHEAD = /(^|_)(expires?|expiry|due|valid_until|period_end|ends?|until|renews?|renewal|trial_ends?|effective_to|next_due)(_at|_on|_date)?$|_to$/;
// Something that happened to the row, or has not yet.
const EVENT = /(^|_)(paid|cancell?ed|revoked|used|closed|completed|finished|shipped|delivered|resolved|deleted|archived|verified|confirmed|approved|rejected|refunded|posted|sent|read|last_login|last_seen|last_used|locked)(_at|_on|_until|_date)?$/;
// The status values under which an event has happened. Absent here means: decided by chance.
const EVENT_STATUS = {
  paid: ["paid", "refunded"], cancelled: ["cancelled", "canceled"], canceled: ["cancelled", "canceled"], closed: ["closed", "solved", "resolved"], resolved: ["solved", "resolved", "closed"],
  completed: ["completed", "done", "finished"], finished: ["completed", "done", "finished"], shipped: ["shipped", "delivered"], delivered: ["delivered"],
  deleted: ["deleted"], archived: ["archived"], approved: ["approved"], rejected: ["rejected"], refunded: ["refunded"], posted: ["posted"], sent: ["sent", "paid", "open"],
};
// How often an event has happened when nothing else says. Revoking is rare; logging in is not.
const EVENT_CHANCE = { revoked: 0.12, locked: 0.08, deleted: 0.05, archived: 0.1, used: 0.45, last_login: 0.9, last_seen: 0.9, last_used: 0.7, verified: 0.8, read: 0.6 };

const stemOf = (name) => EVENT.exec(name)?.[2] ?? null;

/** What part a column plays in its row's story, if any. */
export function roleOf(column) {
  const n = column.name;
  if (isMoment(column)) {
    if (CREATED.test(n)) return "created";
    if (UPDATED.test(n)) return "updated";
    if (EVENT.test(n)) return "event";
    if (AHEAD.test(n)) return "ahead";
    if (START.test(n)) return "start";
    return null;
  }
  return null;
}

/** Audit columns that default to now(). Left alone every row would be "created" at the instant of the insert. */
export const isAuditMoment = (column) => isMoment(column) && (CREATED.test(column.name) || UPDATED.test(column.name));

const format = (column, ms) => (column.type.base === "date" ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString());

/**
 * Make one generated row coherent, in place.
 * @param row     values, in the order of `plan`
 * @param plan    [{ column, source, values? }] from columnPlan
 * @param ctx     { rng, now (ms), notBefore (ms | null): the latest moment a parent row was created }
 * @returns the moment the row was created (ms), so its children can come after it
 */
export function cohere(row, plan, { rng, now, notBefore = null }) {
  const at = (name) => plan.findIndex((p) => p.column.name === name);
  const has = (i) => i >= 0;
  const roles = plan.map((p) => (p.source === "fk" || p.source === "enum" ? null : roleOf(p.column)));

  // The row's own statuses, for events that follow from them.
  const statuses = new Set(plan.map((p, i) => (p.source === "enum" || /^(status|state|stage)$/.test(p.column.name) ? String(row[i]).toLowerCase() : null)).filter(Boolean));
  const statusDomain = new Set(plan.flatMap((p) => (p.source === "enum" ? p.values.map((v) => v.toLowerCase()) : [])));

  // ---- time. A row is created some time in the last year and a bit, never before the rows it belongs to.
  const floor = Math.max(now - 400 * DAY, notBefore ?? -Infinity);
  const created = Math.min(now - HOUR, between(rng, floor, now - HOUR));
  let base = created;
  const set = (i, ms) => { row[i] = format(plan[i].column, ms); };

  roles.forEach((role, i) => { if (role === "created") set(i, created); });
  roles.forEach((role, i) => {
    if (role !== "start") return;
    // A booking or a schedule may lie ahead; most other starts are at, or shortly after, creation.
    const planned = /^(starts?|scheduled|begins?)(_at|_on|_date|_time)?$/.test(plan[i].column.name);
    base = planned ? between(rng, created, now + 30 * DAY) : between(rng, created, Math.min(now, created + 2 * DAY));
    set(i, base);
  });
  roles.forEach((role, i) => {
    if (role !== "ahead") return;
    if (plan[i].column.nullable && rng() < 0.1) { row[i] = null; return; }
    // Around now, so that some have passed and more have not, but always after the row began.
    const end = Math.max(base + HOUR, between(rng, now - 20 * DAY, now + 45 * DAY));
    set(i, end);
  });
  roles.forEach((role, i) => {
    if (role !== "event") return;
    const column = plan[i].column, stem = stemOf(column.name);
    const tied = EVENT_STATUS[stem]?.filter((s) => statusDomain.has(s) || statuses.has(s)) ?? [];
    // "pending" users are not verified; otherwise an event follows its status when there is one, and chance when not.
    const happened = stem === "verified" && statuses.has("pending") ? false
      : tied.length ? tied.some((s) => statuses.has(s))
      : rng() < (EVENT_CHANCE[stem] ?? 0.3);
    if (!happened && column.nullable) { row[i] = null; return; }
    if (stem === "locked") { set(i, between(rng, now + HOUR, now + 2 * DAY)); return; }
    set(i, Math.min(now, between(rng, base + HOUR, Math.max(base + 2 * HOUR, Math.min(now, base + 30 * DAY)))));
  });
  roles.forEach((role, i) => { if (role === "updated") set(i, between(rng, base, now)); });

  // ---- numbers that are said of the same thing.
  const num = (i) => Number(row[i]);
  const put = (i, v) => { row[i] = typeof row[i] === "string" ? v.toFixed(2) : Math.round(v); };
  plan.forEach((p, i) => {
    const n = p.column.name;
    // A year costs about ten months: the usual discount for paying annually.
    const yearly = /^(yearly|annual)_(.+)$/.exec(n);
    if (yearly) { const m = at(`monthly_${yearly[2]}`); if (has(m)) { if (num(m) > 500) put(m, between(rng, 5, 199)); put(i, num(m) * 10); } }
    const max = /^max_(.+)$/.exec(n) ?? /^(.+)_max$/.exec(n);
    if (max) { const lo = has(at(`min_${max[1]}`)) ? at(`min_${max[1]}`) : at(`${max[1]}_min`); if (has(lo) && num(i) < num(lo)) [row[i], row[lo]] = [row[lo], row[i]]; }
    // A line's total is its quantity times its unit price.
    if (/^(line_)?(total|subtotal|amount)$/.test(n) && row[i] != null) {
      const q = at("quantity"), u = has(at("unit_price")) ? at("unit_price") : at("price");
      if (has(q) && has(u)) put(i, num(q) * num(u));
    }
    // Failed attempts are rare: most rows have none.
    if (/(^|_)(failed|failure|error|retry|retries|attempts?)(_|$)/.test(n) && typeof row[i] === "number") row[i] = rng() < 0.8 ? 0 : Math.floor(between(rng, 1, 7));
  });
  // A journal line is a debit or a credit, not both.
  const debit = at("debit"), credit = at("credit");
  if (has(debit) && has(credit)) { if (rng() < 0.5) put(debit, 0); else put(credit, 0); }

  return created;
}
