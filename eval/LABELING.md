# Labelling guide: bot replies on X

Each row is one reply to a post on X:

`index|@handle|account age|posts per day|followers/following|✓ (paid checkmark)|EGG (default avatar)|bio|> reply text [+media]`

The post being replied to is shown at the top of each batch. Give each row exactly one label:

| Label | Meaning |
|---|---|
| `b` (bot / spam) | Automated, spam or engagement-farming account, or a commercial or scam reply. |
| `l` (low-quality human) | A real person posting something low-effort: one word, emoji, "Amazing", off-topic, another language, a link or meme with no context, rude. |
| `h` (human) | A real person engaging with the post: a specific opinion, question, joke, disagreement or story. |
| `u` (unsure) | You can't tell. Use this sparingly; it is excluded from scoring. |

## Signals that mean `b`
- **Token or project shilling:** `$TICKER`, contract addresses (`0x…`, `solana:…`), "Booelieve", promoting an unrelated coin, project, product or merch, "check my pinned", Telegram or WhatsApp handles.
- **Link-only promo** from brand, media or promo accounts, or from very high-volume accounts.
- **Engagement farming:** generic praise or reaction ("Insightful", "Interesting perspective on X", "Very insightful indeed", "Wow", "🔥🔥🔥") from an account posting **> ~100 posts/day**, or with large follow-back counts (followers ≈ following, both in the thousands), or with a crypto/KOL/"ambassador" bio.
- **AI reply-guy filler:** fluent text that only restates the post ("This is an important shift…", "Focusing on ETH as a store of value is a strong argument."), template openers ("This lands.", "Strong framing.", "The useful part of X isn't Y. It's Z."), and anything that reads like model output ("Acknowledges a perspective or idea presented."). Lean towards `b` when the account is new, high-volume, follow-back-shaped or a brand/promo account. If the account looks like an ordinary established person, use `u`.
- **Accounts that say they are automated** ("automated account", "bot", "AI crew runs the show").
- **Begging or scam openers:** donation pleas, "could I have your support?", "whenever an intelligent person like you speaks…", "已回关" (follow-back farming).
- **Off-topic copy-paste:** unrelated news or sports updates, random "fun facts" with no link to the post.

## Signals that mean `l` or `h`, not `b`
- **Short or rude replies** from ordinary accounts (normal posting rate, real bio, normal follower ratio) are `l`, not `b`. Examples: "Amazing", "Wow", "YES", "Fuck u", "牛逼".
- **On-topic opinion, disagreement, questions and jokes** are `h`, however short, angry or badly written.
- **Off-topic political or personal rants and other languages** from ordinary accounts are `l`.
- **A paid checkmark is not evidence either way.** Most replies have one.
- **Big follower counts are not proof of a human.** Engagement farms and link promoters with 50k+ followers exist.

Be consistent. When the text is generic, the account stats decide. When the text is specific and engaged, it is human unless it is promotion.
