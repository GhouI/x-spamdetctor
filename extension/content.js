// Content script for x.com: finds replies on a post page, sends them for classification, hides bots.
// X virtualizes the timeline (reply DOM nodes are destroyed/recreated while scrolling), so verdicts are
// kept by tweet id and re-applied to whatever article node currently shows that tweet.
(() => {
  const verdicts = new Map();  // tweetId -> verdict | "pending"
  const flagged = new Set();   // tweetIds at/above threshold
  const revealed = new Set();  // tweetIds the user chose to show
  let cfg = { threshold: 0.7, mode: "hide" };
  let queue = [];
  let timer = null;
  let checked = 0;

  const tweetId = a => a.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href")?.match(/status\/(\d+)/)?.[1];
  const focalId = () => location.pathname.match(/\/status\/(\d+)/)?.[1];
  const textOf = a => a.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
  const authorOf = a => {
    const el = a.querySelector('[data-testid="User-Name"]');
    if (!el) return { name: "", handle: "" };
    const handle = [...el.querySelectorAll("span")].map(s => s.textContent).find(t => t.startsWith("@")) || "";
    return { name: el.querySelector("span")?.textContent || "", handle, verified: !!el.querySelector('[data-testid="icon-verified"]') };
  };
  const articles = () => document.querySelectorAll('article[data-testid="tweet"]');
  const focalArticle = () => [...articles()].find(a => tweetId(a) === focalId());

  function badge(text) {
    let b = document.getElementById("xbf-badge");
    if (!b) { b = document.createElement("div"); b.id = "xbf-badge"; document.body.appendChild(b); }
    b.textContent = text || `🤖 bot filter: ${flagged.size} hidden / ${checked} checked`;
  }

  // Hide one rendered article. The note goes inside the same parent (inside X's list cell),
  // never as a sibling of the cell, so X's virtual-list layout is not disturbed.
  function apply(article, id, v) {
    if (!article.isConnected || article.dataset.xbfDone === id) return;
    article.dataset.xbfDone = id;
    if (revealed.has(id)) return;
    article.classList.add(cfg.mode === "blur" ? "xbf-blur" : "xbf-hidden");
    const note = document.createElement("div");
    note.className = "xbf-note";
    note.innerHTML = `🤖 Likely bot reply hidden (${Math.round(v.bot_score * 100)}%) — <span></span> <button>Show</button>`;
    note.querySelector("span").textContent = v.reason;
    note.querySelector("button").onclick = e => {
      e.preventDefault(); e.stopPropagation();
      revealed.add(id);
      article.classList.remove("xbf-hidden", "xbf-blur");
      note.remove();
    };
    article.parentNode?.insertBefore(note, article);
  }

  function scan() {
    const focal = focalId();
    if (!focal) return;                       // only act on post/reply pages
    const fa = focalArticle();
    const postAuthor = fa ? authorOf(fa).handle : "";
    for (const a of articles()) {
      const id = tweetId(a);
      if (!id || id === focal) continue;
      const v = verdicts.get(id);
      if (v && v !== "pending") { if (flagged.has(id)) apply(a, id, v); continue; }
      if (v === "pending") continue;
      const author = authorOf(a);
      if (postAuthor && author.handle === postAuthor) { verdicts.set(id, { bot_score: 0, reason: "post author" }); continue; }
      verdicts.set(id, "pending");
      queue.push({ id, author, text: textOf(a) || "[no text / media only]" });
    }
    if (queue.length) { clearTimeout(timer); timer = setTimeout(flush, 700); }
  }

  async function flush() {
    const batch = queue.splice(0, 20);
    if (queue.length) timer = setTimeout(flush, 700);
    if (!batch.length) return;
    const fa = focalArticle();
    const post = fa ? { author: authorOf(fa), text: textOf(fa) } : null;
    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "classify", post, replies: batch }); }
    catch (e) { resp = { ok: false, error: String(e) }; }
    if (!resp?.ok) {
      console.warn("[xbf]", resp?.error);
      badge("🤖 bot filter error: " + resp?.error);
      batch.forEach(b => verdicts.delete(b.id));
      return;
    }
    cfg = { threshold: resp.threshold, mode: resp.mode };
    for (const v of resp.verdicts) {
      if (verdicts.get(v.id) !== "pending" || !batch.some(b => b.id === v.id)) continue;
      verdicts.set(v.id, v);
      checked++;
      if (v.bot_score >= cfg.threshold) flagged.add(v.id);
      console.debug("[xbf]", v.id, v.bot_score, v.reason);
    }
    // A reply the model returned no verdict for is left visible (never re-sent, to avoid request loops).
    batch.forEach(b => { if (verdicts.get(b.id) === "pending") verdicts.set(b.id, { bot_score: 0, reason: "no verdict" }); });
    scan();   // applies verdicts to whatever nodes are currently rendered
    badge();
  }

  chrome.runtime.sendMessage({ type: "settings" }).then(s => {
    if (!s?.enabled) return;
    new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    scan();
  });
})();
