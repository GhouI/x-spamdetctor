// Round 2: compares feature sets for the learned combiner under two CV schemes:
//   random 5-fold (by reply) and leave-one-thread-out (no thread appears in both train and test).
// Usage: node eval/compare.mjs   (needs cache-dec_combo.json, cache-dec_split.json, gold.json)
import fs from "fs";
import { R, auc, atThreshold, recallAtFpr, days, textOnly } from "./run.mjs";

const DIR = new URL("./data/", import.meta.url);
const load = n => JSON.parse(fs.readFileSync(new URL(`cache-${n}.json`, DIR)));
const gold = JSON.parse(fs.readFileSync(new URL("gold.json", DIR)));
const combo = load("dec_combo"), split = load("dec_split");
const logit = p => { p = Math.min(0.999, Math.max(0.001, p)); return Math.log(p / (1 - p)); };
const lg = x => Math.log10(1 + Math.max(0, x));

// ---- thread-level helper features (computed over ALL harvested replies, not just labelled ones)
const clean = t => textOnly(t).replace(/@\w+/g, "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const shingles = t => { const s = new Set(); for (let i = 0; i + 3 <= t.length; i++) s.add(t.slice(i, i + 3)); return s; };
const jacc = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
const byThread = new Map();
for (const r of R) (byThread.get(r.focal) || byThread.set(r.focal, []).get(r.focal)).push({ r, sh: shingles(clean(r.text)), len: clean(r.text).length });
const nearDup = {}, authorCount = {};
for (const list of byThread.values()) {
  const ac = new Map(); list.forEach(({ r }) => ac.set(r.user.id, (ac.get(r.user.id) || 0) + 1));
  for (const a of list) {
    authorCount[a.r.id] = ac.get(a.r.user.id);
    let best = 0;
    if (a.len >= 10) for (const b of list) if (b !== a && b.r.user.id !== a.r.user.id && b.len >= 10) best = Math.max(best, jacc(a.sh, b.sh));
    nearDup[a.r.id] = best;
  }
}
const script = t => /[一-鿿぀-ヿ]/.test(t) ? "cjk" : /[Ѐ-ӿ]/.test(t) ? "cyr" : /[가-힯]/.test(t) ? "kor" : /[؀-ۿ]/.test(t) ? "ara" : "lat";
const BIO_KW = /crypto|web3|nft|\$[A-Z]{2,}|\bdm\b|telegram|whatsapp|t\.me|onlyfans|link in bio|ambassador|\bkol\b|alpha|airdrop|0x[0-9a-f]{6}|\bca:/i;

const F = {
  base: r => { const u = r.user, d = days(u), t = textOnly(r.text);
    return [lg(u.followers), lg(u.following), lg(u.posts / d), lg(d), lg(u.followers) - lg(u.following), u.defaultAvatar ? 1 : 0, u.bio ? 0 : 1,
      u.premium ? 1 : 0, (!t && /https?:/.test(r.text)) ? 1 : 0, lg(t.length), r.media ? 1 : 0, u.followers >= 5e4 ? 1 : 0]; },
  fable: r => { const u = r.user, ratio = u.followers / Math.max(1, u.following);
    return [nearDup[r.id], nearDup[r.id] > 0.6 ? 1 : 0, Math.min(authorCount[r.id], 5), /\d{5,8}$/.test(u.handle) ? 1 : 0, BIO_KW.test(u.bio || "") ? 1 : 0,
      script(r.text) !== "lat" ? 1 : 0, (ratio > 0.5 && ratio < 2 && u.followers > 2000) ? 1 : 0]; },
  combo: r => [logit(combo[r.id].choice), logit(combo[r.id].text), logit(combo[r.id].acct)],
  split: r => { const s = split[r.id]; return [logit(s.promo), logit(s.generic), logit(s.specific), logit(s.paraphrase), logit(s.acct)]; }
};

// Fable's trust tier: lower the score of established big accounts unless there is hard evidence.
const trusted = r => { const u = r.user, d = days(u); return u.followers >= 5e4 && u.followers / Math.max(1, u.following) >= 10 && d >= 730 && u.posts / d < 50; };
const hardEvidence = r => nearDup[r.id] > 0.6 || (split[r.id].promo > 0.8 && /https?:/.test(r.text));

const rows = R.filter(r => r.id in gold && r.id in combo && r.id in split);
const y = rows.map(r => gold[r.id] === "bot" ? 1 : 0);
const threads = [...new Set(rows.map(r => r.focal))];

function trainLR(X, yy, l2 = 0.3) {
  const n = X[0].length, m = new Array(n).fill(0), sd = new Array(n).fill(0);
  X.forEach(x => x.forEach((v, j) => m[j] += v / X.length)); X.forEach(x => x.forEach((v, j) => sd[j] += (v - m[j]) ** 2 / X.length));
  sd.forEach((v, j) => sd[j] = Math.sqrt(v) || 1);
  const Z = X.map(x => x.map((v, j) => (v - m[j]) / sd[j]));
  const w = new Array(n).fill(0); let b = 0;
  for (let it = 0; it < 2500; it++) {
    const gw = w.map(v => l2 * v / Z.length); let gb = 0;
    Z.forEach((x, i) => { const e = 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0)))) - yy[i]; gb += e / Z.length; x.forEach((v, j) => gw[j] += e * v / Z.length); });
    w.forEach((_, j) => w[j] -= 0.1 * gw[j]); b -= 0.1 * gb;
  }
  return x => 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + (v - m[j]) / sd[j] * w[j], 0))));
}
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rfold = new Array(rows.length);
for (const c of [0, 1]) rows.map((_, i) => i).filter(i => y[i] === c).sort(() => rnd() - 0.5).forEach((i, k) => rfold[i] = k % 5);
const tfold = rows.map(r => threads.indexOf(r.focal));

function cv(featFn, folds, k) {
  const X = rows.map(featFn), out = new Array(rows.length);
  for (let f = 0; f < k; f++) {
    const tr = X.map((_, i) => i).filter(i => folds[i] !== f), te = X.map((_, i) => i).filter(i => folds[i] === f);
    if (!te.length) continue;
    const model = trainLR(tr.map(i => X[i]), tr.map(i => y[i]));
    te.forEach(i => out[i] = model(X[i]));
  }
  return out;
}

const pct = x => (100 * x).toFixed(1).padStart(5) + "%";
console.log(`${rows.length} labelled replies, ${y.reduce((a, b) => a + b)} bots, ${threads.length} threads (bots per thread: ${threads.map(t => rows.filter((r, i) => r.focal === t && y[i]).length).join(", ")})`);
console.log(`\n${"feature set".padEnd(44)} | random 5-fold: AUC  rec@1%  rec@3% | leave-thread-out: AUC  rec@1%  rec@3%`);
const sets = {
  "A. 1 call (choice+2 pred) + base": r => [...F.combo(r), ...F.base(r)],
  "B. split 2 calls (Fable) + base": r => [...F.split(r), ...F.base(r)],
  "C. A + Fable thread/handle/bio features": r => [...F.combo(r), ...F.base(r), ...F.fable(r)],
  "D. B + Fable thread/handle/bio features": r => [...F.split(r), ...F.base(r), ...F.fable(r)],
  "E. combo + split + all features": r => [...F.combo(r), ...F.split(r), ...F.base(r), ...F.fable(r)],
  "F. no API: base + Fable features": r => [...F.base(r), ...F.fable(r)]
};
const results = {};
for (const [name, fn] of Object.entries(sets)) {
  const a = cv(fn, rfold, 5), b = cv(fn, tfold, threads.length);
  results[name] = b;
  const m = s => [auc(s, y).toFixed(3), pct(recallAtFpr(s, y, 0.01).rec), pct(recallAtFpr(s, y, 0.03).rec)].join("  ");
  console.log(name.padEnd(44), "|", " ".repeat(14), m(a), " |", " ".repeat(17), m(b));
}
// trust tier on top of the best leave-thread-out set
const best = Object.entries(results).sort((p, q) => auc(q[1], y) - auc(p[1], y))[0];
const tiered = best[1].map((s, i) => trusted(rows[i]) && !hardEvidence(rows[i]) ? s * 0.5 : s);
const m = s => [auc(s, y).toFixed(3), pct(recallAtFpr(s, y, 0.01).rec), pct(recallAtFpr(s, y, 0.03).rec)].join("  ");
console.log(`\nbest (${best[0].slice(0, 2)}) leave-thread-out:              `, m(best[1]));
console.log(`  + Fable trust tier (big established accts ×0.5):`, m(tiered));
const tr = rows.filter(trusted); console.log(`  trusted accounts in labelled set: ${tr.length}, of which bots: ${tr.filter(r => gold[r.id] === "bot").length}`);
// operating point: threshold for ≤1% and ≤3% people hidden, using leave-thread-out scores
for (const fpr of [0.01, 0.03]) { const p = recallAtFpr(tiered, y, fpr); console.log(`  at ≤${fpr * 100}% people hidden: threshold ${p.th.toFixed(2)}, precision ${pct(p.prec)}, recall ${pct(p.rec)}, hides ${p.hidden} of ${rows.length}`); }
