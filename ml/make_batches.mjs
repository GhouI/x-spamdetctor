// Builds labelling batches from eval/data/dataset2.json.
// Per thread: X-'probable spam' replies (cap 45) + random other replies (cap 45), minus already-labelled ids.
// Each batch also gets ~15 calibration rows already labelled by the main labeller (eval/data/gold-with-unsure.json),
// so each labelling agent's agreement can be measured. Output: eval/data/batches/batch-NN.txt + batches/key.json
import fs from "fs";

const D = new URL("../eval/data/", import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL("dataset2.json", D)));
const old = JSON.parse(fs.readFileSync(new URL("gold-with-unsure.json", D)));  // id -> bot/lowq/human/unsure (calibration source)
const done = fs.existsSync(new URL("labels2.json", D)) ? JSON.parse(fs.readFileSync(new URL("labels2.json", D))) : {};
const OUT = process.env.OUT || "batches";
const NOW = Math.max(...data.replies.map(r => Date.parse(r.createdAt) || 0));
let seed = +(process.env.SEED || 42); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const shuffle = a => a.map(x => [rnd(), x]).sort((p, q) => p[0] - q[0]).map(x => x[1]);

const byThread = new Map();
for (const r of data.replies) (byThread.get(r.focal) || byThread.set(r.focal, []).get(r.focal)).push(r);
const pick = [];
for (const [focal, rs] of byThread) {
  const fresh = rs.filter(r => !(r.id in old) && !(r.id in done) && r.user?.handle !== data.posts[focal]?.author);
  pick.push(...shuffle(fresh.filter(r => r.spam)).slice(0, 45), ...shuffle(fresh.filter(r => !r.spam)).slice(0, 45));
}
const calib = shuffle(data.replies.filter(r => r.id in old && old[r.id] !== "unsure"));

const days = u => Math.max(1, (NOW - Date.parse(u.createdAt)) / 864e5);
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n ?? 0);
const row = (i, r) => { const u = r.user, d = days(u);
  return `${i}|${u.handle}|${d < 365 ? Math.round(d) + "d" : (d / 365).toFixed(1) + "y"}|${Math.round((u.posts || 0) / d)}/d|${fmt(u.followers)}/${fmt(u.following)}${u.premium ? "|✓" : ""}${u.defaultAvatar ? "|EGG" : ""}|${(u.bio || "-").replace(/\s+/g, " ").slice(0, 60)}|> ${(r.text || "[media]").replace(/\s+/g, " ").slice(0, 200)}${r.media ? " [+media]" : ""}`; };

const SIZE = 110, CAL = 15;
const groups = shuffle(pick);
fs.mkdirSync(new URL(`${OUT}/`, D), { recursive: true });
const key = {};
let ci = 0;
for (let b = 0; b * SIZE < groups.length; b++) {
  const items = shuffle([...groups.slice(b * SIZE, (b + 1) * SIZE).map(r => ({ r, cal: false })), ...calib.slice(ci, ci += CAL).map(r => ({ r, cal: true }))]);
  // group by thread so the post context is shown once per thread
  const threads = [...new Set(items.map(x => x.r.focal))];
  let out = "", idx = 0; key[b] = [];
  for (const t of threads) {
    const p = data.posts[t] || {};
    out += `\n### POST by ${p.author}: ${(p.text || "").replace(/\s+/g, " ").slice(0, 300)}\n`;
    for (const x of items.filter(x => x.r.focal === t)) { out += row(idx, x.r) + "\n"; key[b].push({ id: x.r.id, cal: x.cal }); idx++; }
  }
  fs.writeFileSync(new URL(`${OUT}/batch-${String(b).padStart(2, "0")}.txt`, D), out.trimStart());
}
fs.writeFileSync(new URL(`${OUT}/key.json`, D), JSON.stringify(key));
console.log(`${pick.length} new rows to label in ${Object.keys(key).length} batches (+${CAL} calibration rows each)`);
