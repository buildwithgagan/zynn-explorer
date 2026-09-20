// Entity-relationship diagram, shared by Relationships and Creator.
// tables: [{ id, name, state?, columns: [{ name, type, isPk, isFk, state? }] }]
// edges:  [{ from, to, fromCol, toCol, state?, title? }]      state: same | added | changed | dropped

const NS = "http://www.w3.org/2000/svg";
const W = 230, ROW = 17, HEAD = 26, GAP_X = 90, GAP_Y = 36, MAX_COLS = 14;

const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const stateClass = (state) => (state && state !== "same" ? ` ${state}` : "");

export function erdDiagram({ tables, edges }, { onClick } = {}) {
  // Layered layout: referenced tables sit to the left of the tables that reference them.
  const depth = new Map(tables.map((t) => [t.id, 0]));
  for (let pass = 0; pass < tables.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (e.from !== e.to && depth.has(e.from) && depth.has(e.to) && depth.get(e.from) <= depth.get(e.to) && depth.get(e.to) < tables.length) {
        depth.set(e.from, depth.get(e.to) + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const layers = [];
  tables.forEach((t) => (layers[depth.get(t.id)] ??= []).push(t));
  const nodes = new Map();
  let width = 0, height = 0;
  layers.filter(Boolean).forEach((layer, li) => {
    let y = 24;
    for (const t of layer) {
      const cols = t.columns.slice(0, MAX_COLS);
      const hgt = HEAD + cols.length * ROW + 8 + (t.columns.length > cols.length ? ROW : 0);
      nodes.set(t.id, { t, cols, x: 24 + li * (W + GAP_X), y, h: hgt });
      y += hgt + GAP_Y;
    }
    width = Math.max(width, 24 + (li + 1) * (W + GAP_X));
    height = Math.max(height, y);
  });

  const root = s("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  const rowY = (node, col) => {
    const i = node.cols.findIndex((c) => c.name === col);
    return node.y + HEAD + (i < 0 ? node.cols.length : i) * ROW + ROW / 2 + 2;
  };
  const drawn = [];
  for (const e of edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) continue;
    const y1 = rowY(a, e.fromCol), y2 = rowY(b, e.toCol);
    const leftward = b.x < a.x;
    const x1 = leftward ? a.x : a.x + W, x2 = b.x + W;
    const bend = leftward ? -GAP_X / 2 : GAP_X / 2;
    const path = s("path", { class: `erd-edge${stateClass(e.state)}`, d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 + Math.abs(bend)},${y2} ${x2},${y2}` });
    path.append(s("title", {}, e.title ?? `${a.t.name}.${e.fromCol} → ${b.t.name}.${e.toCol}`));
    drawn.push({ path, from: e.from, to: e.to });
    root.append(path);
  }
  for (const [id, n] of nodes) {
    const g = s("g", { class: `erd-node${stateClass(n.t.state)}${onClick ? "" : " static"}`, transform: `translate(${n.x},${n.y})` },
      s("rect", { class: "box", width: W, height: n.h, rx: 6 }),
      s("rect", { class: "head", x: 1, y: 1, width: W - 2, height: HEAD - 2, rx: 5 }),
      s("text", { class: "title", x: 10, y: 17 }, n.t.name),
      n.t.state && n.t.state !== "same" ? s("text", { class: "state", x: W - 10, y: 17, "text-anchor": "end" }, n.t.state === "added" ? "new" : n.t.state) : "");
    n.cols.forEach((c, i) => {
      const y = HEAD + i * ROW + ROW - 3;
      const type = c.type ?? "";
      g.append(s("text", { x: 10, y, class: `${c.isPk ? "key" : ""}${stateClass(c.state)}` }, (c.isPk ? "⚷ " : c.isFk ? "→ " : "  ") + c.name),
        s("text", { class: `type${stateClass(c.state)}`, x: W - 10, y, "text-anchor": "end" }, type.length > 16 ? type.slice(0, 15) + "…" : type));
    });
    if (n.t.columns.length > n.cols.length) g.append(s("text", { class: "type", x: 10, y: HEAD + n.cols.length * ROW + ROW - 3 }, `+ ${n.t.columns.length - n.cols.length} more`));
    g.addEventListener("mouseenter", () => drawn.forEach((e) => e.path.classList.toggle("hot", e.from === id || e.to === id)));
    g.addEventListener("mouseleave", () => drawn.forEach((e) => e.path.classList.remove("hot")));
    if (onClick) g.addEventListener("click", () => onClick(n.t));
    root.append(g);
  }
  return root;
}
