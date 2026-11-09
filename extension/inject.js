// Runs in the PAGE's JS world (manifest "world": "MAIN") at document_start.
// Wraps fetch + XMLHttpRequest so we see X's TweetDetail GraphQL responses (the replies of a
// post, with full author metadata) BEFORE X renders them, and forwards a compact summary to
// the extension's content script via window.postMessage. Never modifies the responses.
(() => {
  if (window.__xbfHooked) return;
  window.__xbfHooked = true;

  const URL_RE = /\/graphql\/[^/?]+\/TweetDetail\b/;
  let ready = false;
  const buffer = [];

  function focalFromUrl(url) {
    try { return JSON.parse(new URL(url, location.href).searchParams.get("variables") || "{}").focalTweetId || null; }
    catch { return null; }
  }

  function userInfo(u) {
    if (!u) return null;
    const core = u.core || {}, legacy = u.legacy || {};
    const avatar = u.avatar?.image_url || legacy.profile_image_url_https || "";
    return {
      id: u.rest_id,
      handle: "@" + (core.screen_name || legacy.screen_name || ""),
      name: core.name || legacy.name || "",
      createdAt: core.created_at || legacy.created_at || null,
      followers: u.relationship_counts?.followers ?? legacy.followers_count ?? null,
      following: u.relationship_counts?.following ?? legacy.friends_count ?? null,
      posts: u.tweet_counts?.tweets ?? legacy.statuses_count ?? null,
      bio: (u.profile_bio?.description ?? legacy.description ?? "").slice(0, 300),
      website: !!(u.website?.url || legacy.url),
      premium: !!u.is_blue_verified,
      verified: !!(u.verification?.verified || legacy.verified),
      defaultAvatar: avatar.includes("default_profile_images") || legacy.default_profile_image === true,
      protected: !!(u.privacy?.protected ?? legacy.protected)
    };
  }

  function extract(json) {
    const out = new Map();
    (function walk(o, depth) {
      if (!o || typeof o !== "object" || depth > 60) return;
      if (o.__typename === "Tweet" && o.rest_id && o.legacy) {
        const l = o.legacy;
        let text = o.note_tweet?.note_tweet_results?.result?.text || l.full_text || "";
        if (!o.note_tweet && Array.isArray(l.display_text_range)) text = [...text].slice(l.display_text_range[0]).join("");
        text = text.replace(/^(@\w+\s+)+/, "").trim();
        if (!out.has(o.rest_id)) out.set(o.rest_id, {
          id: o.rest_id,
          text,
          lang: l.lang,
          conversationId: l.conversation_id_str,
          replyTo: l.in_reply_to_status_id_str || null,
          createdAt: l.created_at,
          hasMedia: !!l.entities?.media?.length,
          user: userInfo(o.core?.user_results?.result)
        });
      }
      for (const k in o) walk(o[k], depth + 1);
    })(json, 0);
    return [...out.values()];
  }

  function emit(url, json) {
    const tweets = extract(json);
    if (!tweets.length) return;
    const msg = { source: "xbf-net", focal: focalFromUrl(url), tweets };
    if (ready) window.postMessage(msg, location.origin); else buffer.push(msg);
  }

  window.addEventListener("message", e => {
    if (e.source !== window || e.data?.source !== "xbf-content" || e.data.type !== "ready") return;
    ready = true;
    buffer.splice(0).forEach(m => window.postMessage(m, location.origin));
  });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (URL_RE.test(url)) res.clone().json().then(j => emit(url, j)).catch(() => {});
    } catch {}
    return res;
  };

  const XHR = XMLHttpRequest.prototype, origOpen = XHR.open, origSend = XHR.send;
  XHR.open = function (method, url, ...rest) { this.__xbfUrl = String(url); return origOpen.call(this, method, url, ...rest); };
  XHR.send = function (...args) {
    if (URL_RE.test(this.__xbfUrl || "")) {
      this.addEventListener("load", () => {
        try {
          const body = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          emit(this.__xbfUrl, body);
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };
})();
