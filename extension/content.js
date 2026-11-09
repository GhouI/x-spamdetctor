// Content script for x.com: finds replies on a post page, sends them for classification, hides bots.
(() => {
  const seen = new Map();      // tweetId -> verdict | "pending"
  let queue = [];
  let timer = null;
  let stats = { checked: 0, hidden: 0 };

  const tweetId = a => a.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href")?.match(/status\/(\d+)/)?.[1];
  const focalId = () => location.pathname.match(/\/status\/(\d+)/)?.[1];
  const textOf = a => a.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
  const authorOf = a => {
    const el = a.querySelector('[data-testid="User-Name"]');
    if (!el) return { name: "", handle: "" };
    const handle = [...el.querySelectorAll("span")].map(s => s.textContent).find(t => t.startsWith("@")) || "";
    return { name: el.querySelector("span")?.textContent || "", handle, verified: !!el.querySelector('[data-testid="icon-verified"]') };
  };

  function badge() {
    let b = document.getElementById("xbf-badge");
    if (!b) { b = document.createElement("div"); b.id = "xbf-badge"; document.body.appendChild(b); }
    b.textContent = `🤖 bot filter: ${stats.hidden} hidden / ${stats.checked} checked`;
    return b;
  }

  function apply(article, v, mode) {
    article.dataset.xbfScore = v.bot_score;
    const cell = article.closest('[data-testid="cellInnerDiv"]') || article;
    cell.classList.add(mode === "blur" ? "xbf-blur" : "xbf-hidden");
    const note = document.createElement("div");
    note.className = "xbf-note";
    note.innerHTML = `🤖 Likely bot reply hidden (${Math.round(v.bot_score * 100)}%) — <span></span> <button>Show</button>`;
    note.querySelector("span").textContent = v.reason;
    note.querySelector("button").onclick = e => {
      e.stopPropagation(); cell.classList.remove("xbf-hidden", "xbf-blur"); note.remove();
    };
    cell.parentNode.insertBefore(note, cell);
    stats.hidden++;
  }

  function scan() {
    const focal = focalId();
    if (!focal) return;                       // only act on post/reply pages
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = tweetId(a);
      if (!id || id === focal || seen.has(id)) continue;
      const text = textOf(a);
      seen.set(id, "pending");
      queue.push({ id, el: a, author: authorOf(a), text: text || "[no text / media only]" });
    }
    if (queue.length) { clearTimeout(timer); timer = setTimeout(flush, 700); }
  }

  async function flush() {
    const batch = queue.splice(0, 20);
    if (queue.length) timer = setTimeout(flush, 700);
    if (!batch.length) return;
    const focalArticle = [...document.querySelectorAll('article[data-testid="tweet"]')].find(a => tweetId(a) === focalId());
    const post = focalArticle ? { author: authorOf(focalArticle), text: textOf(focalArticle) } : null;
    const resp = await chrome.runtime.sendMessage({
      type: "classify", post,
      replies: batch.map(({ id, author, text }) => ({ id, author, text }))
    });
    if (!resp?.ok) { console.warn("[xbf]", resp?.error); badge().textContent = "🤖 bot filter error: " + resp?.error; batch.forEach(b => seen.delete(b.id)); return; }
    stats.checked += batch.length;
    for (const v of resp.verdicts) {
      const item = batch.find(b => b.id === v.id);
      if (!item) continue;
      seen.set(v.id, v);
      console.debug("[xbf]", v.id, v.bot_score, v.reason, item.text.slice(0, 80));
      if (v.bot_score >= resp.threshold) apply(item.el, v, resp.mode);
    }
    badge();
  }

  chrome.runtime.sendMessage({ type: "settings" }).then(s => {
    if (!s?.enabled) return;
    new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    scan();
  });
})();
