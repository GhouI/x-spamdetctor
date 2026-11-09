# x-spamdetctor

Chrome/Chromium extension (Manifest V3) that detects bot and spam replies on X and hides them, using the **OpenAI Decisions API**.

## How it works

**Network path (primary).** `extension/inject.js` runs in the page's own JS world at `document_start` and wraps `fetch`/`XMLHttpRequest`. When X loads a post's replies (`/graphql/<id>/TweetDetail`, including "show more" pages), it parses the response — without modifying it — and forwards every reply with its author's account data to the content script:

| From X's response | Used as |
| --- | --- |
| `core.created_at`, `tweet_counts.tweets` | account age, posts/day |
| `relationship_counts.followers/following` | follow-back farming signal |
| `profile_bio`, `avatar.image_url` | empty bio / default avatar |
| `is_blue_verified` | paid checkmark (explicitly *not* proof of a human) |

So replies are classified **before X renders them**. A reply that renders while its verdict is still pending is kept invisible (`opacity: 0`, max 4 s), so a bot reply is never readable for a moment.

**DOM fallback.** Any reply that appears without network data (e.g. X changes its API) is read from the rendered page (text + handle) and classified the old way.

**Classification.** `extension/background.js` sends each reply — post text, author summary (e.g. `account created 2025-01-15 (10 months old); 198,344 posts (~688/day); 19,045 followers, 19,791 following; paid checkmark: no; bio: "..."`) and reply text — to `POST https://api.openai.com/v1/decisions` (model `gpt-6-luna`) as a `choice` question: `human`, `crypto_scam`, `adult_spam`, `engagement_bait`, `ai_filler`, `promo_spam`, `automated_account`. Bot score = `1 − P(human)`; replies at or above the threshold (default **0.7**) are hidden with a one-line reason and a **Show** button. Up to 10 requests run in parallel. If the key has no Decisions access (HTTP 403/404) it falls back to the Responses API (`gpt-5.4-mini`, structured JSON).

X virtualizes the reply list (nodes are destroyed and recreated while scrolling), so verdicts are stored by tweet id and re-applied whenever a reply is re-rendered. The post author's own thread replies are never classified. A badge (bottom-left) shows `hidden / checked`.

### Decisions API request shape (worked out from the API's error messages; no public docs yet)

```json
{
  "model": "gpt-6-luna",
  "input": "Original post on X: ...\n\nReply from @handle: ...",
  "questions": [{
    "type": "choice",                       // also: "predicate", "score" (score needs levels[] objects)
    "name": "kind",
    "instructions": "Classify the reply ...",
    "choices": [{ "value": "human", "description": "..." }, ...]
  }]
}
```
The response looks like `answers[0] = { choice, probabilities: [{ value, probability }], confidence }`. Each call takes about 130–300 ms.

## Install

1. Open `chrome://extensions` (or `helium://extensions`), turn on **Developer mode**, click **Load unpacked**, and select `extension/`.
2. Click the extension icon, paste your OpenAI API key, and click **Save**. The key is stored only in `chrome.storage.local`.
3. Open any X post. Bot replies collapse automatically.

Options: enabled toggle, Decisions model, hide threshold, and hide or blur mode.

## Test

```sh
OPENAI_API_KEY=sk-... node test/classify-samples.mjs
```
This runs `background.js` in Node against 6 labelled sample replies (2 human, 4 bot). It exits with a non-zero code if any are misclassified.
