# Latency: Decisions API vs Responses API

Date: 2026-11-09 · Script: `test/bench-latency.mjs` · 117 API calls total, 0 × 429, 0 errors.

## Summary

| Endpoint | Model | p50 | p90 | mean | Notes |
|---|---|---|---|---|---|
| `/v1/decisions` sequential | gpt-6-luna | 144 ms | 273 ms | 187 ms | 29 warm calls; server time (`openai-processing-ms`) p50 90 ms; cold first call 922 ms |
| `/v1/decisions` 6 concurrent | gpt-6-luna | 161 ms | 194 ms | 177 ms | 3 batches; batch wall time 422 / 185 / 182 ms (the first opens new connections) |
| `/v1/decisions` 20 concurrent | gpt-6-luna | 250 ms | 520 ms | 302 ms | 1 batch, 558 ms wall; server p50 still 81 ms, so the extra time is client/network (new sockets) |
| `/v1/decisions` short input (~60 chars) | gpt-6-luna | 144 ms | 198 ms | 151 ms | 242 input tokens |
| `/v1/decisions` long input (~1870 chars) | gpt-6-luna | 141 ms | 201 ms | 153 ms | 598 input tokens; no measurable difference |
| `/v1/decisions` 1 question | gpt-6-luna | 126 ms | 158 ms | 131 ms | server mean 73 ms |
| `/v1/decisions` 2 questions (choice+predicate) | gpt-6-luna | 152 ms | 174 ms | 157 ms | about 25–35 ms more server time |
| `/v1/responses` json_schema strict | gpt-5.4-mini | 962 ms | 1190 ms | 989 ms | `reasoning.effort: "none"` accepted; 14 output tokens |
| `/v1/responses` json_schema strict | gpt-6-luna | 954 ms | 1151 ms | 978 ms | accepted on Responses, effort `none`; same model, same task |

The Decisions answers matched the expected label for all 12 samples (6 human, 6 spam or bot types). Usage reports `output_tokens: 0`.

## Method

- Node 22 global `fetch` (undici keep-alive). Client time is `performance.now()` measured from just before `fetch` until the JSON body is parsed.
- Server time comes from the `openai-processing-ms` response header. "Network+queue" is client time minus server time, about 55–80 ms p50 in this run.
- Input: 12 realistic X post/reply pairs (6 human, 6 bot or spam: crypto, adult, engagement bait, AI filler, promo) in the `Original post on X / Reply from @handle` format.
- Decisions request: the known `choice` question with 6 categories. The predicate question is `is_bot`.
- Responses baseline: the same instructions and categories as the system `instructions`, with `text.format` set to strict `json_schema` `{kind: enum[6]}`, `store: false`, and the lowest reasoning effort (`none`, accepted by both models).
- Percentiles use nearest rank. With n=5–29, p90 and p99 are close to the maximum.

## Caveats

- Everything was measured from one home connection in one region, in one run on one evening. Results will vary by location, time of day and account tier.
- The samples are small (5–29 calls per row), so the tail figures (p90/p99) are rough.
- The Decisions API is undocumented. Its behaviour, latency and pricing may change.
- The 20-concurrent row mostly measures opening extra TLS connections on the client. Server time stayed flat.
