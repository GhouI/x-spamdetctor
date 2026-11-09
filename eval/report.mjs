// Prints a comparison table of all techniques (cached results only; run eval/run.mjs first).
// Usage: node eval/report.mjs [x|gold]
import fs from "fs";
import { R, T, auc, atThreshold, recallAtFpr } from "./run.mjs";

const DIR = new URL("./data/", import.meta.url);
const load = n => { const f = new URL(`cache-${n}.json`, DIR); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null; };
const goldF = new URL("gold.json", DIR);
const gold = fs.existsSync(goldF) ? JSON.parse(fs.readFileSync(goldF)) : null;
const mode = process.argv[2] || "x";

// label sets
let rows, label;
if (mode === "gold") {
  if (!gold) { console.error("no eval/data/gold.json"); process.exit(1); }
  rows = R.filter(r => r.id in gold);
  label = r => gold[r.id] === "bot";                // lowq + human = negative (must not be hidden)
} else { rows = R; label = r => r.spam; }

const heur = T.heur(), dup = T.dup();
const big = r => r.user.followers >= 5e4 && r.user.followers > 3 * r.user.following;
const src = {
  dec_text: load("dec_text"), dec_meta: load("dec_meta"), dec_pred: load("dec_pred"), llm: load("llm")
};
const S = {};
S["heuristics only"] = r => heur[r.id];
S["cross-reply duplicates"] = r => dup[r.id];
if (src.dec_text) S["Decisions: text only (v1)"] = r => src.dec_text[r.id];
if (src.dec_meta) S["Decisions: text + account (v2)"] = r => src.dec_meta[r.id];
if (src.dec_pred) {
  S["Decisions: predicate text"] = r => src.dec_pred[r.id]?.text;
  S["Decisions: predicate account"] = r => src.dec_pred[r.id]?.acct;
  S["Decisions: predicates max"] = r => Math.max(src.dec_pred[r.id]?.text ?? 0, src.dec_pred[r.id]?.acct ?? 0);
}
if (src.dec_meta) {
  S["v2 + 50k-follower rule"] = r => big(r) ? 0 : src.dec_meta[r.id];
  S["v2 + duplicates (max)"] = r => Math.max(src.dec_meta[r.id], dup[r.id]);
  S["v2 avg heuristics"] = r => (src.dec_meta[r.id] + heur[r.id]) / 2;
}
if (src.dec_meta && src.dec_pred) S["v2 + predicates + dup, 50k rule"] = r => big(r) ? 0 :
  Math.max(dup[r.id], (src.dec_meta[r.id] + src.dec_pred[r.id].text + src.dec_pred[r.id].acct) / 3);
if (src.llm) { S["LLM (Responses, reasoning)"] = r => src.llm[r.id]; }

const pct = x => (100 * x).toFixed(1).padStart(5) + "%";
console.log(`labels: ${mode === "gold" ? "hand labels (bot vs not)" : "X 'probable spam'"} — ${rows.length} replies, ${rows.filter(label).length} positive\n`);
console.log("technique".padEnd(34), "  AUC ", " | @0.7: prec  recall  humans-hidden", " | best recall with ≤1% humans hidden");
for (const [name, f] of Object.entries(S)) {
  const rs = rows.filter(r => f(r) != null);
  const sc = rs.map(f), lb = rs.map(label);
  const a = auc(sc, lb), m = atThreshold(sc, lb, 0.7), b = recallAtFpr(sc, lb, 0.01);
  console.log(name.padEnd(34), a.toFixed(3).padStart(6), " |     ", pct(m.prec), pct(m.rec), "  ", pct(m.fpr), "      |", pct(b.rec), `(threshold ${b.th.toFixed(2)})`, rs.length < rows.length ? `[${rs.length} rows]` : "");
}
