// Service worker: classifies X replies with the OpenAI Decisions API (POST /v1/decisions).
// Falls back to the Responses API (structured JSON) if the key has no Decisions access.
const DEFAULTS = { apiKey: "", model: "gpt-6-luna", fallbackModel: "gpt-5.4-mini", threshold: 0.7, mode: "hide", enabled: true };

const LABELS = {
  crypto_scam: "Crypto / giveaway / investment promo",
  adult_spam: "Adult or 'check my bio' bait",
  engagement_bait: "Generic engagement-farming reply",
  ai_filler: "AI-generated filler",
  promo_spam: "Unrelated promo / copy-paste spam"
};
const CHOICES = [
  { value: "human", description: "Genuine person engaging with the post" },
  { value: "crypto_scam", description: "Crypto, airdrop, giveaway, trading or investment promotion" },
  { value: "adult_spam", description: "Adult/dating bait, check my bio, DM me" },
  { value: "engagement_bait", description: "Generic praise or reaction that ignores the post's specifics, e.g. Great post!, So true 🔥, Amazing!" },
  { value: "ai_filler", description: "AI-generated filler that just restates the post in polished generic language" },
  { value: "promo_spam", description: "Unrelated self-promotion, links, follow-for-follow, copy-paste text" }
];
const DECISION_INSTRUCTIONS = "Classify the reply. Short, rude, joking or opinionated on-topic replies are human. Pick a bot category only when the reply shows clear bot/spam signals.";
let decisionsUnavailable = false;

async function decideOne(s, post, r) {
  const who = `${r.author?.name || ""} ${r.author?.handle || ""}${r.author?.verified ? " (verified)" : ""}`.trim();
  const res = await fetch("https://api.openai.com/v1/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      input: `Original post on X${post?.author?.handle ? " by " + post.author.handle : ""}:\n${post?.text || "(unknown)"}\n\nReply from ${who}:\n${r.text}`,
      questions: [{ type: "choice", name: "kind", instructions: DECISION_INSTRUCTIONS, choices: CHOICES }]
    })
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(data?.error?.message || `OpenAI HTTP ${res.status}`); e.status = res.status; throw e; }
  const a = data.answers[0];
  const human = a.probabilities.find(p => p.value === "human")?.probability ?? 0;
  return { id: r.id, bot_score: +(1 - human).toFixed(3), reason: LABELS[a.choice] || "Looks human", category: a.choice };
}

async function classifyWithDecisions(s, post, replies) {
  const out = [];
  for (let i = 0; i < replies.length; i += 6) // ~150ms each, 6 in parallel
    out.push(...await Promise.all(replies.slice(i, i + 6).map(r => decideOne(s, post, r))));
  return out;
}

const SYSTEM_PROMPT = `You moderate replies on X (Twitter). For each reply decide whether it was most likely written by a bot, spam account, or automated/engagement-farming account.
Strong bot signals: crypto/giveaway/airdrop/investment promotion; "check my bio/profile/pinned", DM-me, OnlyFans/adult links; generic praise that ignores the post ("Great post!", "So true 🔥", "This is insightful"); obvious AI-generated filler that restates the post; emoji-only or hashtag spam; copy-paste text unrelated to the conversation; handles like name+long digit strings combined with the above.
Do NOT flag: short but on-topic human replies, jokes, disagreement, rudeness, typos, slang, or opinions you dislike. When unsure, give a low score.
Return one result per reply id with bot_score from 0 (human) to 1 (certainly bot) and a very short reason.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: { results: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "bot_score", "reason"],
    properties: { id: { type: "string" }, bot_score: { type: "number" }, reason: { type: "string" } }
  } } }
};

async function getSettings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }; }

async function classify(post, replies) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error("No OpenAI API key set (open the extension options).");
  if (!decisionsUnavailable) {
    try { return { verdicts: await classifyWithDecisions(s, post, replies), threshold: s.threshold, mode: s.mode, engine: "decisions" }; }
    catch (e) { if (e.status !== 403 && e.status !== 404) throw e; decisionsUnavailable = true; console.warn("Decisions API unavailable, falling back:", e.message); }
  }
  return classifyWithResponses(s, post, replies);
}

async function classifyWithResponses(s, post, replies) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.fallbackModel,
      instructions: SYSTEM_PROMPT,
      input: JSON.stringify({ original_post: post || null, replies }),
      text: { format: { type: "json_schema", name: "bot_verdicts", schema: SCHEMA, strict: true } }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);
  const text = data.output_text ?? data.output?.flatMap(o => o.content || []).find(c => c.type === "output_text")?.text;
  return { verdicts: JSON.parse(text).results, threshold: s.threshold, mode: s.mode, engine: "responses" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "classify") {
    classify(msg.post, msg.replies).then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "settings") { getSettings().then(s => sendResponse({ enabled: s.enabled, mode: s.mode, hasKey: !!s.apiKey })); return true; }
});
