import { h } from "./ui.js";

// Pieces the two assistants (Ask and Create) share.

export const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; /* private mode or full */ } },
};

export const pct = (p) => `${Math.round(p * 100)}%`;
export const SEND_ICON = ["M12 19V5", "M5 12l7-7 7 7"];

/** One Jev judgment: what was asked, what it answered, how sure it was, and the runners-up. */
export function judgmentCard(j, onOverride) {
  const level = j.p >= 0.8 ? "" : j.p >= 0.55 ? "mid" : "low";
  return h(`div.judgment${j.applied ? "" : ".unused"}`,
    h("div.top", h("span.title", j.title), h("span.value", { title: j.value }, j.value ?? "—"),
      h("span.p", { title: j.rule ? "Decided by a rule in code, not by Jev" : "Probability Jev assigned to this answer" }, j.rule ? "rule" : j.applied ? pct(j.p) : `${pct(j.p)} · not applied`)),
    h("div.meter", h(`i${level ? "." + level : ""}`, { style: `width:${pct(j.p)}` })),
    j.alternatives?.length ? h("div.alts", j.alternatives.map((a) => j.overridable
      ? h("button", { title: "Re-plan with this table", onclick: () => onOverride(a.value) }, `${a.label} ${pct(a.p)}`)
      : h("span", `${a.label} ${pct(a.p)}`))) : null);
}
