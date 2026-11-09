// Embeds every reply text and author bio in eval/data/dataset2.json with text-embedding-3-small.
// Writes eval/data/emb2.json cache {id: {reply:[...], bio:[...]}} and eval/data/emb2.npz-ready arrays via ml/to_npz.py.
// Usage: OPENAI_API_KEY=... node ml/embed.mjs
import fs from "fs";

const D = new URL("../eval/data/", import.meta.url);
const KEY = process.env.OPENAI_API_KEY;
const data = JSON.parse(fs.readFileSync(new URL("dataset2.json", D)));
const cacheF = new URL("emb2-cache.json", D);
const cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF)) : {};

async function embed(texts) {
  for (let t = 0; ; t++) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
    });
    const j = await res.json();
    if (res.ok) return j.data.map(d => d.embedding.map(x => +x.toFixed(5)));
    if (t < 4 && (res.status === 429 || res.status >= 500)) { await new Promise(r => setTimeout(r, 1000 * 2 ** t)); continue; }
    throw new Error(j.error?.message);
  }
}

const todo = data.replies.filter(r => !cache[r.id]);
console.log(`${todo.length} replies to embed`);
for (let i = 0; i < todo.length; i += 100) {
  const b = todo.slice(i, i + 100);
  const [rep, bio] = await Promise.all([
    embed(b.map(r => (r.text || "").trim() || "[media only]")),
    embed(b.map(r => `${r.user.name || ""} ${r.user.handle}: ${r.user.bio || "(empty bio)"}`))
  ]);
  b.forEach((r, k) => cache[r.id] = { reply: rep[k], bio: bio[k] });
  if (i % 1000 === 0) fs.writeFileSync(cacheF, JSON.stringify(cache));
}
fs.writeFileSync(cacheF, JSON.stringify(cache));
console.log("done", Object.keys(cache).length);
