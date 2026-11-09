#!/usr/bin/env node
// Latency benchmark: OpenAI Decisions API vs Responses API.
// Node 22, no deps. Usage: OPENAI_API_KEY=... node test/bench-latency.mjs [--json out.json]
// Keeps total spend small (~130 calls).

import { writeFileSync } from 'node:fs';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
const BASE = 'https://api.openai.com/v1';
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

// ---------- samples ----------
const SAMPLES = [
  { post: 'Just shipped our new open-source Rust HTTP client. 40% faster than reqwest in our benchmarks.', handle: 'devmarta', reply: 'Would love to see the benchmark methodology. Were you reusing connections in both?' },
  { post: 'Just shipped our new open-source Rust HTTP client. 40% faster than reqwest in our benchmarks.', handle: 'cryptoKing_8821', reply: '🚀🚀 Huge $SOL airdrop live now! Claim yours before it ends 👉 bit.ly/claim-sol-free' },
  { post: 'Hot take: pineapple on pizza is fine and you are all cowards.', handle: 'tonyb', reply: 'absolutely not. go to jail' },
  { post: 'Hot take: pineapple on pizza is fine and you are all cowards.', handle: 'emily_x_99', reply: 'hey cutie 😘 lonely tonight? check my bio 🔥' },
  { post: 'The Fed held rates steady today, signalling two cuts likely before year end.', handle: 'macro_mike', reply: 'Two cuts with core PCE still at 2.9%? Bond market is not buying it, 10y barely moved.' },
  { post: 'The Fed held rates steady today, signalling two cuts likely before year end.', handle: 'InsightfulAI_bot', reply: 'Great point! The Fed holding rates steady while signalling two cuts is a significant development that highlights the importance of monetary policy in shaping the economy.' },
  { post: 'My kid just lost her first tooth and asked if the tooth fairy takes Venmo.', handle: 'sarah_k', reply: 'lmao the tooth fairy has to keep up with inflation honestly' },
  { post: 'My kid just lost her first tooth and asked if the tooth fairy takes Venmo.', handle: 'growth_guru', reply: 'Wow amazing! 🙌 So true! Love this!' },
  { post: 'We are hiring a senior frontend engineer in Berlin. React + TypeScript. DM me.', handle: 'jonas_dev', reply: 'Is remote within the EU an option or is it Berlin-only?' },
  { post: 'We are hiring a senior frontend engineer in Berlin. React + TypeScript. DM me.', handle: 'SEO_Pro_Services', reply: 'Boost your website ranking to #1 on Google in 7 days! Cheap SEO packages, DM for details. www.top-seo-deals.biz' },
  { post: 'The new Zelda trailer looks incredible, cannot wait for March.', handle: 'gamer_lou', reply: 'the framerate in that open field section looked rough tho, hope they fix it' },
  { post: 'The new Zelda trailer looks incredible, cannot wait for March.', handle: 'trader_alpha', reply: 'I made $12,400 last week trading with Mr. Daniels, best forex mentor. Message him on WhatsApp +1 555 0199' },
];

const LONG_POST = ('I have been thinking a lot about how small teams should approach observability. ' +
  'Most advice assumes you have a platform team, a dedicated SRE rotation, and budget for three vendors. ' +
  'In practice a five-person startup needs: structured logs with request ids, one dashboard per user-facing flow, ' +
  'alerts only on symptoms users would notice, and a habit of reading traces during code review. ' +
  'Everything else is a distraction until you have paying customers who complain. ').repeat(3);
const LONG_REPLY = 'Mostly agree, but I would push back on alerts-only-on-symptoms. We got burned when our queue depth crept up for two days before users noticed anything, ' +
  'and by then the backlog took six hours to drain. A couple of cause-based alerts on saturation (queue depth, DB connections, disk) are cheap and saved us twice since. ' +
  'Also +1 on reading traces in code review, that habit alone caught an N+1 that would have killed our checkout page.';

const CHOICES = [
  { value: 'human', description: 'Genuine person engaging with the post' },
  { value: 'crypto_scam', description: 'Crypto, airdrop, giveaway, trading or investment promotion' },
  { value: 'adult_spam', description: 'Adult/dating bait, check my bio, DM me' },
  { value: 'engagement_bait', description: "Generic praise or reaction that ignores the post's specifics" },
  { value: 'ai_filler', description: 'AI-generated filler that restates the post' },
  { value: 'promo_spam', description: 'Unrelated self-promotion, links, copy-paste' },
];
const INSTR = 'Classify the reply. Short, rude, joking or opinionated on-topic replies are human. Pick a bot category only when the reply shows clear bot/spam signals.';
const inputText = (s) => `Original post on X:\n${s.post}\n\nReply from @${s.handle}:\n${s.reply}`;

const choiceQ = { type: 'choice', name: 'kind', instructions: INSTR, choices: CHOICES };
const predicateQ = { type: 'predicate', name: 'is_bot', instructions: 'Is this reply likely written by an automated account or spammer?' };

// ---------- http ----------
const counters = { calls: 0, http429: 0, errors: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    counters.calls++;
    const t0 = performance.now();
    let res, json, text;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      });
      text = await res.text();
      try { json = JSON.parse(text); } catch { json = null; }
    } catch (e) {
      counters.errors++;
      return { ok: false, status: 0, ms: performance.now() - t0, error: String(e) };
    }
    const ms = performance.now() - t0;
    const serverMs = Number(res.headers.get('openai-processing-ms')) || null;
    if (res.status === 429 && attempt < retries) {
      counters.http429++;
      const ra = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(ra * 1000, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) counters.errors++;
    return {
      ok: res.ok, status: res.status, ms, serverMs, json,
      requestId: res.headers.get('x-request-id'),
      error: res.ok ? null : (json?.error?.message || text?.slice(0, 300)),
    };
  }
}

// ---------- stats ----------
function stats(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pct = (p) => a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const r = (x) => Math.round(x);
  return { n: a.length, min: r(a[0]), p50: r(pct(50)), p90: r(pct(90)), p99: r(pct(99)), max: r(a[a.length - 1]), mean: r(mean) };
}
const fmt = (s) => s ? `n=${s.n} min=${s.min} p50=${s.p50} p90=${s.p90} p99=${s.p99} max=${s.max} mean=${s.mean} ms` : 'n/a';

const results = { date: new Date().toISOString(), sections: {} };
function report(name, rs, extra = {}) {
  const ok = rs.filter((r) => r.ok);
  const fails = rs.filter((r) => !r.ok);
  const sec = {
    client: stats(ok.map((r) => r.ms)),
    server: stats(ok.map((r) => r.serverMs)),
    network: stats(ok.filter((r) => r.serverMs).map((r) => r.ms - r.serverMs)),
    failures: fails.length,
    failSample: fails[0]?.error,
    ...extra,
  };
  results.sections[name] = sec;
  console.log(`\n## ${name}`);
  console.log(`  client : ${fmt(sec.client)}`);
  if (sec.server) console.log(`  server : ${fmt(sec.server)}  (openai-processing-ms)`);
  if (sec.network) console.log(`  net+q  : ${fmt(sec.network)}  (client - server)`);
  for (const [k, v] of Object.entries(extra)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  if (fails.length) console.log(`  FAILURES: ${fails.length} e.g. [${fails[0].status}] ${fails[0].error}`);
  return sec;
}

const decide = (s, questions = [choiceQ], input) =>
  post('/decisions', { model: 'gpt-6-luna', input: input ?? inputText(s), questions });

// ---------- 1+2. Decisions sequential ----------
console.log('# Decisions API latency benchmark', new Date().toISOString());
{
  const rs = [];
  for (let i = 0; i < 30; i++) rs.push(await decide(SAMPLES[i % SAMPLES.length]));
  const first = rs[0];
  console.log(`\nfirst (cold) call: client=${Math.round(first.ms)}ms server=${first.serverMs}ms status=${first.status}`);
  if (first.json) console.log('sample response:', JSON.stringify(first.json).slice(0, 400));
  const answers = rs.slice(0, 12).map((r, i) => `${SAMPLES[i].handle}=${r.json?.answers?.[0]?.choice}`);
  report('decisions seq (warm, calls 2-30)', rs.slice(1), {
    coldFirstCallMs: Math.round(first.ms), coldFirstServerMs: first.serverMs, answers: answers.join(' '),
  });
}

// ---------- 3. Concurrency ----------
async function batch(n, offset = 0) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => decide(SAMPLES[(offset + i) % SAMPLES.length])));
  return { wall: performance.now() - t0, rs };
}
{
  const batches = [];
  for (let b = 0; b < 3; b++) batches.push(await batch(6, b * 6));
  report('decisions 6-concurrent (3 batches)', batches.flatMap((b) => b.rs), {
    batchWallMs: batches.map((b) => Math.round(b.wall)),
  });
  const b20 = await batch(20);
  report('decisions 20-concurrent (1 batch)', b20.rs, { batchWallMs: Math.round(b20.wall) });
}

// ---------- 4. Input size ----------
{
  const short = [], long = [];
  for (let i = 0; i < 5; i++) {
    short.push(await decide(null, [choiceQ], `Original post on X:\nNice weather today.\n\nReply from @a${i}:\nyep`));
    long.push(await decide(null, [choiceQ], `Original post on X:\n${LONG_POST}\n\nReply from @ops_ana:\n${LONG_REPLY}`));
  }
  const longLen = `Original post on X:\n${LONG_POST}\n\nReply from @ops_ana:\n${LONG_REPLY}`.length;
  report('decisions short input (~60 chars)', short, { inputTokens: short[0].json?.usage });
  report(`decisions long input (~${longLen} chars)`, long, { inputTokens: long[0].json?.usage });
}

// ---------- 5. Number of questions ----------
{
  const one = [], two = [];
  for (let i = 0; i < 5; i++) {
    one.push(await decide(SAMPLES[i]));
    two.push(await decide(SAMPLES[i], [choiceQ, predicateQ]));
  }
  report('decisions 1 question (choice)', one);
  report('decisions 2 questions (choice+predicate)', two, {
    sampleAnswers: two[0].json?.answers?.map((a) => ({ name: a.name, choice: a.choice, probability: a.probability })),
  });
}

// ---------- 6. Responses API baseline ----------
const SCHEMA = {
  type: 'json_schema', name: 'classification', strict: true,
  schema: { type: 'object', properties: { kind: { type: 'string', enum: CHOICES.map((c) => c.value) } }, required: ['kind'], additionalProperties: false },
};
const SYS = INSTR + '\nCategories:\n' + CHOICES.map((c) => `- ${c.value}: ${c.description}`).join('\n');
const respBody = (model, s, effort) => ({
  model, instructions: SYS, input: inputText(s), store: false,
  text: { format: SCHEMA },
  ...(effort ? { reasoning: { effort } } : {}),
});

async function pickEffort(model) {
  for (const effort of ['none', 'minimal', 'low', null]) {
    const r = await post('/responses', respBody(model, SAMPLES[0], effort));
    if (r.ok) return { effort, first: r };
    console.log(`  ${model} effort=${effort}: [${r.status}] ${r.error}`);
    if (r.status !== 400) return { effort: undefined, first: r };
  }
  return { effort: undefined };
}
const outText = (j) => j?.output_text ?? j?.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;

for (const [model, n] of [['gpt-5.4-mini', 15], ['gpt-6-luna', 12]]) {
  console.log(`\n# Responses API ${model}`);
  const { effort, first } = await pickEffort(model);
  if (effort === undefined) {
    results.sections[`responses ${model}`] = { rejected: first?.error ?? 'all effort levels rejected', status: first?.status };
    console.log(`  rejected: ${first?.error}`);
    continue;
  }
  const rs = [];
  for (let i = 1; i <= n; i++) rs.push(await post('/responses', respBody(model, SAMPLES[i % SAMPLES.length], effort)));
  report(`responses ${model} (effort=${effort}, warm)`, rs, {
    effort, probeCallMs: Math.round(first.ms),
    sampleOutput: outText(rs[0].json), usage: rs[0].json?.usage,
  });
}

results.counters = counters;
console.log('\n# totals', JSON.stringify(counters));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
