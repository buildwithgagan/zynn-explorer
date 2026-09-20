// Send one request to Create and print how it was read. Stages nothing durable: the draft lives in the reply only.
//   node scripts/creator-ask.mjs "add a phone number to customers" [http://127.0.0.1:4477]
const [request, base = "http://127.0.0.1:4477"] = process.argv.slice(2);
const r = await (await fetch(base + "/api/create/interpret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request, ops: [] }) })).json();
if (r.error) { console.error(r.error); process.exit(1); }
console.log(`ok=${r.ok} · ${r.ms} ms · ${r.usage?.requests} requests · ${r.usage?.input_tokens} tokens\n${r.reply?.text}`);
for (const n of r.reply?.notes ?? []) console.log("note:", n);
for (const [i, p] of (r.reply?.parts ?? []).entries()) { console.log(`${i + 1}. ${p.ok ? "ok  " : "FAIL"} ${p.request}\n      ${p.text}`); for (const n of p.notes) console.log("      note:", n); }
const added = new Set(r.added);
for (const o of r.draft.ops.filter((o) => added.has(o.id))) console.log("+", o.label);
for (const s of r.suggestions ?? []) console.log("?", s.label);
for (const j of r.judgments) console.log(`  ${j.applied ? "✓" : "·"} ${j.title} = ${j.value} (${j.rule ? "rule" : j.p.toFixed(2)})${j.alternatives?.length ? "  alt: " + j.alternatives.map((a) => `${a.label} ${a.p.toFixed(2)}`).join(", ") : ""}`);
