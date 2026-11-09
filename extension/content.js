// Content script (isolated world) for x.com.
// Primary path: inject.js (page world) forwards X's TweetDetail network responses, so replies are
// classified with full author metadata *before* X renders them. Fallback path: any reply that shows
// up in the DOM without network data is classified from its rendered text.
// X virtualizes the timeline (reply nodes are destroyed/recreated while scrolling), so verdicts are
// kept by tweet id and re-applied to whichever article currently shows that tweet.
(() => {
  const meta = new Map();      // tweetId -> tweet data from the network (text, user metadata, replyTo)
  const verdicts = new Map();  // tweetId -> verdict | "pending"
  const pendingSince = new Map();
  const flagged = new Set();
  const revealed = new Set();
  let cfg = { threshold: 0.7, mode: "hide" };
  let enabled = false;
  let queue = [];
  let timer = null;
  let checked = 0;
  const PENDING_MAX_MS = 4000;   // never keep a reply invisible longer than this while waiting

  const tweetId = a => a.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href")?.match(/status\/(\d+)/)?.[1];
  const focalId = () => location.pathname.match(/\/status\/(\d+)/)?.[1];
  const textOf = a => a.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
  const domAuthor = a => {
    const el = a.querySelector('[data-testid="User-Name"]');
    if (!el) return { name: "", handle: "" };
    const handle = [...el.querySelectorAll("span")].map(s => s.textContent).find(t => t.startsWith("@")) || "";
    return { name: el.querySelector("span")?.textContent || "", handle, premium: !!el.querySelector('[data-testid="icon-verified"]') };
  };
  const articles = () => document.querySelectorAll('article[data-testid="tweet"]');

  function badge(text) {
    if (!document.body) return;
    let b = document.getElementById("xbf-badge");
    if (!b) { b = document.createElement("div"); b.id = "xbf-badge"; document.body.appendChild(b); }
    b.textContent = text || `🤖 bot filter: ${flagged.size} hidden / ${checked} checked`;
  }

  // Ids that are the focal post or its ancestors (context, not replies to judge).
  function contextIds(focal) {
    const ids = new Set([focal]);
    for (let id = meta.get(focal)?.replyTo; id && !ids.has(id); id = meta.get(id)?.replyTo) ids.add(id);
    return ids;
  }

  function postContext(focal) {
    const m = meta.get(focal);
    if (m) return { author: m.user, text: m.text };
    const fa = [...articles()].find(a => tweetId(a) === focal);
    return fa ? { author: domAuthor(fa), text: textOf(fa) } : null;
  }

  function enqueue(item) {
    verdicts.set(item.id, "pending");
    pendingSince.set(item.id, Date.now());
    queue.push(item);
    clearTimeout(timer);
    timer = setTimeout(flush, item.source === "network" ? 30 : 400);
  }

  // Network path: called with tweets parsed from a TweetDetail response, before they render.
  function onNetwork({ focal, tweets }) {
    for (const t of tweets) if (!meta.has(t.id) || !meta.get(t.id).user) meta.set(t.id, t);
    if (!enabled || !focal) return;
    const ctx = contextIds(focal);
    const postAuthor = meta.get(focal)?.user?.id;
    const conv = meta.get(focal)?.conversationId;
    for (const t of tweets) {
      if (ctx.has(t.id) || verdicts.has(t.id)) continue;
      if (conv && t.conversationId !== conv) continue;                      // quoted posts etc.
      if (postAuthor && t.user?.id === postAuthor) { verdicts.set(t.id, { bot_score: 0, reason: "post author" }); continue; }
      enqueue({ id: t.id, focal, source: "network", author: t.user, text: t.text || (t.hasMedia ? "[media only]" : "[no text]") });
    }
    scan();
  }

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

  // Applies verdicts to rendered articles, keeps pending ones invisible, and picks up any reply
  // that has no network data (DOM fallback).
  function scan() {
    if (!enabled) return;
    const focal = focalId();
    if (!focal) return;
    const ctx = contextIds(focal);
    const postAuthorHandle = meta.get(focal)?.user?.handle || (() => {
      const fa = [...articles()].find(a => tweetId(a) === focal); return fa ? domAuthor(fa).handle : "";
    })();
    const now = Date.now();
    for (const a of articles()) {
      const id = tweetId(a);
      if (!id || ctx.has(id)) continue;
      const v = verdicts.get(id);
      if (v === "pending") {
        const waited = now - (pendingSince.get(id) || now);
        a.classList.toggle("xbf-pending", waited < PENDING_MAX_MS);
        continue;
      }
      a.classList.remove("xbf-pending");
      if (v) { if (flagged.has(id)) apply(a, id, v); continue; }
      const author = domAuthor(a);
      if (postAuthorHandle && author.handle === postAuthorHandle) { verdicts.set(id, { bot_score: 0, reason: "post author" }); continue; }
      const m = meta.get(id);
      enqueue(m
        ? { id, focal, source: "network", author: m.user, text: m.text || "[media only]" }
        : { id, focal, source: "dom", author, text: textOf(a) || "[no text / media only]" });
      a.classList.add("xbf-pending");
    }
  }

  async function flush() {
    const batch = queue.splice(0, 20);
    if (queue.length) timer = setTimeout(flush, 30);
    if (!batch.length) return;
    const groups = new Map();                      // one request per focal post (post context differs)
    for (const b of batch) (groups.get(b.focal) || groups.set(b.focal, []).get(b.focal)).push(b);
    await Promise.all([...groups].map(([focal, items]) => classify(focal, items)));
    scan();
    badge();
  }

  async function classify(focal, items) {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "classify", post: postContext(focal),
        replies: items.map(({ id, author, text }) => ({ id, author, text }))
      });
    } catch (e) { resp = { ok: false, error: String(e) }; }
    if (!resp?.ok) {
      console.warn("[xbf]", resp?.error);
      badge("🤖 bot filter error: " + resp?.error);
      items.forEach(b => verdicts.set(b.id, { bot_score: 0, reason: "error" }));
      return;
    }
    cfg = { threshold: resp.threshold, mode: resp.mode };
    for (const v of resp.verdicts) {
      if (verdicts.get(v.id) !== "pending" || !items.some(b => b.id === v.id)) continue;
      verdicts.set(v.id, v);
      checked++;
      if (v.bot_score >= cfg.threshold) flagged.add(v.id);
      console.debug("[xbf]", v.id, v.bot_score, v.reason);
    }
    // A reply the model returned no verdict for is left visible (never re-sent, to avoid request loops).
    items.forEach(b => { if (verdicts.get(b.id) === "pending") verdicts.set(b.id, { bot_score: 0, reason: "no verdict" }); });
  }

  window.addEventListener("message", e => {
    if (e.source !== window || e.data?.source !== "xbf-net" || !Array.isArray(e.data.tweets)) return;
    onNetwork(e.data);
  });

  chrome.runtime.sendMessage({ type: "settings" }).then(s => {
    enabled = !!s?.enabled;
    if (s?.mode) cfg.mode = s.mode;
    if (s?.threshold) cfg.threshold = s.threshold;
    window.postMessage({ source: "xbf-content", type: "ready" }, location.origin);  // inject.js flushes its buffer
    if (!enabled) return;
    new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 1000);   // releases replies whose pending window expired
    scan();
  });
})();
