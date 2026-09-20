import { h, api, enc, fmtNum, fmtTime, codeBlock, errorBox, loading, zynnMark, lineIcon, confirmDialog, promptDialog, download } from "./ui.js";
import { store, pct, SEND_ICON, judgmentCard } from "./chat.js";
import { erdDiagram } from "./erd.js";

// Create: describe a database in plain English, review the draft, apply it as one transaction.
// The page holds only a list of ops. The server replays them on the live schema for every view,
// so what is shown (diagram, SQL, warnings) is always what Apply would run.

const DRAFT_KEY = (key) => `zynn.create:${key}`;
const MAX_TURNS = 30;
const LEVEL_BADGE = { caution: ".warn", destructive: ".bad" };
const plural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;
const typeText = (t) => (t?.enum ? t.enum.replace(/^public\./, "") : t?.args?.length ? `${t.base}(${t.args.join(",")})` : t?.base ?? "?");

export function createPage(params, status, { onSchemaChanged, onDatabaseCreated }) {
  const c = status.connection;
  const key = `${c.host}:${c.port}/${c.database}`;
  const saved = store.get(DRAFT_KEY(key), {});
  let ops = Array.isArray(saved.ops) ? saved.ops : [];
  const turns = Array.isArray(saved.turns) ? saved.turns.filter((t) => t && (typeof t.request === "string" || typeof t.note === "string")) : [];
  let draft = null;
  let tab = "diagram";
  let busy = false;
  let starters = [];
  let applyResult = null;

  const persist = () => store.set(DRAFT_KEY(key), { ops, turns: turns.slice(-MAX_TURNS).map((t) => ({ request: t.request, data: t.data && { ...t.data, draft: undefined }, note: t.note })) });

  // ---------------------------------------------------------------- draft
  const side = h("div.creator-side");
  async function refresh(nextOps = ops, { quiet = false } = {}) {
    try {
      draft = await api("/create/draft/compile", { ops: nextOps });
      ops = draft.ops;
      persist();
    } catch (err) {
      if (!quiet) side.replaceChildren(errorBox(err));
      return;
    }
    paintSide();
    renderChips();
  }
  const setOps = (next) => { applyResult = null; return refresh(next); };
  const removeOp = (id) => setOps(ops.filter((o) => o.id !== id));
  const patchOp = (id, mutate) => setOps(ops.map((o) => { if (o.id !== id) return o; const copy = structuredClone(o); mutate(copy); return copy; }));

  // ---------------------------------------------------------------- right-hand side
  function diagramTab() {
    const tables = draft.erd.tables;
    if (!tables.length) {
      return h("div.panel.empty.creator-blank", h("strong", "Nothing here yet"),
        h("p", status.jev ? "Describe what you want to store, or pick a starting point below the chat." : "Natural language is off (no TYPESAFE_API_KEY), but the advisor, sample data and Apply still work on an existing schema."));
    }
    const legend = ["added", "changed", "dropped"].filter((s) => tables.some((t) => t.state === s || t.columns.some((col) => col.state === s)));
    return h("div", legend.length ? h("div.erd-legend", legend.map((s) => h(`span.${s}`, s === "added" ? "new" : s))) : null,
      h("div.erd-wrap.creator-erd", erdDiagram(draft.erd, { onClick: (t) => { if (t.state !== "added") location.hash = `#/rel/${enc(t.schema)}/${enc(t.name)}`; } })));
  }

  function columnEditor(op) {
    return h("div.op-columns", op.columns.map((col, i) => h("div.op-column",
      h("span.mono.name", col.name),
      col.ref ? h("span.mono.muted", `→ ${col.ref.table.replace(/^public\./, "")}`)
        : h("select.input.small", { "aria-label": `Type of ${col.name}`, onchange: (e) => patchOp(op.id, (o) => { o.columns[i].type = e.target.value.startsWith("enum:") ? { enum: e.target.value.slice(5) } : { base: e.target.value }; delete o.columns[i].check; delete o.columns[i].default; }) },
          !draft.types.includes(col.type.base) || col.type.args ? h("option", { selected: true, value: col.type.enum ? `enum:${col.type.enum}` : col.type.base }, typeText(col.type)) : null,
          draft.types.filter((t) => t !== "varchar").map((t) => h("option", { value: t, selected: !col.type.args && col.type.base === t }, t)),
          draft.enums.filter((e) => e !== col.type.enum).map((e) => h("option", { value: `enum:${e}` }, e.replace(/^public\./, "")))),
      h("label.check.small", h("input", { type: "checkbox", checked: col.nullable === false, onchange: (e) => patchOp(op.id, (o) => { o.columns[i].nullable = !e.target.checked; }) }), "required"),
      h("label.check.small", h("input", { type: "checkbox", checked: Boolean(col.unique), onchange: (e) => patchOp(op.id, (o) => { o.columns[i].unique = e.target.checked; }) }), "unique"),
      h("button.icon-btn", { title: `Remove ${col.name}`, "aria-label": `Remove ${col.name}`, onclick: () => patchOp(op.id, (o) => o.columns.splice(i, 1)) }, "✕"))));
  }

  function changesTab() {
    const byOp = new Map();
    for (const s of draft.statements) (byOp.get(s.opId) ?? byOp.set(s.opId, []).get(s.opId)).push(s);
    const cards = draft.ops.map((op) => {
      const statements = byOp.get(op.id) ?? [];
      const level = statements.some((s) => s.level === "destructive") ? "destructive" : statements.some((s) => s.level === "caution") ? "caution" : "safe";
      const decisions = draft.decisions.find((d) => d.opId === op.id);
      return h(`div.op-card.${level}`,
        h("div.op-head", h("span.op-label", op.label), level !== "safe" && h(`span.badge${LEVEL_BADGE[level]}`, level),
          h("button.icon-btn", { title: "Remove from draft", "aria-label": `Remove: ${op.label}`, onclick: () => removeOp(op.id) }, "✕")),
        statements.filter((s) => s.reason).map((s) => h("p.op-reason", s.reason)),
        op.kind === "create_table" && columnEditor(op),
        decisions && h("div.op-decisions", decisions.items.map((d) =>
          h("label.check.small", { title: d.why }, h("input", { type: "checkbox", checked: d.value, onchange: (e) => patchOp(op.id, (o) => { o.conventions[d.key] = e.target.checked; }) }), d.label))));
    });
    const broken = draft.broken.map((b) => h("div.op-card.broken", h("div.op-head", h("span.op-label", `Skipped: ${b.kind.replace(/_/g, " ")}`), h("span.badge.bad", "does not fit"),
      h("button.icon-btn", { title: "Dismiss", "aria-label": "Dismiss", onclick: () => setOps(ops) }, "✕")), h("p.op-reason", `${b.reason}. It has been left out of the draft.`)));
    return h("div",
      h("div.toolbar", { style: "margin-bottom:10px" },
        h("span.info", draft.ops.length ? `${plural(draft.ops.length, "change")} · ${plural(draft.statements.length, "statement")}` : "No staged changes"),
        h("span.spacer"),
        draft.erd.tables.some((t) => t.state !== "dropped") && h("button.btn.small", { onclick: addSampleData }, "Add sample data…")),
      draft.notes.map((n) => h("div.note", n)),
      cards.length || broken.length ? h("div.op-list", cards, broken) : h("div.panel.empty", "Changes you stage appear here, in the order they will run. Each can be edited or removed before anything is applied."));
  }

  function sqlTab() {
    if (!draft.sql) return h("div.panel.empty", "The migration appears here once there are staged changes.");
    return h("div", h("div.toolbar", { style: "margin-bottom:8px" }, h("span.info", "Runs as one transaction: all of it, or none"), h("span.spacer"),
      h("button.btn.small", { onclick: (e) => { navigator.clipboard.writeText(draft.sql); e.target.textContent = "Copied"; } }, "Copy"),
      h("a.btn.small", { href: `#/sql?q=${enc(draft.sql)}` }, "Open in SQL editor")), codeBlock(draft.sql));
  }

  function advisorTab() {
    if (!draft.findings.length) return h("div.panel.empty", draft.erd.tables.length ? "No findings. Keys, indexes, types and naming all look sound." : "The advisor reviews the schema once there are tables.");
    const sev = { high: ".bad", medium: ".warn", low: "" };
    return h("div.op-list", draft.findings.map((f) => h("div.op-card",
      h("div.op-head", h("span.op-label", f.title), h(`span.badge${sev[f.severity]}`, f.severity)),
      h("p.op-reason", f.why),
      f.ops.length ? h("div.toolbar", h("button.btn.small", { onclick: () => setOps([...ops, ...f.ops]).then(() => { tab = "advisor"; paintSide(); }) }, "Add fix to draft")) : h("p.op-reason.muted", "Advice only: this one needs a manual migration."))));
  }

  // The schema and its migrations as files, so the design can leave this machine.
  async function exportFiles(which, button) {
    const label = button.textContent;
    button.disabled = true;
    try {
      const x = await api("/create/export");
      if (which === "schema") download(x.schema.name, x.schema.content, "application/sql");
      else if (x.archive) download(x.archive.name, Uint8Array.from(atob(x.archive.base64), (ch) => ch.charCodeAt(0)), "application/x-tar");
      button.textContent = which === "schema" ? "Saved" : x.archive ? `Saved ${plural(x.migrations.length, "file")}` : "Nothing applied yet";
    } catch (err) { button.textContent = "Failed"; side.prepend(errorBox(err)); }
    setTimeout(() => { button.textContent = label; button.disabled = false; }, 1800);
  }
  const exportBar = () => h("div.toolbar", { style: "margin-bottom:10px" },
    h("span.info", "Take the design elsewhere"), h("span.spacer"),
    h("button.btn.small", { title: "The whole schema as it stands now, runnable on an empty database", onclick: (e) => exportFiles("schema", e.target) }, "Download schema.sql"),
    h("button.btn.small", { title: "One numbered .sql file per migration applied from this page, as a .tar", onclick: (e) => exportFiles("migrations", e.target) }, "Download migrations"));

  function historyTab() {
    const box = h("div", loading());
    api("/create/history").then((entries) => {
      box.replaceChildren(entries.length ? h("div.op-list", entries.map((e) => h("div.op-card",
        h("div.op-head", h("span.op-label", e.summary), h("span.muted.small", fmtTime(e.at))),
        h("details.drawer", h("summary", "SQL", h("span.hint", plural(e.statements, "statement"))), codeBlock(e.sql)),
        e.undoable
          ? h("div.toolbar", h("button.btn.small", { onclick: async () => { const r = await api("/create/undo", { id: e.id }); tab = "changes"; setOps([...ops, ...r.ops]); } }, "Stage the undo"))
          : e.reason && h("p.op-reason.muted", `Cannot be undone here: ${e.reason.charAt(0).toLowerCase()}${e.reason.slice(1)}.`))))
        : h("div.panel.empty", "Migrations applied from this page are listed here, kept in a local file on this machine."));
    }).catch((err) => box.replaceChildren(errorBox(err)));
    return h("div", exportBar(), box);
  }

  async function addSampleData() {
    const rows = await promptDialog({ title: "Sample data", label: "Rows per table", placeholder: "25", confirmLabel: "Stage it", body: "Fills every table, parents first, so each reference points at a real row. Staged like any other change; nothing is inserted until you apply." });
    if (!rows) return;
    applyResult = null;
    try { draft = await api("/create/seed", { ops, rows: Number(rows) || 25 }); ops = draft.ops; persist(); tab = "changes"; paintSide(); } catch (err) { side.prepend(errorBox(err)); }
  }

  async function apply() {
    if (busy || !draft?.statements.length) return;
    busy = true; applyResult = { pending: "Checking the migration against the database…" }; paintSide();
    try {
      const check = await api("/create/apply", { ops, fingerprint: draft.fingerprint, dryRun: true });
      if (!check.ok) { applyResult = check; return; }
      applyResult = null; paintSide();
      const n = draft.statements.length;
      const confirmed = draft.confirmPhrase
        ? await confirmDialog({ title: "Apply destructive changes", danger: true, confirmLabel: "Apply", requireText: draft.confirmPhrase,
          body: h("div", h("p", `This migration deletes data from ${draft.database} and cannot be undone:`),
            h("ul.dialog-list", draft.statements.filter((s) => s.level === "destructive").map((s) => h("li", s.reason))), h("p", `A trial run of all ${plural(n, "statement")} succeeded and was rolled back.`)) })
        : await confirmDialog({ title: `Apply to ${draft.database}`, confirmLabel: "Apply", body: `${plural(n, "statement")} will run as one transaction. A trial run succeeded and was rolled back.` });
      if (!confirmed) return;
      applyResult = { pending: "Applying…" }; paintSide();
      const result = await api("/create/apply", { ops, fingerprint: draft.fingerprint, confirm: draft.confirmPhrase ?? undefined });
      applyResult = result;
      if (result.ok) {
        turns.push({ request: null, note: `Applied ${plural(n, "statement")} to ${draft.database} in ${result.ms} ms.` });
        renderThread();
        ops = [];
        await onSchemaChanged();
        await refresh([]);
      }
    } catch (err) {
      applyResult = { ok: false, failed: { error: err.message } };
      if (err.error && /changed since/.test(err.error)) await refresh(ops, { quiet: true });
    } finally {
      busy = false;
      paintSide();
    }
  }

  function applyBar() {
    const n = draft.statements.length;
    const result = applyResult && (applyResult.pending ? h("div.apply-result", loading(applyResult.pending))
      : applyResult.ok ? h("div.apply-result.ok", `Applied. ${plural(applyResult.results.length, "statement")} in ${applyResult.ms} ms.`)
      : h("div.apply-result.failed",
        h("strong", applyResult.dryRun ? "The trial run failed, so nothing was applied." : "The migration failed and was rolled back. The database is unchanged."),
        h("div.error", applyResult.failed.error + (applyResult.failed.detail ? `\n${applyResult.failed.detail}` : "") + (applyResult.failed.hint ? `\nHint: ${applyResult.failed.hint}` : "")),
        applyResult.failed.sql && h("details.drawer", h("summary", `Statement ${applyResult.failed.index + 1} of ${n}`), codeBlock(applyResult.failed.sql))));
    return h("div.apply-bar", result,
      h("div.apply-row",
        h("span.apply-count", n ? plural(n, "statement") : "Nothing to apply"),
        draft.level !== "safe" && n ? h(`span.badge${LEVEL_BADGE[draft.level]}`, draft.level === "destructive" ? "deletes data" : "check the warnings") : null,
        draft.broken.length ? h("span.badge.bad", `${draft.broken.length} skipped`) : null,
        h("span.spacer"),
        h("button.btn", { disabled: !ops.length && !draft.broken.length, onclick: async () => { if (await confirmDialog({ title: "Discard the draft", confirmLabel: "Discard", danger: true, body: "Every staged change is removed. The database is not affected." })) setOps([]); } }, "Discard"),
        h("button.btn.primary", { disabled: !n || busy || draft.broken.length > 0, title: draft.broken.length ? "Remove the skipped changes first" : "", onclick: apply }, "Apply…")));
  }

  function paintSide() {
    if (!draft) return side.replaceChildren(loading());
    const defs = [
      ["diagram", "Diagram", null, diagramTab], ["changes", "Changes", draft.ops.length + draft.broken.length, changesTab], ["sql", "SQL", null, sqlTab],
      ["advisor", "Advisor", draft.findings.length, advisorTab], ["history", "History", null, historyTab],
    ];
    const bar = h("div.tabs", defs.map(([id, label, count]) => h("button", { class: id === tab ? "active" : "", onclick: () => { tab = id; paintSide(); } }, label, count ? h("span.n", count) : null)));
    side.replaceChildren(bar, h("div.creator-body", defs.find(([id]) => id === tab)[3]()), applyBar());
  }

  // ---------------------------------------------------------------- chat
  const list = h("div.chat-thread");
  const scroller = h("div.chat-scroll", list);
  const chips = h("div.suggestions", { "aria-label": "Suggestions" });
  const input = h("textarea.composer-input", { rows: 1, maxLength: 900, placeholder: "Describe what to build or change…", "aria-label": "Your request", disabled: !status.jev });
  const send = h("button.send", { type: "submit", title: "Send", "aria-label": "Send", disabled: true }, lineIcon(SEND_ICON, 18));
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; };
  const sync = () => { send.disabled = busy || !input.value.trim() || !status.jev; };
  const toBottom = () => requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });

  function replyView(turn) {
    const d = turn.data;
    if (turn.error) return h("div.answer", errorBox(turn.error));
    if (!d) return h("div.answer.thinking", h("span.dots", h("i"), h("i"), h("i")), "Reading your request");
    const parts = [h("p.say", d.reply?.text)];
    // Several changes in one message: one line each, so a part that was not understood is as visible as the rest.
    if (d.reply?.parts?.length) {
      parts.push(h("ol.change-list", d.reply.parts.map((p) => h(`li${p.ok ? "" : ".failed"}`,
        h("span.change-said", p.request), h("span.change-result", p.text), (p.notes ?? []).map((n) => h("span.change-note", n))))));
    }
    for (const n of d.reply?.notes ?? []) parts.push(h("div.note", n));
    if (d.clarify?.length) parts.push(h("div.chips", d.clarify.map((q) => h("button.chip-btn", { type: "button", onclick: () => { input.value = q; autosize(); sync(); input.focus(); } }, q))));
    if (d.askInstead) parts.push(h("div.toolbar", h("a.btn.small", { href: `#/ask?q=${enc(d.askInstead)}` }, "Ask this instead")));
    if (d.pendingDatabase && !turn.done) {
      parts.push(h("div.toolbar", h("button.btn.primary.small", { onclick: async (e) => {
        e.target.disabled = true;
        try { await api("/create/database", { name: d.pendingDatabase.name }); turn.done = true; persist(); await onDatabaseCreated(d.pendingDatabase.name); } catch (err) { e.target.disabled = false; e.target.closest(".answer").append(errorBox(err)); }
      } }, `Create and open "${d.pendingDatabase.name}"`)));
    }
    const open = (d.suggestions ?? []).filter((s) => !s.used);
    if (open.length) {
      parts.push(h("div.suggest-list", h("span.muted.small", d.ok ? "Less sure, not staged:" : "My best guesses:"), open.map((s) => h("button.btn.small", { type: "button", onclick: () => {
        s.used = true; persist(); turn.paint();
        if (s.ops) { tab = "changes"; setOps([...ops, ...s.ops]); } else submit(s.say);
      } }, s.ops ? `+ ${s.label}` : s.label))));
    }
    const weakest = d.judgments?.filter((j) => j.applied && !j.rule).reduce((m, j) => Math.min(m, j.p), 1);
    const drawers = d.judgments?.length ? h("div.drawers", h("details.drawer", h("summary", "How I read it", h("span.hint", `${plural(d.judgments.length, "judgment")}${weakest < 1 ? ` · weakest ${pct(weakest)}` : ""}`)),
      h("div.judgments", d.judgments.map((j) => judgmentCard(j))),
      d.usage && h("div.meta-line", `${d.model ?? "jev"} · ${plural(d.usage.requests, "request")} · ${fmtNum(d.usage.input_tokens)} tokens · ${d.ms} ms`))) : null;
    return h("div.answer", parts, drawers);
  }

  function renderTurn(turn) {
    if (turn.note) return [h("div.msg.bot", h("div.avatar", zynnMark(14)), h("div.msg-body", h("div.answer", h("p.say.applied", turn.note))))];
    const body = h("div.msg-body");
    turn.paint = () => body.replaceChildren(replyView(turn));
    turn.paint();
    return [h("div.msg.user", h("div.bubble", turn.request)), h("div.msg.bot", h("div.avatar", zynnMark(14)), body)];
  }

  function renderThread() {
    if (!turns.length) {
      list.replaceChildren(h("div.chat-empty", h("div.avatar.big", zynnMark(22)), h("h1", `Build ${c.database}`),
        h("p", "Say what you need in plain English. Jev reads the request, the design decisions and the SQL come from code, and nothing touches the database until you press Apply.")));
    } else list.replaceChildren(...turns.flatMap(renderTurn));
    clear.hidden = !turns.length;
  }

  function renderChips() {
    const asked = new Set(turns.map((t) => t.request?.toLowerCase()));
    let options = [];
    if (draft && !draft.erd.tables.length) options = starters.map((s) => s.say);
    else if (draft) {
      const live = draft.erd.tables.filter((t) => t.state !== "dropped");
      const first = live.find((t) => !/_/.test(t.name)) ?? live[0];
      options = [
        first && `add a phone number and notes to ${first.name}`,
        "create a table called invoices with number, amount, due date and status (draft, sent, paid)",
        live.length > 0 && "fill every table with 25 sample rows",
        "create a read-only role called analyst",
        draft.findings.length > 0 && "review my schema",
        ...starters.slice(0, 2).map((s) => s.say),
      ].filter(Boolean);
    }
    chips.replaceChildren(...options.filter((q) => !asked.has(q.toLowerCase())).slice(0, 8).map((q) => h("button", { type: "button", onclick: () => submit(q) }, q)));
  }

  async function submit(text) {
    const request = (text ?? input.value).trim();
    if (!request || busy || !status.jev) return;
    busy = true; applyResult = null;
    input.value = ""; autosize(); sync();
    const turn = { request, data: null, error: null };
    turns.push(turn);
    if (turns.length === 1) list.replaceChildren();
    list.append(...renderTurn(turn));
    clear.hidden = false;
    toBottom();
    try {
      const data = await api("/create/interpret", { request, ops });
      turn.data = data;
      draft = data.draft;
      ops = draft.ops;
      if (data.focus) tab = data.focus;
      else if (data.added?.length && tab !== "diagram" && tab !== "sql") tab = "changes";
    } catch (err) { turn.error = err; }
    busy = false;
    persist();
    turn.paint();
    paintSide();
    renderChips();
    sync();
    toBottom();
    if (matchMedia("(min-width: 821px)").matches) input.focus();
  }

  input.addEventListener("input", () => { autosize(); sync(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  const clear = h("button.btn.small", { type: "button", hidden: true, onclick: () => { turns.length = 0; persist(); renderThread(); renderChips(); input.focus(); } }, "Clear chat");
  const newDb = h("button.btn.small", { type: "button", onclick: async () => {
    const name = await promptDialog({ title: "New database", label: "Name", placeholder: "my_app", confirmLabel: "Create and open", body: "Created on this server with your current role, then opened. Use lowercase letters, digits and underscores." });
    if (!name) return;
    try { await api("/create/database", { name }); await onDatabaseCreated(name); } catch (err) { list.append(errorBox(err)); toBottom(); }
  } }, "New database");

  renderThread();
  paintSide();
  refresh();
  api("/create/starters").then((s) => { starters = s; renderChips(); }).catch(() => {});
  if (params.get("q")) { history.replaceState(null, "", "#/create"); submit(params.get("q")); } else toBottom();

  return h("div.creator",
    h("div.chat.creator-chat",
      h("div.chat-head", h("h1", "Create"), h("span.sub", c.database), h("span.spacer"), clear, newDb),
      scroller,
      h("div.chat-dock",
        !status.jev && h("div.note", "TYPESAFE_API_KEY is not set on the server, so requests in plain English are off. Add it to .env and restart."),
        chips,
        h("form.composer", { onsubmit: (e) => { e.preventDefault(); submit(); } }, input, send),
        h("div.composer-hint", "Enter to send · changes are staged, never applied, until you press Apply"))),
    side);
}
