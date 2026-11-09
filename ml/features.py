"""Feature extraction for X reply bot detection.

Input: the harvested dataset (eval/data/dataset2.json): {"posts": {focal: {...}}, "replies": [...]}.
Output: a float32 matrix of hand-crafted features per reply, plus names. Kept dependency-free
(numpy only) so the exact same math can be ported to the extension's JavaScript.
"""
import math
import re
from datetime import datetime

import numpy as np

URL = re.compile(r"https?://\S+")
BIO_KW = re.compile(r"crypto|web3|nft|\$[A-Z]{2,}|\bdm\b|telegram|whatsapp|t\.me|onlyfans|link in bio|ambassador|\bkol\b|alpha|airdrop|0x[0-9a-f]{6}|\bca:", re.I)
NONLAT = re.compile(r"[一-鿿぀-ヿЀ-ӿ가-힯؀-ۿ]")
TS_FMT = "%a %b %d %H:%M:%S %z %Y"


def ts(s):
    return datetime.strptime(s, TS_FMT).timestamp() if s else None


def lg(x):
    return math.log10(1 + max(0.0, float(x or 0)))


def text_only(t):
    return URL.sub("", t or "").strip()


def clean(t):
    t = re.sub(r"@\w+", "", text_only(t)).lower()
    return re.sub(r"[\W_]+", "", t)


def shingles(t, n=3):
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def thread_features(replies):
    """Near-duplicate similarity (char 3-gram Jaccard vs other authors) and replies-per-author, per thread."""
    by_thread = {}
    for r in replies:
        by_thread.setdefault(r["focal"], []).append(r)
    near, count = {}, {}
    for rs in by_thread.values():
        sh = [(r, shingles(clean(r["text"]))) for r in rs]
        per_author = {}
        for r in rs:
            per_author[r["user"]["id"]] = per_author.get(r["user"]["id"], 0) + 1
        for r, a in sh:
            count[r["id"]] = per_author[r["user"]["id"]]
            best = 0.0
            if len(a) >= 8:
                for r2, b in sh:
                    if r2 is not r and r2["user"]["id"] != r["user"]["id"] and len(b) >= 8:
                        inter = len(a & b)
                        if inter:
                            best = max(best, inter / (len(a) + len(b) - inter))
            near[r["id"]] = best
    return near, count


def account_summary(u, now):
    """Same author line the extension sends to the Decisions API (background.js describeAuthor)."""
    created = ts(u.get("createdAt"))
    parts = [f"{u.get('name', '')} {u.get('handle', '')}".strip()]
    if created:
        days = max(1.0, (now - created) / 86400)
        age = f"{round(days)} days" if days < 60 else f"{round(days / 30)} months" if days < 730 else f"{days / 365:.1f} years"
        parts.append(f"account created {datetime.utcfromtimestamp(created).date()} ({age} old)")
        parts.append(f"{u.get('posts', 0):,} posts (~{round(u.get('posts', 0) / days)}/day)")
    parts.append(f"{u.get('followers', 0):,} followers, {u.get('following', 0):,} following")
    parts.append(f"paid checkmark: {'yes' if u.get('premium') else 'no'}")
    if u.get("defaultAvatar"):
        parts.append("default profile picture")
    parts.append(f'bio: "{" ".join((u.get("bio") or "").split())}"' if u.get("bio") else "empty bio")
    return "; ".join(parts)


def features(data, now=None):
    posts, replies = data["posts"], data["replies"]
    now = now or ts(max(r["createdAt"] for r in replies if r.get("createdAt")))
    near, count = thread_features(replies)
    names, rows = None, []
    for r in replies:
        u, p = r["user"], posts.get(r["focal"], {})
        created = ts(u.get("createdAt")) or now
        days = max(1.0, (now - created) / 86400)
        posts_n = u.get("posts") or 0
        t = text_only(r["text"])
        delay = None
        if r.get("createdAt") and p.get("createdAt"):
            delay = max(1.0, ts(r["createdAt"]) - ts(p["createdAt"]))
        f = {
            "log_followers": lg(u.get("followers")),
            "log_following": lg(u.get("following")),
            "log_ratio": lg(u.get("followers")) - lg(u.get("following")),
            "followback": 1.0 if u.get("following", 0) > 1000 and 0.5 < (u.get("followers", 0) / max(1, u.get("following", 1))) < 2 else 0.0,
            "log_posts_day": lg(posts_n / days),
            "log_age_days": lg(days),
            "log_likes_given_day": lg((u.get("likesGiven") or 0) / days),
            "likes_per_post": lg((u.get("likesGiven") or 0) / max(1, posts_n)),
            "media_share": (u.get("mediaPosts") or 0) / max(1, posts_n),
            "default_avatar": float(bool(u.get("defaultAvatar"))),
            "empty_bio": float(not u.get("bio")),
            "bio_keywords": float(bool(BIO_KW.search(u.get("bio") or ""))),
            "premium": float(bool(u.get("premium"))),
            "verified_org": float(bool(u.get("verified"))),
            "has_website": float(bool(u.get("website"))),
            "has_banner": float(bool(u.get("banner"))),
            "has_location": float(bool(u.get("location"))),
            "pro_business": float(u.get("pro") == "Business"),
            "pro_creator": float(u.get("pro") == "Creator"),
            "handle_digits": float(bool(re.search(r"\d{5,}$", u.get("handle") or ""))),
            "link_only": float(not t and bool(URL.search(r["text"] or ""))),
            "has_link": float(bool(URL.search(r["text"] or ""))),
            "log_text_len": lg(len(t)),
            "media": float(bool(r.get("media"))),
            "log_reply_likes": lg(r.get("likes")),
            "likes_vs_followers": lg(r.get("likes")) - lg(u.get("followers")),
            "log_reply_views": lg(r.get("views")),
            "lang_mismatch": float(bool(r.get("lang") and p.get("lang") and r["lang"] not in (p["lang"], "und", "zxx", "qme", "art") and p["lang"] not in ("und", "zxx", "qme", "art"))),
            "nonlatin": float(bool(NONLAT.search(r["text"] or ""))),
            "log_delay_s": lg(delay) if delay else 3.5,
            "fast_reply": float(delay is not None and delay < 120),
            "near_dup": near[r["id"]],
            "author_replies": min(count[r["id"]], 5),
            "big_account": float((u.get("followers") or 0) >= 50000),
        }
        names = names or list(f)
        rows.append([f[k] for k in names])
    return np.asarray(rows, dtype=np.float32), names
