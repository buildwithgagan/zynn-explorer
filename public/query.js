import { h, api, enc, fmtNum, codeBlock, resultTable, toCsv, download, errorBox, loading, zynnMark, lineIcon } from "./ui.js";

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

function resultView(result, name = "result") {
  return h("div",
    h("div.toolbar", h("span.info", `${fmtNum(result.rows.length)} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""} · ${result.ms} ms`),
      h("span.spacer"), result.fields.length ? h("button.btn.small", { onclick: () => download(`${name}.csv`, toCsv(result)) }, "CSV") : null),
    resultTable(result));
}

// ---------------------------------------------------------------- SQL editor
export function sqlPage(params) {
  const out = h("div");
  const editor = h("textarea.editor", { spellcheck: false, placeholder: "select …   (⌘/Ctrl + Enter to run)" });
  editor.value = params.get("q") ?? store.get("pgx.sql.draft", "");
  const write = h("input", { type: "checkbox" });
  const historyBox = h("div.history");

  const renderHistory = () => historyBox.replaceChildren(...store.get("pgx.sql.history", []).map((q) =>
    h("button", { title: q, onclick: () => { editor.value = q; editor.focus(); } }, q.replace(/\s+/g, " "))));

  async function run(explain) {
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    const sql = selected || editor.value.trim();
    if (!sql) return;
    store.set("pgx.sql.draft", editor.value);
    out.replaceChildren(loading("Running"));
    try {
      const result = await api("/sql", { sql, write: write.checked, explain });
      store.set("pgx.sql.history", [sql, ...store.get("pgx.sql.history", []).filter((q) => q !== sql)].slice(0, 15));
      renderHistory();
      out.replaceChildren(explain ? h("pre.code", result.rows.map((r) => r[0]).join("\n")) : resultView(result, "query"));
    } catch (err) {
      out.replaceChildren(errorBox(err));
      if (err.position) { editor.focus(); editor.setSelectionRange(Number(err.position) - 1, Number(err.position)); }
    }
  }

  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
    if (e.key === "Tab") { e.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); }
  });
  renderHistory();

  return h("div.page", { style: "max-width:none" },
    h("div.page-head", h("h1", "SQL"), h("span.sub", "runs in a read-only transaction unless writes are enabled")),
    editor,
    h("div.toolbar", { style: "margin-top:10px" },
      h("button.btn.primary", { onclick: () => run() }, "Run ⌘↵"),
      h("button.btn", { onclick: () => run("plan") }, "Explain"),
      h("button.btn", { onclick: () => run("analyze") }, "Explain analyze"),
      h("span.spacer"),
      h("label.check", { title: "Commit changes instead of rolling back" }, write, "Allow writes")),
    h("div.section", out),
    h("div.section", h("h2", "History"), historyBox));
}

// ---------------------------------------------------------------- Ask (Jev)
const INTENT_LABELS = { rows: "list of rows", count: "count", aggregate: "single number", breakdown: "breakdown by group", share: "percentage" };
const OP_LABELS = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", is_null: "is empty", not_null: "has a value", in: "is one of", not_in: "is none of", not_contains: "does not contain" };
const pct = (p) => `${Math.round(p * 100)}%`;

function judgmentCard(j, onOverride) {
  const level = j.p >= 0.8 ? "" : j.p >= 0.55 ? "mid" : "low";
  return h(`div.judgment${j.applied ? "" : ".unused"}`,
    h("div.top", h("span.title", j.title), h("span.value", { title: j.value }, j.value ?? "—"),
      h("span.p", { title: "Probability Jev assigned to this answer" }, j.applied ? pct(j.p) : `${pct(j.p)} · not applied`)),
    h("div.meter", h(`i${level ? "." + level : ""}`, { style: `width:${pct(j.p)}` })),
    j.alternatives?.length ? h("div.alts", j.alternatives.map((a) => j.overridable
      ? h("button", { title: "Re-plan with this table", onclick: () => onOverride(a.value) }, `${a.label} ${pct(a.p)}`)
      : h("span", `${a.label} ${pct(a.p)}`))) : null);
}

function planEditor(data, onChange) {
  const { plan, editor } = data;
  const colOptions = (selected, filter, extra = []) => [
    ...extra.map(([v, l]) => h("option", { value: v, selected: selected === v }, l)),
    ...editor.columns.filter(filter ?? (() => true)).map((c) => h("option", { value: c.id, selected: selected === c.id }, c.label)),
  ];
  const update = (mutate) => (e) => { mutate(e.target.value); onChange(plan); };
  const rows = [];
  const row = (label, control) => rows.push(h("label", label), control);

  row("Result", h("select.input", { onchange: update((v) => {
    plan.intent = v;
    if (v === "breakdown") plan.group ??= { column: editor.columns[0].id, bucket: null };
    if (v === "aggregate" || v === "breakdown") plan.agg ??= { fn: "count", column: null };
  }) }, Object.entries(INTENT_LABELS).map(([v, l]) => h("option", { value: v, selected: plan.intent === v }, l))));

  if (plan.intent === "aggregate" || plan.intent === "breakdown") {
    row("Calculate", h("div.pair",
      h("select.input", { onchange: update((v) => (plan.agg.fn = v)) }, ["count", "sum", "avg", "min", "max"].map((f) => h("option", { selected: plan.agg.fn === f }, f))),
      h("select.input", { onchange: update((v) => (plan.agg.column = v || null)) }, colOptions(plan.agg.column ?? "", (c) => c.kind === "number", [["", "(rows)"]]))));
  }
  if (plan.intent === "breakdown") {
    const groupKind = editor.columns.find((c) => c.id === plan.group.column)?.kind;
    row("Group by", h("div.pair",
      h("select.input", { onchange: update((v) => (plan.group.column = v)) }, colOptions(plan.group.column)),
      groupKind === "time" && h("select.input", { onchange: update((v) => (plan.group.bucket = v)) }, ["day", "week", "month", "quarter", "year"].map((b) => h("option", { selected: plan.group.bucket === b }, b)))));
  }
  if (plan.intent === "rows" || plan.intent === "breakdown") {
    const extra = [["", "(none)"], ...(plan.intent === "breakdown" ? [["__measure__", "computed value"]] : [])];
    row("Sort by", h("div.pair",
      h("select.input", { onchange: update((v) => (plan.order = v ? { column: v, dir: plan.order?.dir ?? "desc" } : null)) },
        colOptions(plan.order?.column ?? "", plan.intent === "breakdown" ? (c) => c.id === plan.group.column : null, extra)),
      plan.order && h("select.input", { onchange: update((v) => (plan.order.dir = v)) }, [["desc", "descending"], ["asc", "ascending"]].map(([v, l]) => h("option", { value: v, selected: plan.order.dir === v }, l)))));
    row("Limit", h("input.input", { type: "number", min: 1, max: 5000, value: plan.limit ?? "", placeholder: plan.intent === "rows" ? "100" : "500",
      onchange: update((v) => (plan.limit = v ? Math.trunc(Number(v)) : null)) }));
  }

  const filterChips = [
    ...plan.filters.map((f, i) => h(`span.chip${f.or ? ".either" : ""}`, { title: `${f.or ? "One of several alternatives (OR). " : ""}Jev probability ${pct(f.p ?? 1)}` }, f.or && h("b", "or"), f.part && h("b", "measured"), `${f.label} ${OP_LABELS[f.op]} ${Array.isArray(f.value) ? f.value.join(", ") : f.value}`,
      h("button", { onclick: () => { plan.filters.splice(i, 1); onChange(plan); } }, "✕"))),
    plan.time && h("span.chip", `${plan.time.label} in ${plan.time.window} (${plan.time.from} → ${plan.time.to})`,
      h("button", { onclick: () => { plan.time = null; onChange(plan); } }, "✕")),
  ].filter(Boolean);

  return h("div.panel", h("div.plan-editor", rows),
    filterChips.length ? h("div", { style: "padding:0 12px 12px" }, h("h2", "Filters"), h("div.chips", filterChips)) : null);
}

// Conversations are kept per database and saved in the browser, so they survive page changes,
// reloads and reconnecting. Saved results are trimmed so a long thread stays within storage limits.
const threads = new Map();
const THREAD_KEY = (key) => `zynn.explorer.chat:${key}`;
const MAX_TURNS = 40;
const MAX_SAVED_ROWS = 100;

function loadThread(key) {
  const saved = store.get(THREAD_KEY(key), []);
  return Array.isArray(saved) ? saved.filter((t) => t && typeof t.request === "string" && t.data) : [];
}

function saveThread(key, thread) {
  const slim = thread.filter((t) => t.data).slice(-MAX_TURNS).map((t) => ({
    request: t.request, standalone: t.standalone || undefined,
    data: t.data.result ? { ...t.data, result: { ...t.data.result, rows: t.data.result.rows.slice(0, MAX_SAVED_ROWS), truncated: t.data.result.truncated || t.data.result.rows.length > MAX_SAVED_ROWS } } : t.data,
  }));
  try { localStorage.setItem(THREAD_KEY(key), JSON.stringify(slim)); }
  catch { try { localStorage.setItem(THREAD_KEY(key), JSON.stringify(slim.slice(-8))); } catch { /* storage full or unavailable */ } }
}

const SEND_ICON = ["M12 19V5", "M5 12l7-7 7 7"];
const relHref = (r) => `#/rel/${enc(r.schema)}/${enc(r.name)}`;

/** The body of one assistant turn. Re-rendered in place when the plan is edited. */
function answerView(turn, { reask, rerender }) {
  const d = turn.data;
  if (turn.error) return h("div.answer", errorBox(turn.error));
  if (!d) return h("div.answer.thinking", h("span.dots", h("i"), h("i"), h("i")), "Reading your question");

  const parts = [];
  if (d.followsUp) {
    parts.push(h("div.thread-link", h("span", "↳ follow-up to"), h("q", d.followsUp),
      h("button", { type: "button", title: "Read this question on its own, without the previous answer", onclick: () => reask(null, { standalone: true }) }, "ask as a new question")));
  }
  if (!d.ok) {
    parts.push(h("p.say", d.message));
    if (d.clarify) {
      parts.push(h("div.clarify", d.clarify.map((o) => h("button", { type: "button", onclick: () => reask(o.table) },
        h("strong.mono", o.table), h("small", `${o.rows != null ? fmtNum(o.rows) + " rows · " : ""}${o.columns}`)))));
    }
  } else {
    const sum = d.summary ?? {};
    if (sum.headline != null) parts.push(h("div.figure", sum.headline), h("p.say.caption", sum.text));
    else parts.push(h("p.say", sum.text));

    if (d.error) parts.push(errorBox(new Error(d.error)));
    const single = d.kind === "data" && ["count", "aggregate", "share"].includes(d.plan.intent);
    if (d.result && !single && d.result.rows.length) {
      const view = resultView(d.result, "answer");
      // Catalog answers link each table name to its page in the explorer.
      if (d.result.links) {
        view.querySelectorAll("tbody tr").forEach((tr, i) => {
          const cell = tr.children[1];
          cell.replaceChildren(h("a", { href: relHref(d.result.links[i]) }, cell.textContent));
        });
      }
      parts.push(view);
    }
    if (d.result?.open) parts.push(h("div.toolbar", h("a.btn.small", { href: relHref(d.result.open) }, "Open table"), h("a.btn.small", { href: `${relHref(d.result.open)}?tab=data` }, "Browse its data")));
    for (const n of d.notes ?? []) parts.push(h("div.note", n));
    if (d.kind === "data" && d.confidence != null && d.confidence < 0.6) {
      parts.push(h("div.note", "I wasn't sure about part of this reading. Check how I read it below, and adjust if needed."));
    }
  }

  const weakest = d.confidence != null ? ` · weakest ${pct(d.confidence)}` : "";
  const drawers = [
    d.judgments?.length && h("details.drawer", h("summary", `How I read it`, h("span.hint", `${d.judgments.length} judgment${d.judgments.length === 1 ? "" : "s"}${weakest}`)),
      h("div.judgments", d.judgments.map((j) => judgmentCard(j, (table) => reask(table)))),
      d.usage && h("div.meta-line", `${d.model} · ${d.usage.requests} request${d.usage.requests === 1 ? "" : "s"} · ${fmtNum(d.usage.input_tokens)} tokens · ${d.ms} ms`)),
    d.sql && h("details.drawer", h("summary", "SQL", h("span.hint", "read-only")), codeBlock(d.sql),
      h("div.toolbar", { style: "margin-top:8px" }, h("a.btn.small", { href: `#/sql?q=${enc(d.sql)}` }, "Open in SQL editor"),
        h("button.btn.small", { onclick: (e) => { navigator.clipboard.writeText(d.sql); e.target.textContent = "Copied"; } }, "Copy"))),
    d.plan && h("details.drawer", { open: turn.adjusting }, h("summary", "Adjust", h("span.hint", "recompiles without asking Jev again")),
      planEditor(d, async (plan) => {
        turn.adjusting = true;
        try {
          const next = await api("/nl/rerun", { plan });
          turn.data = { ...d, ...next };
        } catch (err) { turn.data = { ...d, error: err.message, result: null }; }
        rerender();
      })),
  ].filter(Boolean);
  return h("div.answer", parts, drawers.length ? h("div.drawers", drawers) : null);
}

export function askPage(params, status) {
  const c = status.connection;
  const key = `${c.host}:${c.port}/${c.database}`;
  if (!threads.has(key)) threads.set(key, loadThread(key));
  const thread = threads.get(key);
  const persist = () => saveThread(key, thread);

  const list = h("div.chat-thread");
  const scroller = h("div.chat-scroll", list);
  const chips = h("div.suggestions", { "aria-label": "Suggested questions" });
  const input = h("textarea.composer-input", { rows: 1, maxLength: 600, placeholder: `Ask about ${c.database}…`, "aria-label": "Your question", disabled: !status.jev });
  const send = h("button.send", { type: "submit", title: "Send", "aria-label": "Send", disabled: true }, lineIcon(SEND_ICON, 18));
  let busy = false;
  let suggested = [];

  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; };
  const sync = () => { send.disabled = busy || !input.value.trim() || !status.jev; };
  const toBottom = () => requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });

  // The context for a turn is the most recent data answer before it: its question and its plan as it
  // stands now, so edits made through Adjust carry into the follow-up too.
  function contextBefore(turn) {
    const earlier = thread.slice(0, thread.indexOf(turn)).reverse().find((t) => t.data?.ok && t.data.kind === "data" && t.data.plan && !t.data.error);
    return earlier ? { request: earlier.request, plan: earlier.data.plan } : undefined;
  }
  const FOLLOW_UPS = {
    rows: ["how many is that", "sort them by the newest first", "just the top 10"],
    count: ["show them", "break that down by month", "what about last month"],
    aggregate: ["break that down by month", "show them", "what about last year"],
    breakdown: ["just the top 5", "what about last year", "show them"],
    share: ["show them", "what about last month", "break that down by month"],
  };

  function renderChips() {
    const asked = new Set(thread.map((t) => t.request.toLowerCase()));
    const last = thread.at(-1)?.data;
    const hasTime = last?.editor?.columns.some((c) => c.kind === "time");
    const followUps = last?.ok && last.kind === "data" && !last.error
      ? FOLLOW_UPS[last.plan.intent].filter((q) => hasTime || !/month|year/.test(q)).slice(0, 2) : [];
    chips.replaceChildren(
      ...followUps.map((q) => h("button.follow", { type: "button", title: "Continues from the last answer", onclick: () => submit(q) }, "↳ " + q)),
      ...suggested.filter((q) => !asked.has(q.toLowerCase())).slice(0, 8).map((q) => h("button", { type: "button", onclick: () => submit(q) }, q)));
    input.placeholder = followUps.length ? "Ask a follow-up, or something new…" : `Ask about ${c.database}…`;
  }

  function renderTurn(turn) {
    const body = h("div.msg-body");
    const paint = () => body.replaceChildren(answerView(turn, {
      rerender: () => { paint(); persist(); },
      reask: async (table, { standalone = false } = {}) => {
        turn.data = null; paint();
        if (standalone) turn.standalone = true;
        const context = turn.standalone || table ? undefined : contextBefore(turn);
        try { turn.data = await api("/nl/ask", { request: turn.request, mainOverride: table ?? undefined, context }); } catch (err) { turn.error = err; }
        paint();
        persist();
        renderChips();
      },
    }));
    paint();
    turn.paint = paint;
    return [h("div.msg.user", h("div.bubble", turn.request)), h("div.msg.bot", h("div.avatar", zynnMark(14)), body)];
  }

  function renderThread() {
    if (!thread.length) {
      list.replaceChildren(h("div.chat-empty", h("div.avatar.big", zynnMark(22)),
        h("h1", `Ask about ${c.database}`),
        h("p", "Ask in plain English. Jev reads the question, the query is composed in code, and it runs read-only. Every answer shows how it was read, so you can check or correct it.")));
    } else list.replaceChildren(...thread.flatMap(renderTurn));
    clear.hidden = !thread.length;
    renderChips();
  }

  async function submit(text) {
    const request = (text ?? input.value).trim();
    if (!request || busy || !status.jev) return;
    busy = true;
    input.value = ""; autosize(); sync();
    const turn = { request, data: null, error: null };
    thread.push(turn);
    if (thread.length === 1) list.replaceChildren();
    list.append(...renderTurn(turn));
    clear.hidden = false;
    renderChips();
    toBottom();
    try { turn.data = await api("/nl/ask", { request, context: contextBefore(turn) }); } catch (err) { turn.error = err; }
    busy = false;
    persist();
    renderChips();
    turn.paint();
    sync();
    toBottom();
    if (matchMedia("(min-width: 821px)").matches) input.focus();
  }

  input.addEventListener("input", () => { autosize(); sync(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  const clear = h("button.btn.small", { type: "button", hidden: true, onclick: () => { thread.length = 0; persist(); renderThread(); input.focus(); } }, "New chat");

  renderThread();
  api("/nl/suggestions").then((list) => { suggested = list; renderChips(); }).catch(() => {});
  if (params.get("q")) { history.replaceState(null, "", "#/ask"); submit(params.get("q")); }
  else toBottom();

  return h("div.chat",
    h("div.chat-head", h("h1", "Ask"), h("span.sub", c.database), h("span.spacer"), clear),
    scroller,
    h("div.chat-dock",
      !status.jev && h("div.note", "TYPESAFE_API_KEY is not set on the server, so questions cannot be answered yet. Add it to .env and restart."),
      chips,
      h("form.composer", { onsubmit: (e) => { e.preventDefault(); submit(); } }, input, send),
      h("div.composer-hint", "Enter to send · Shift+Enter for a new line · queries run read-only")));
}
