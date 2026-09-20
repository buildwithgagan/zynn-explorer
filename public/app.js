import { h, api, enc, fmtCompact, mount, errorBox, svg, zynnMark } from "./ui.js";
import * as pages from "./pages.js";
import { sqlPage, askPage } from "./query.js";
import { createPage } from "./create.js";

const root = document.getElementById("app");
let status = null;
let tree = null;

const PRODUCT = "Explorer"; // shown beside the Zynn wordmark; the ecosystem name comes first

const lockup = (href) => h(href ? "a.lockup" : "div.lockup", href ? { href } : {}, zynnMark(), h("span.wordmark", "Zynn"), h("span.product", PRODUCT));

// 16px line icons, drawn on a 24 grid with a 1.75 stroke to sit beside the Console's icon set.
const ICONS = {
  overview: ["M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"],
  ask: ["M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12z", "M9.5 10a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5", "M12 16.5v.01"],
  create: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 15v4M17 17h4"],
  sql: ["M5 7l5 5-5 5", "M13 17h6"],
  relationships: ["M4 4h6v6H4zM14 14h6v6h-6z", "M10 7h4a3 3 0 0 1 3 3v4"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  roles: ["M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20", "M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M21 20v-1.5a4 4 0 0 0-3-3.85", "M16 3.65a3.5 3.5 0 0 1 0 6.7"],
  settings: ["M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12", "M16 4v4M10 10v4M18 16v4"],
  databases: ["M4 6c0-1.65 3.6-3 8-3s8 1.35 8 3-3.6 3-8 3-8-1.35-8-3z", "M4 6v6c0 1.65 3.6 3 8 3s8-1.35 8-3V6", "M4 12v6c0 1.65 3.6 3 8 3s8-1.35 8-3v-6"],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
  moon: ["M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"],
  reload: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  power: ["M12 3v9", "M6.3 6.3a8 8 0 1 0 11.4 0"],
};
const icon = (name, size = 16) => svg("0 0 24 24", size, ICONS[name].map((d) => ["path", { d }]),
  { fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round" });

const NAV = [
  { label: "Work", items: [["overview", "Overview"], ["ask", "Ask"], ["create", "Create"], ["sql", "SQL"], ["relationships", "Relationships"]] },
  { label: "Server", items: [["activity", "Activity"], ["roles", "Roles"], ["settings", "Settings"], ["databases", "Databases"]] },
];
const PAGE_TITLES = { rel: "Objects", fn: "Objects", sequences: "Objects", types: "Objects" };

// ---------------------------------------------------------------- theme
const THEME_KEY = "zynn.theme"; // same key and rule as the Zynn Console
const isLight = () => document.documentElement.classList.contains("light");
function themeToggle(extraClass = "") {
  const button = h(`button.side-btn${extraClass}`, { type: "button" });
  const paint = () => {
    button.replaceChildren(icon(isLight() ? "moon" : "sun", 14), h("span", isLight() ? "Dark mode" : "Light mode"));
    button.setAttribute("aria-label", isLight() ? "Switch to dark mode" : "Switch to light mode");
  };
  button.addEventListener("click", () => {
    const light = !isLight();
    document.documentElement.classList.toggle("light", light);
    document.documentElement.setAttribute("data-appearance", light ? "light" : "dark");
    try { localStorage.setItem(THEME_KEY, light ? "light" : "dark"); } catch { /* private mode */ }
    paint();
  });
  paint();
  return button;
}

// ---------------------------------------------------------------- connect
const RECENT_KEY = "pgx.recent";
const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? []; } catch { return []; } };
// Passwords are never stored: a recent connection only pre-fills the other fields.
function rememberConnection(c) {
  const entry = { host: c.host, port: c.port, database: c.database, user: c.user, ssl: c.ssl };
  const same = (a) => a.host === entry.host && a.port === entry.port && a.database === entry.database && a.user === entry.user;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...readRecent().filter((a) => !same(a))].slice(0, 5))); } catch { /* private mode */ }
}

function explainConnectError(err) {
  const m = err.message ?? "";
  if (/ECONNREFUSED/.test(m)) return "Nothing is accepting connections at that host and port. Check that Postgres is running and the port is right (Docker containers often map to a port other than 5432).";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "That host name could not be resolved.";
  if (/password authentication failed/.test(m)) return "The server rejected that user and password.";
  if (/no password supplied|SASL/.test(m)) return "This server requires a password.";
  if (/does not exist/.test(m)) return m.charAt(0).toUpperCase() + m.slice(1) + ".";
  if (/timeout|ETIMEDOUT/i.test(m)) return "The connection timed out. The host may be unreachable or blocked by a firewall.";
  if (/SSL|TLS/.test(m)) return `${m}. Try toggling "Require SSL".`;
  return m;
}

async function connectScreen(message) {
  const savedList = await api("/saved").catch(() => []);
  let mode = "details";
  const field = (label, input, cls = "") => h(`label.field${cls}`, h("span", label), input);
  const host = h("input.input", { name: "host", value: "localhost", autocomplete: "off", autocapitalize: "none", spellcheck: false, required: true });
  const port = h("input.input", { name: "port", value: "5432", inputMode: "numeric", pattern: "[0-9]*", autocomplete: "off", required: true });
  const database = h("input.input", { name: "database", placeholder: "postgres", autocomplete: "off", autocapitalize: "none", spellcheck: false });
  const user = h("input.input", { name: "user", value: "postgres", autocomplete: "username", autocapitalize: "none", spellcheck: false, required: true });
  const password = h("input.input", { name: "password", type: "password", autocomplete: "current-password", placeholder: "leave empty if none" });
  const url = h("input.input.mono", { name: "url", type: "password", placeholder: "postgres://user:password@host:5432/database", autocomplete: "off", autocapitalize: "none", spellcheck: false });
  const showUrl = h("input", { type: "checkbox", onchange: (e) => (url.type = e.target.checked ? "text" : "password") });
  const ssl = h("input", { type: "checkbox" });
  const saveBox = h("input", { type: "checkbox", onchange: () => { saveName.hidden = !saveBox.checked; if (saveBox.checked) saveName.focus(); } });
  const saveName = h("input.input", { hidden: true, placeholder: "Name for this connection", maxLength: 60, autocomplete: "off" });
  const feedback = h("div");
  const button = h("button.btn.primary.wide", { type: "submit" }, "Connect");

  const details = h("div.fields",
    field("Host", host, ".grow"), field("Port", port, ".narrow"),
    field("Database", database, ".half"), field("User", user, ".half"),
    field("Password", password, ".full"));
  const urlPane = h("div.fields", { hidden: true }, field("Connection URL", url, ".full"), h("label.check.full", showUrl, "Show URL"));
  const modeTabs = h("div.segmented",
    h("button", { type: "button", class: "active", onclick: () => setMode("details") }, "Details"),
    h("button", { type: "button", onclick: () => setMode("url") }, "Connection URL"));
  function setMode(next) {
    mode = next;
    details.hidden = mode !== "details";
    urlPane.hidden = mode !== "url";
    [...modeTabs.children].forEach((b, i) => b.classList.toggle("active", (i === 0) === (mode === "details")));
    for (const el of [host, port, user]) el.required = mode === "details";
    url.required = mode === "url";
    (mode === "details" ? host : url).focus();
  }

  async function connect(body) {
    button.disabled = true;
    button.textContent = "Connecting…";
    feedback.replaceChildren();
    try {
      rememberConnection(await api("/connect", body));
      location.hash = "#/overview";
      await start();
    } catch (err) {
      feedback.replaceChildren(h("div.error", explainConnectError(err)));
    } finally {
      button.disabled = false;
      button.textContent = "Connect";
    }
  }

  const recent = readRecent();
  root.replaceChildren(h("div.connect", themeToggle(".theme-corner"), h("div.connect-card",
    lockup(),
    h("p", "Enter your Postgres connection details to open the Explorer: browse every object, run SQL, and ask questions in plain English."),
    savedList.length ? h("div.saved", h("h2", "Saved connections"), savedList.map((c) =>
      h("div.saved-row",
        h("button.recent-item", {
          type: "button", title: c.needsPassword ? "Enter the password once to finish saving" : "Connect",
          onclick: () => {
            if (!c.needsPassword) return connect({ saved: c.name });
            // First use: fill everything but the password, and save it once it works.
            setMode("details");
            host.value = c.host; port.value = c.port; database.value = c.database; user.value = c.user; ssl.checked = c.ssl;
            saveBox.checked = true; saveName.hidden = false; saveName.value = c.name;
            password.value = ""; password.focus();
            feedback.replaceChildren(h("div.note", `Enter the password for ${c.user} once. It will be saved on this machine for next time.`));
          },
        }, h("span", h("strong.name", c.name), h("small.mono", `${c.user}@${c.host}:${c.port}/${c.database}`)),
          h("em", c.needsPassword ? "needs password" : "connect →")),
        h("button.btn.ghost.small", { type: "button", title: "Forget this connection", "aria-label": `Forget ${c.name}`,
          onclick: async () => { if (confirm(`Forget "${c.name}"?`)) { await api(`/saved/${enc(c.name)}`, undefined, "DELETE"); connectScreen(); } } }, "✕")))) : null,
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        if (saveBox.checked && !saveName.value.trim()) { saveName.focus(); return feedback.replaceChildren(h("div.error", "Give the connection a name to save it.")); }
        const saveAs = saveBox.checked ? saveName.value.trim() : undefined;
        connect(mode === "url"
          ? { connectionString: url.value.trim(), ssl: ssl.checked, saveAs }
          : { host: host.value.trim(), port: Number(port.value), database: database.value.trim(), user: user.value.trim(), password: password.value, ssl: ssl.checked, saveAs });
      },
    },
      modeTabs, details, urlPane,
      h("label.check", ssl, "Require SSL (managed and cloud databases)"),
      h("label.check", saveBox, "Save this connection on this machine"), saveName,
      message && h("div.note", message), feedback, button,
      status?.defaultUrl && h("button.btn.wide", { type: "button", onclick: () => connect({ useDefault: true }) }, "Use DATABASE_URL from .env")),
    recent.length ? h("div.recent", h("h2", "Recent"), recent.map((r) =>
      h("button.recent-item", {
        type: "button", title: "Fill in these details",
        onclick: () => { setMode("details"); host.value = r.host; port.value = r.port; database.value = r.database; user.value = r.user; ssl.checked = Boolean(r.ssl); password.value = ""; password.focus(); },
      }, h("span.mono", `${r.user}@${r.host}:${r.port}`), h("strong.mono", r.database)))) : null,
    h("p.fine", "Credentials go only to the local server on this machine. A password is stored only if you tick Save, in a git-ignored file readable by you alone; it is never sent back to the browser."))));
  if (matchMedia("(min-width: 700px)").matches) host.select();
}

// ---------------------------------------------------------------- sidebar
const GROUPS = [
  { label: "Tables", pick: (t, s) => t.relations.filter((r) => r.schema === s && (r.kind === "r" || r.kind === "p" || r.kind === "f")) },
  { label: "Views", pick: (t, s) => t.relations.filter((r) => r.schema === s && (r.kind === "v" || r.kind === "m")) },
  { label: "Functions", pick: (t, s) => t.functions.filter((f) => f.schema === s) },
];

function sidebar() {
  const list = h("div.tree");
  const search = h("input.input.side-search", { placeholder: "Search tables, columns…", type: "search", "aria-label": "Search objects" });
  const navLinks = [];
  let timer;

  function renderTree() {
    const active = decodeURIComponent(location.hash);
    list.replaceChildren(...tree.schemas.map((s) => {
      const groups = GROUPS.map((g) => ({ ...g, items: g.pick(tree, s.name) })).filter((g) => g.items.length);
      const open = groups.length > 0 && (tree.schemas.length <= 3 || s.name === "public" || active.includes(`/${s.name}/`));
      return h("details.schema", { open }, h("summary", s.name, h("span.count", groups.reduce((n, g) => n + g.items.length, 0))),
        groups.map((g) => h("details.group", { open: g.label !== "Functions" || g.items.length <= 12 }, h("summary", g.label, h("span.count", g.items.length)),
          g.items.map((item) => {
            const isFn = g.label === "Functions";
            const href = isFn ? `#/fn/${item.oid}` : `#/rel/${enc(item.schema)}/${enc(item.name)}`;
            return h("a.item", { href, class: decodeURIComponent(href) === active ? "active" : "", title: item.comment ?? (isFn ? `${item.name}(${item.args})` : item.name) },
              h(`span.glyph.${isFn ? "fn" : item.kind}`, isFn ? "ƒ" : { r: "T", p: "P", v: "V", m: "M", f: "F" }[item.kind]),
              h("span.name", item.name), !isFn && item.kind !== "v" && h("span.meta", fmtCompact(item.est_rows)));
          }))),
        !groups.length && h("div", { style: "padding:2px 26px;color:var(--neutral2);font-size:var(--text-sm)" }, "empty"));
    }),
    h("details.schema", h("summary", "Other objects"),
      h("a.item", { href: "#/sequences" }, h("span.glyph.s", "S"), h("span.name", "Sequences"), h("span.meta", tree.sequences.length)),
      h("a.item", { href: "#/types" }, h("span.glyph.t", "E"), h("span.name", "Types & enums"), h("span.meta", tree.types.length))));
  }

  async function runSearch() {
    const term = search.value.trim();
    if (term.length < 2) return renderTree();
    try {
      const hits = await api(`/search?q=${enc(term)}`);
      list.replaceChildren(h("div.search-results", hits.length ? hits.map((x) =>
        h("a.hit", { href: x.type === "function" ? `#/fn/${x.detail}` : `#/rel/${enc(x.schema)}/${enc(x.name)}${x.type === "column" ? "?tab=columns" : ""}` },
          x.type === "column" ? x.detail : x.name, h("small", `${x.type} · ${x.schema}.${x.name}`))) : h("div.empty", "No matches")));
    } catch (err) {
      list.replaceChildren(errorBox(err));
    }
  }
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 180); });
  renderTree();

  const c = status.connection;
  const relationCount = tree.relations.length;
  const element = h("aside.sidebar", { "aria-label": "Navigation" },
    h("div.sidebar-head", lockup("#/overview"), themeToggle(), search),
    h("div.sidebar-scroll",
      NAV.map((group) => h("nav.nav-group", { "aria-label": group.label }, h("div.group-label", group.label),
        group.items.map(([id, label]) => {
          const link = h("a.nav-item", { href: `#/${id}`, "data-nav": id }, icon(id), h("span", label));
          navLinks.push(link);
          return link;
        }))),
      h("div.nav-group", h("div.group-label", "Objects", h("span", { style: "float:right;font-family:var(--font-mono)" }, relationCount)), list)),
    h("div.sidebar-foot",
      h("a.conn", { href: "#/databases", title: `${c.version}\nClick to switch database` }, h("span.dot"),
        h("span", h("strong", c.database), h("small", `${c.user}@${c.host}:${c.port}`)))));
  return {
    element,
    refresh: () => (search.value.trim().length < 2 ? renderTree() : null),
    setActive: (id) => navLinks.forEach((a) => {
      const on = a.dataset.nav === id;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }),
  };
}

// ---------------------------------------------------------------- shell + router
let shell = null;

function buildShell() {
  const main = h("main.main");
  const side = sidebar();
  const crumbs = h("div.crumbs");
  const shellEl = h("div.shell");
  const closeDrawer = () => shellEl.classList.remove("drawer-open");
  shellEl.append(
    side.element,
    h("div.backdrop", { onclick: closeDrawer }),
    h("div.frame-wrap", h("div.frame",
      h("header.frame-head",
        h("button.btn.ghost.menu", { title: "Open navigation", "aria-label": "Open navigation", onclick: () => shellEl.classList.toggle("drawer-open") }, "☰"),
        crumbs, h("span.spacer"),
        h("span.product-label", `Zynn ${PRODUCT}`),
        h("button.btn.ghost.small", { title: "Reload schema", "aria-label": "Reload schema", onclick: async () => { tree = await api("/tree"); side.refresh(); route(); } }, icon("reload", 14)),
        h("button.btn.ghost.small", { title: "Disconnect", "aria-label": "Disconnect", onclick: async () => { await api("/disconnect", {}); status = await api("/status"); shell = null; location.hash = ""; connectScreen(); } }, icon("power", 14))),
      main)));
  root.replaceChildren(shellEl);
  shell = { main, side, crumbs, closeDrawer };
}

function route() {
  if (!shell) return;
  const [pathPart, queryPart] = (location.hash.slice(1) || "/overview").split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(queryPart ?? "");
  const page = parts[0] ?? "overview";
  shell.side.setActive(page);
  const group = NAV.find((g) => g.items.some(([id]) => id === page));
  const title = group ? group.items.find(([id]) => id === page)[1]
    : page === "rel" ? parts[2] : page === "fn" ? "Function" : page === "sequences" ? "Sequences" : page === "types" ? "Types & enums" : "Overview";
  shell.crumbs.replaceChildren(h("span", group?.label ?? PAGE_TITLES[page] ?? "Work"), h("span.sep", "›"), h("strong", title));
  document.title = `${title} · Zynn ${PRODUCT}`;
  shell.side.refresh();
  shell.closeDrawer();

  const views = {
    overview: () => pages.overviewPage(),
    ask: () => askPage(params, status),
    create: () => createPage(params, status, {
      onSchemaChanged: async () => { tree = await api("/tree"); shell.side.refresh(); },
      onDatabaseCreated: async () => { location.hash = "#/create"; await start(); },
    }),
    sql: () => sqlPage(params),
    rel: () => pages.relationPage(parts[1], parts[2], params.get("tab")),
    fn: () => pages.functionPage(parts[1]),
    relationships: () => pages.relationshipsPage(tree),
    activity: () => pages.activityPage(),
    roles: () => pages.rolesPage(),
    settings: () => pages.settingsPage(),
    sequences: () => pages.sequencesPage(),
    types: () => pages.typesPage(tree),
    databases: () => pages.databasesPage(
      async (name) => { await api("/switch-database", { database: name }); location.hash = "#/overview"; await start(); },
      async () => { location.hash = "#/create"; await start(); }),
  };
  const view = views[parts[0]] ?? views.overview;
  shell.main.scrollTop = 0;
  mount(shell.main, async () => view());
}

async function start() {
  try {
    status = await api("/status");
    if (!status.connected) return connectScreen();
    tree = await api("/tree");
    buildShell();
    route();
  } catch (err) {
    connectScreen(err.message);
  }
}

window.addEventListener("hashchange", route);
start();
