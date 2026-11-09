# x-spamdetctor

Chrome/Chromium extension (Manifest V3) that detects bot and spam replies on X and hides them, using the **OpenAI Decisions API**.

## How it works

1. On any post page (`x.com/<user>/status/<id>`), `content.js` collects each reply's author and text.
2. `background.js` sends each reply, along with the original post for context, to `POST https://api.openai.com/v1/decisions` (model `gpt-6-luna`) as a `choice` question with these categories:
   `human`, `crypto_scam`, `adult_spam`, `engagement_bait`, `ai_filler`, `promo_spam`.
3. Bot score = `1 − P(human)`. Replies at or above the threshold (default **0.7**) are hidden. Each hidden reply gets a one-line note with its reason and a **Show** button.
4. If the API key has no Decisions access (HTTP 403/404), the extension falls back to the Responses API with structured JSON output (`gpt-5.4-mini`).

A badge in the bottom-left corner shows `hidden / checked`.

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

1. Open `chrome://extensions` (or the same page in Helium), turn on **Developer mode**, click **Load unpacked**, and select `extension/`.
2. Click the extension icon, paste your OpenAI API key, and click **Save**. The key is stored only in `chrome.storage.local`.
3. Open any X post. Bot replies collapse automatically.

Options: enabled toggle, Decisions model, hide threshold, and hide or blur mode.

## Test

```sh
OPENAI_API_KEY=sk-... node test/classify-samples.mjs
```
This runs `background.js` in Node against 6 labelled sample replies (2 human, 4 bot). It exits with a non-zero code if any are misclassified.
