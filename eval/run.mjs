// Offline comparison of bot-reply detection techniques on harvested X replies.
// Usage: OPENAI_API_KEY=... node eval/run.mjs [technique ...]
// Data: eval/data/replies.json (gitignored; harvested from X TweetDetail responses).
// Labels: r.spam = X put the reply behind "Show probable spam" (weak label);
//         eval/data/gold.json (optional) = hand labels {id: "bot"|"lowq"|"human"}.
// API results are cached per technique in eval/data/cache-<name>.json, so reruns are free.
import fs from "fs";
import vm from "vm";

const DIR = new URL("./data/", import.meta.url);
const KEY = process.env.OPENAI_API_KEY;
const data = JSON.parse(fs.readFileSync(new URL("replies.json", DIR)));
const R = data.replies;
const NOW = Date.parse(data.collected);

// ---- load the extension's real background.js (describeAuthor, CHOICES, prompts) in a sandbox
const ctx = { fetch, console, Date, chrome: { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener() {} } } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8") +
  "\n;globalThis.__x = { describeAuthor, CHOICES, DECISION_INSTRUCTIONS, LABELS };", ctx);
const { describeAuthor, CHOICES, DECISION_INSTRUCTIONS } = ctx.__x;

// ---- helpers
const days = u => Math.max(1, (NOW - Date.parse(u.createdAt)) / 864e5);
const post = r => data.posts[r.focal] || { author: "", text: "" };
const textOnly = t => t.replace(/https?:\/\/\S+/g, "").trim();
const norm = t => textOnly(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function cache(name) {
  const f = new URL(`cache-${name}.json`, DIR);
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {};
  return { c, save: () => fs.writeFileSync(f, JSON.stringify(c)) };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

async function api(path, body, tries = 4) {
  for (let t = 0; ; t++) {
    const res = await fetch("https://api.openai.com/v1/" + path, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body)
    });
    const j = await res.json();
    if (res.ok) return j;
    if ((res.status === 429 || res.status >= 500) && t < tries) { await new Promise(r => setTimeout(r, 500 * 2 ** t)); continue; }
    throw new Error(`${path} ${res.status}: ${j?.error?.message}`);
  }
}

// Runs fn(reply) -> score for every reply not yet cached.
async function cachedRun(name, fn, { conc = 10, subset = R } = {}) {
  const { c, save } = cache(name);
  const todo = subset.filter(r => !(r.id in c));
  let n = 0; const t0 = Date.now();
  await pool(todo, conc, async r => {
    try { c[r.id] = await fn(r); } catch (e) { console.error(name, r.id, e.message); }
    if (++n % 100 === 0) { save(); process.stderr.write(`  ${name}: ${n}/${todo.length}\n`); }
  });
  save();
  if (todo.length) console.error(`  ${name}: ${todo.length} calls in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return c;
}

const choiceQ = { type: "choice", name: "kind", instructions: DECISION_INSTRUCTIONS, choices: CHOICES };
const pHuman = a => a.probabilities.find(p => p.value === "human")?.probability ?? 0;

// ---- techniques: each returns {id: score in [0,1]} (higher = more bot-like)
const T = {
  // A. Decisions, reply text + handle only (extension v1)
  async dec_text() {
    return cachedRun("dec_text", async r => {
      const j = await api("decisions", { model: "gpt-6-luna", questions: [choiceQ],
        input: `Original post on X by ${post(r).author}:\n${post(r).text}\n\nReply from ${r.user.name} ${r.user.handle}:\n${r.text || "[media only]"}` });
      return 1 - pHuman(j.answers[0]);
    });
  },
  // B. Decisions, text + author account summary (extension v2, current)
  async dec_meta() {
    return cachedRun("dec_meta", async r => {
      const j = await api("decisions", { model: "gpt-6-luna", questions: [choiceQ],
        input: `Original post on X by ${post(r).author}:\n${post(r).text}\n\nReply author: ${describeAuthor(r.user)}\n\nReply:\n${r.text || "[media only]"}` });
      return 1 - pHuman(j.answers[0]);
    });
  },
  // C. Decisions, two separate predicates (text spamminess, account automation); returns both
  async dec_pred() {
    return cachedRun("dec_pred", async r => {
      const j = await api("decisions", { model: "gpt-6-luna",
        input: `Original post on X by ${post(r).author}:\n${post(r).text}\n\nReply author: ${describeAuthor(r.user)}\n\nReply:\n${r.text || "[media only]"}`,
        questions: [
          { type: "predicate", name: "spam_text", instructions: "The reply text is spam, a scam, engagement bait, generic filler that ignores the post, or AI-generated filler. On-topic opinions, jokes, questions and insults are not spam, however short or rude." },
          { type: "predicate", name: "automated", instructions: "The reply author is an automated, bot or spam-farm account rather than a person, judging by the account stats AND the reply together." }
        ] });
      const g = n => j.answers.find(a => a.name === n)?.probability ?? 0;
      return { text: g("spam_text"), acct: g("automated") };
    });
  },
  // C2. One Decisions call with all three questions (choice + both predicates)
  async dec_combo() {
    return cachedRun("dec_combo", async r => {
      const j = await api("decisions", { model: "gpt-6-luna",
        input: `Original post on X by ${post(r).author}:\n${post(r).text}\n\nReply author: ${describeAuthor(r.user)}\n\nReply:\n${r.text || "[media only]"}`,
        questions: [choiceQ,
          { type: "predicate", name: "spam_text", instructions: "The reply text is spam, a scam, engagement bait, generic filler that ignores the post, or AI-generated filler. On-topic opinions, jokes, questions and insults are not spam, however short or rude." },
          { type: "predicate", name: "automated", instructions: "The reply author is an automated, bot or spam-farm account rather than a person, judging by the account stats AND the reply together." }
        ] });
      const g = n => j.answers.find(a => a.name === n);
      return { choice: 1 - pHuman(g("kind")), text: g("spam_text").probability, acct: g("automated").probability };
    });
  },
  // D. Hand-weighted heuristics (no API)
  heur() {
    const out = {};
    for (const r of R) {
      const u = r.user, d = days(u), t = textOnly(r.text);
      let s = 0;
      if (!t && /https?:\/\//.test(r.text)) s += 0.35;               // link-only
      else if (/https?:\/\//.test(r.text)) s += 0.1;
      if (d < 30) s += 0.25; else if (d < 120) s += 0.12;
      if (u.posts / d > 150) s += 0.25; else if (u.posts / d > 60) s += 0.1;
      if (u.followers < 50) s += 0.15;
      if (u.following > 1000 && u.followers > 0.85 * u.following && u.followers < 1.15 * u.following) s += 0.15; // follow-back farm
      if (u.defaultAvatar) s += 0.2;
      if (!u.bio) s += 0.05;
      if (/\d{6,}$/.test(u.handle)) s += 0.1;
      if (t.length > 0 && t.length < 12 && !r.media) s += 0.08;
      if (u.followers >= 5e4) s -= 0.4;
      out[r.id] = Math.max(0, Math.min(1, s));
    }
    return out;
  },
  // E. Cross-reply duplicates: same normalized text from different authors in a thread,
  //    or one author replying many times in the same thread.
  dup() {
    const byText = new Map(), byAuthor = new Map(), out = {};
    for (const r of R) {
      const k = r.focal + "|" + norm(r.text);
      if (norm(r.text).length >= 8) (byText.get(k) || byText.set(k, new Set()).get(k)).add(r.user.id);
      const a = r.focal + "|" + r.user.id; byAuthor.set(a, (byAuthor.get(a) || 0) + 1);
    }
    for (const r of R) {
      const dupAuthors = byText.get(r.focal + "|" + norm(r.text))?.size || 0;
      const own = byAuthor.get(r.focal + "|" + r.user.id);
      out[r.id] = dupAuthors >= 2 ? 0.9 : own >= 4 ? 0.6 : 0;
    }
    return out;
  },
  // H. Full LLM (Responses API), reasoning, same information as B
  async llm() {
    const schema = { type: "object", additionalProperties: false, required: ["bot_probability"], properties: { bot_probability: { type: "number" } } };
    return cachedRun("llm", async r => {
      const j = await api("responses", { model: "gpt-6-luna", reasoning: { effort: "low" }, store: false,
        instructions: "You judge whether a reply on X was written by a bot, spam account or engagement farm (as opposed to a genuine person, including low-effort, rude, off-topic or foreign-language humans). Use the reply text, its relation to the post, and the author's account stats. Paid checkmarks are not evidence of humanity. Output the probability it is a bot/spam account.",
        input: `Original post by ${post(r).author}:\n${post(r).text}\n\nReply author: ${describeAuthor(r.user)}\n\nReply:\n${r.text || "[media only]"}`,
        text: { format: { type: "json_schema", name: "verdict", schema, strict: true } } });
      return JSON.parse(j.output_text ?? j.output.flatMap(o => o.content || []).find(c => c.type === "output_text").text).bot_probability;
    }, { conc: 10 });
  }
};

// ---- metrics
function auc(scores, labels) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return NaN;
  let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
function atThreshold(scores, labels, th) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  scores.forEach((s, i) => { const p = s >= th; labels[i] ? (p ? tp++ : fn++) : (p ? fp++ : tn++); });
  return { prec: tp / Math.max(1, tp + fp), rec: tp / Math.max(1, tp + fn), fpr: fp / Math.max(1, fp + tn), hidden: tp + fp };
}
// best recall while wrongly hiding <= maxFpr of humans
function recallAtFpr(scores, labels, maxFpr) {
  const ths = [...new Set(scores)].sort((a, b) => b - a);
  let best = { rec: 0, th: 1 };
  for (const th of ths) { const m = atThreshold(scores, labels, th); if (m.fpr <= maxFpr && m.rec >= best.rec) best = { ...m, th }; }
  return best;
}

export { R, data, T, auc, atThreshold, recallAtFpr, days, norm, textOnly };

if (import.meta.url === `file://${process.argv[1]}`) {
  const goldOnly = process.argv.includes("--gold");
  const want = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if (goldOnly) { const ids = new Set(JSON.parse(fs.readFileSync(new URL("gold-sample.json", DIR)))); R.splice(0, R.length, ...R.filter(r => ids.has(r.id))); }
  const names = want.length ? want : ["heur", "dup", "dec_text", "dec_meta", "dec_pred"];
  if (names.some(n => n.startsWith("dec") || n === "llm") && !KEY) { console.error("Set OPENAI_API_KEY"); process.exit(1); }
  for (const n of names) { const t0 = Date.now(); await T[n](); console.error(`${n} ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
}
