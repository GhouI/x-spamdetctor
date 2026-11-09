// Learned combiner: L2 logistic regression over Decisions probabilities + account/text features,
// evaluated with 5-fold stratified cross-validation on the hand labels (bot vs not-bot).
// Usage: node eval/combine.mjs            (needs cached dec_* results and eval/data/gold.json)
import fs from "fs";
import { R, T, auc, atThreshold, recallAtFpr, days, textOnly } from "./run.mjs";

const DIR = new URL("./data/", import.meta.url);
const load = n => JSON.parse(fs.readFileSync(new URL(`cache-${n}.json`, DIR)));
const gold = JSON.parse(fs.readFileSync(new URL("gold.json", DIR)));
const dec = { text: load("dec_text"), meta: load("dec_meta"), pred: load("dec_pred"), combo: fs.existsSync(new URL("cache-dec_combo.json", DIR)) ? load("dec_combo") : null };
const llmF = new URL("cache-llm.json", DIR), llm = fs.existsSync(llmF) ? JSON.parse(fs.readFileSync(llmF)) : {};
const dup = T.dup();

const logit = p => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));
const lg = x => Math.log10(1 + Math.max(0, x));

const FEATURES = {
  decisions: r => [logit(dec.text[r.id]), logit(dec.meta[r.id]), logit(dec.pred[r.id].text), logit(dec.pred[r.id].acct)],
  account: r => {
    const u = r.user, d = days(u), t = textOnly(r.text);
    return [lg(u.followers), lg(u.following), lg(u.posts / d), lg(d), lg(u.followers) - lg(u.following),
      u.defaultAvatar ? 1 : 0, u.bio ? 0 : 1, u.premium ? 1 : 0, (!t && /https?:/.test(r.text)) ? 1 : 0,
      lg(t.length), r.media ? 1 : 0, dup[r.id] > 0 ? 1 : 0, u.followers >= 5e4 ? 1 : 0];
  }
};

function standardize(X) {
  const m = X[0].map((_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = X[0].map((_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - m[j]) ** 2, 0) / X.length) || 1);
  return { f: x => x.map((v, j) => (v - m[j]) / sd[j]) };
}
function train(X, y, l2 = 0.3, iters = 3000, lr = 0.1) {
  const w = new Array(X[0].length).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = w.map(v => l2 * v / X.length); let gb = 0;
    X.forEach((x, i) => { const p = 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0)))); const e = p - y[i]; gb += e / X.length; x.forEach((v, j) => gw[j] += e * v / X.length); });
    w.forEach((_, j) => w[j] -= lr * gw[j]); b -= lr * gb;
  }
  return x => 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0))));
}

const rows = R.filter(r => r.id in gold);
const y = rows.map(r => gold[r.id] === "bot" ? 1 : 0);
// stratified folds, fixed seed
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const fold = new Array(rows.length);
for (const cls of [0, 1]) { const idx = rows.map((_, i) => i).filter(i => y[i] === cls).sort(() => rnd() - 0.5); idx.forEach((i, k) => fold[i] = k % 5); }

function cv(featFn) {
  const X = rows.map(featFn), out = new Array(rows.length);
  for (let f = 0; f < 5; f++) {
    const tr = X.map((_, i) => i).filter(i => fold[i] !== f), te = X.map((_, i) => i).filter(i => fold[i] === f);
    const s = standardize(tr.map(i => X[i]));
    const model = train(tr.map(i => s.f(X[i])), tr.map(i => y[i]));
    te.forEach(i => out[i] = model(s.f(X[i])));
  }
  return out;
}

const pct = x => (100 * x).toFixed(1).padStart(5) + "%";
const show = (name, sc) => {
  const a = auc(sc, y), m5 = atThreshold(sc, y, 0.5), b1 = recallAtFpr(sc, y, 0.01), b3 = recallAtFpr(sc, y, 0.03);
  console.log(name.padEnd(40), a.toFixed(3), " | @0.5:", pct(m5.prec), pct(m5.rec), pct(m5.fpr), " | recall @≤1% people hidden:", pct(b1.rec), " @≤3%:", pct(b3.rec));
};
console.log(`${rows.length} labelled replies, ${y.reduce((a, b) => a + b)} bots. Columns: AUC | @0.5 precision recall people-hidden | best recall at a people-hidden budget\n`);
show("LR: account/text features only (no API)", cv(FEATURES.account));
show("LR: Decisions scores only", cv(FEATURES.decisions));
show("LR: Decisions + account features", cv(r => [...FEATURES.decisions(r), ...FEATURES.account(r)]));
if (dec.combo) show("LR: 1 call (choice+2 predicates) + features", cv(r => [logit(dec.combo[r.id].choice), logit(dec.combo[r.id].text), logit(dec.combo[r.id].acct), ...FEATURES.account(r)]));
show("LR: account predicate + features", cv(r => [logit(dec.pred[r.id].acct), ...FEATURES.account(r)]));
if (Object.keys(llm).length) {
  const has = rows.every(r => r.id in llm);
  if (has) { show("LLM alone (Responses, reasoning)", rows.map(r => llm[r.id]));
    show("LR: LLM + Decisions + features", cv(r => [logit(llm[r.id]), ...FEATURES.decisions(r), ...FEATURES.account(r)])); }
}

// final model trained on everything, for the extension: print weights
if (process.argv.includes("--export")) {
  const featFn = r => [...FEATURES.decisions(r), ...FEATURES.account(r)];
  const X = rows.map(featFn);
  const m = X[0].map((_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = X[0].map((_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - m[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map(x => x.map((v, j) => (v - m[j]) / sd[j]));
  // re-train capturing weights
  const w = new Array(Z[0].length).fill(0); let b = 0;
  for (let it = 0; it < 3000; it++) {
    const gw = w.map(v => 0.3 * v / Z.length); let gb = 0;
    Z.forEach((x, i) => { const p = 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0)))); const e = p - y[i]; gb += e / Z.length; x.forEach((v, j) => gw[j] += e * v / Z.length); });
    w.forEach((_, j) => w[j] -= 0.1 * gw[j]); b -= 0.1 * gb;
  }
  console.log(JSON.stringify({ mean: m, sd, w, b }));
}
