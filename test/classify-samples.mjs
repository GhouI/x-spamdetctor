// Runs extension/background.js outside the browser against sample replies.
// Usage: OPENAI_API_KEY=sk-... node test/classify-samples.mjs
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("Set OPENAI_API_KEY"); process.exit(1); }

let handler;
globalThis.chrome = {
  storage: { local: { get: async () => ({ apiKey: key }) } },
  runtime: { onMessage: { addListener: h => (handler = h) } }
};
await import(new URL("../extension/background.js", import.meta.url));

const post = { text: "We cut our CI build time by 60% just by enabling remote caching." };
const replies = [
  { id: "1", expect: "human", author: { handle: "@sarah_codes" }, text: "Tried this on our monorepo, build went from 4m to 90s. Did you need to change the cache config?" },
  { id: "2", expect: "bot", author: { handle: "@crypto_king84729361" }, text: "🚀 Huge $SOL airdrop live now! Claim yours before it ends 👉 check my pinned" },
  { id: "3", expect: "bot", author: { handle: "@emily39201847" }, text: "Great post! Very insightful 🔥🔥" },
  { id: "4", expect: "human", author: { handle: "@dev_mike" }, text: "lol no way this works in prod" },
  { id: "5", expect: "bot", author: { handle: "@jessica_x88291" }, text: "Hey 😘 lonely tonight? Check my bio 💋" },
  { id: "6", expect: "bot", author: { handle: "@insight_daily_ai" }, text: "This is a great point about build performance. Optimizing caching strategies can significantly improve developer productivity and reduce costs." }
];

handler({ type: "classify", post, replies }, {}, r => {
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log("engine:", r.engine);
  let fails = 0;
  for (const v of r.verdicts) {
    const rep = replies.find(x => x.id === v.id);
    const got = v.bot_score >= r.threshold ? "bot" : "human";
    if (got !== rep.expect) fails++;
    console.log(got === rep.expect ? "PASS" : "FAIL", got.padEnd(5), v.bot_score.toFixed(2), v.reason, "|", rep.text.slice(0, 50));
  }
  process.exit(fails ? 1 : 0);
});
