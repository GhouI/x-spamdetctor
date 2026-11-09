// Runs the extension's real classifier (extension/background.js) on a thread saved as JSON.
// Usage: OPENAI_API_KEY=sk-... node test/classify-file.mjs thread.json
// thread.json: { "post": { "author": { "handle": "@op" }, "text": "..." },
//                "replies": [ { "author": { "name": "...", "handle": "@...", "verified": false }, "text": "..." } ] }
import { readFileSync } from "node:fs";

const key = process.env.OPENAI_API_KEY;
const file = process.argv[2];
if (!key || !file) { console.error("Usage: OPENAI_API_KEY=sk-... node test/classify-file.mjs thread.json"); process.exit(1); }

const { post, replies } = JSON.parse(readFileSync(file, "utf8"));
replies.forEach((r, i) => { r.id ??= String(i + 1); });

let handler;
globalThis.chrome = {
  storage: { local: { get: async () => ({ apiKey: key }) } },
  runtime: { onMessage: { addListener: h => (handler = h) } }
};
await import(new URL("../extension/background.js", import.meta.url));

handler({ type: "classify", post, replies }, {}, r => {
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`engine: ${r.engine}, hide threshold: ${r.threshold}\n`);
  for (const v of r.verdicts) {
    const rep = replies.find(x => x.id === v.id);
    const verdict = v.bot_score >= r.threshold ? "BOT  (hidden)" : "human";
    console.log(`#${v.id} ${verdict.padEnd(13)} ${v.bot_score.toFixed(2)}  ${(rep.author?.handle || "").padEnd(22)} ${v.reason}`);
    console.log(`    "${rep.text.replace(/\s+/g, " ").slice(0, 100)}"`);
  }
});
