# Task: stream live rich-message drafts (private chats), native Stop button, collapsible tool transcripts

Paste this whole file as the prompt to a fresh Claude Code session opened in
`~/projects/telegram-bridge`. The user has already agreed to this exact design in conversation —
proceed directly to implementation, following this repo's own workflow in `CLAUDE.md` (branch →
tests → PR → fresh-agent `code-review` skill with `--comment` → iterate until clean → self-merge,
already authorized → restart the affected launchd bots).

## Context you need

This repo (`telegram-claude-bridge`) is a zero-dependency Node.js bridge between Telegram and the
`claude` CLI. It runs live, right now, as 8 separate launchd-managed bot processes the user
actively depends on (`com.tgbridge.tldr`, `ig`, `ig-ios`, `ig-invest-uni`, `outfit`,
`corpaidelegate`, `smm`, `clientsearch`). Be careful: this is not a toy project, it's production
infrastructure for a live human. Run `node --check bridge.mjs lib.mjs markdown-html.mjs` and the
full `node --test` suite before every commit, and restart every affected bot after merging
(`launchctl kickstart -k gui/$UID/com.tgbridge.<label>` for each label above).

Earlier today (same repo, same day), two things were already implemented and merged to `main`:

1. **PR #100/#102-ish: markdown table rendering** — `markdown-html.mjs` renders GFM pipe tables as
   monospace `<pre>` grids, used as the fallback path (see point 2).
2. **PR #101/#102: `sendRichMessage` support** — Telegram shipped a real Bot API 10.1 (June 2026)
   feature, **`sendRichMessage`**, which takes `rich_message: { markdown: <raw text> }` and lets
   Telegram's own server parse GFM-ish "Rich Markdown" into native structured blocks: real
   bordered/striped tables, headings, lists, blockquotes, code blocks, etc. — rendered natively by
   the Telegram client, not by us. `bridge.mjs`'s `sendReply` (around the `buildRichReplyCall`
   call, see `lib.mjs`) already tries `sendRichMessage`/`editMessageText+rich_message` first and
   falls back to the classic `sendMessage`+HTML-`parse_mode` pipeline on any failure. This is
   fully verified against the live API (not just docs) and merged. **You don't need to touch this
   part** — it's the foundation the new streaming feature builds on.

**What's still missing** (this task): the bridge's *streaming* UX — the "⏳ working…" placeholder
message that gets live-edited via repeated `editMessageText` calls roughly every 1.3s while
Claude thinks/calls tools (see `runClaudeTurn` in `bridge.mjs`, `createPlaceholderController`,
`buildWorkingPlaceholderParams`, `buildCancelKeyboard`, the whole `activeRuns` map) — still only
ever sends plain text, never rich content, and its Cancel button is a hand-rolled inline keyboard
tied to a `callback_query` handler.

## Verified Bot API 10.1 facts (fetched from raw `core.telegram.org/bots/api` HTML today, not
guessed — cross-checked against a Sept 2026 Wayback Machine snapshot to rule out doc tampering)

### `sendRichMessageDraft` — the streaming primitive

```
sendRichMessageDraft(
  chat_id: Integer,           // "Unique identifier for the target private chat" — PRIVATE CHATS ONLY
  message_thread_id?: Integer,
  draft_id: Integer,          // required, non-zero. Same id across calls = animated transition. Different id = hard replace, no animation.
  rich_message: InputRichMessage,  // same shape used by sendRichMessage already (markdown/html/blocks — pick one)
  can_stop?: Boolean,         // shows a native Stop button; bot receives Update "stopped_message_generation" if tapped
  keep_on_stop?: Boolean,     // if true, draft stays visible a bit after Stop is tapped instead of vanishing immediately
) -> True
```

Critical semantics (quoted from the docs): **"the streamed draft is ephemeral and acts as a
temporary 30-second preview - once the output is finalized, you must call `sendRichMessage` with
the complete message to persist it in the user's chat."** It has **no `message_id`** — you cannot
edit it like a normal message, only re-call `sendRichMessageDraft` with the same `draft_id` to
refresh/animate it, or a different `draft_id` to hard-replace it. If you stop refreshing it, it
self-expires after ~30s.

Because `chat_id` is restricted to private chats, this feature is **automatically inapplicable to
groups/forum-topics** — gate everything below on `msg.chat.type === 'private'` and leave the
existing plain-text placeholder + inline-keyboard-Cancel flow **completely untouched** for
non-private chats. (The `message_thread_id` param in the signature is vestigial/copy-pasted
boilerplate across Bot API methods, or refers to a different "direct message chat topics"
business-account feature — it is not the forum-topics feature this repo's `is_topic_message`/
`resolveThreadId` gate on, which only exists in groups. Don't worry about interaction with this
repo's own thread/topic mode — they're mutually exclusive by construction.)

**Erratum (PR #107, live-tested after #105/#106 shipped): the paragraph above is wrong.** This
repo's own [Threaded Mode](forum-topics/OVERVIEW.md) feature extends `is_topic_message`/
`message_thread_id` to private chats too (BotFather's per-chat "Threaded Mode" toggle) — private
chats and this repo's own thread/topic mode are not mutually exclusive at all, that was never
verified against a real bot before being asserted here. `sendRichMessageDraft` needs `threadId`
wired through exactly like every other outbound call in this codebase, via
`resolveThreadId`/`threadIdParam`. `stopped_message_generation` (step 3 below) does **not** — see
the correction right there, don't key it by thread. If you're pasting this file as a prompt, read
PR #107 first.

### The Stop button's update

```
Update.stopped_message_generation: MessageGenerationStopped = {
  chat: Chat,
  message_thread_id?: Integer,
  draft_id: Integer,
}
```

`lib.mjs` exports `TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query']`
(used in `bridge.mjs`'s `getUpdates` poll loop, search for `TELEGRAM_ALLOWED_UPDATES` — the main
loop is a `for (;;) { ... for (const u of updates) { if (u.message) ... else if (u.edited_message)
... else if (u.callback_query) handleCallbackQuery(...) } }`). You need to:
1. Add `'stopped_message_generation'` to that array so Telegram actually delivers it.
2. Add an `else if (u.stopped_message_generation)` branch that maps `chat.id` (+ your own
   `draft_id` bookkeeping) back to the right `activeRuns` entry and triggers the exact same
   cancellation `run.cancel()` already does for the inline Cancel button today.

### Embedding a collapsible "tool transcript" block

Rich Markdown (the `markdown` field of `InputRichMessage`, already in use via #101/#102) is
"compatible with GitHub Flavored Markdown where possible and can contain arbitrary HTML."
Confirmed from the docs' own worked example — you can just write this literally inside the
markdown string you already build for `rich_message.markdown`:

```
<details open><summary>🔧 Bash: npm test</summary>

- markdown *is* parsed inside `<details>` (also inside `<tg-collage>`/`<tg-slideshow>`, nowhere
  else — "Markdown isn't parsed inside block HTML tags other than these three")
- so put your existing tool-call transcript formatting straight in here

</details>
```

This gives you a real, native, collapsible section in the Telegram client with zero extra
authoring-mode complexity — no need to switch to the `blocks:` (explicit JSON tree) authoring
mode of `InputRichMessage`. Use `open` (no value, just the bare attribute) to default-expand a
section, or omit it to default-collapse.

### `<tg-thinking>` — drafts-only tag

`sendRichMessageDraft` additionally supports `<tg-thinking>Thinking...</tg-thinking>` in its
markdown — explicitly documented as usable **only** in this method (never in a persisted
`sendRichMessage`/`editMessageText` call). Good fit if you want to surface Claude's thinking/
reasoning stream content during the live draft without it ever leaking into the final persisted
message.

### Rich message limits (already relevant to #101/#102, repeated here for convenience)

32768 UTF-8 chars, 500 blocks (incl. nested/list items/table rows/quote/details blocks), 16
nesting levels, 50 media attachments, 20 table columns. A draft is presumably subject to the same
limits as any `InputRichMessage`.

## Design to implement

For a turn running in a **private chat** (`msg.chat.type === 'private'`):

1. **Don't create the classic real placeholder message at all.** Skip the initial `sendMessage`
   that currently creates the "⏳ working…" bubble (find this in `runClaudeTurn`/
   `createPlaceholderController`/`buildWorkingPlaceholderParams`).
2. On the same cadence the existing progress-editing loop already uses (~1.3s, see the
   `editMessageText` calls tied to `rootController`/`statusUpdater` in `runClaudeTurn`), call
   `sendRichMessageDraft` instead, with:
   - a stable `draft_id` for this run (any non-zero integer that's stable across refreshes of the
     *same* run and different across separate runs/turns — e.g. derive it from a per-chat
     monotonic counter, or hash the run's placeholder/queue key into a 31-bit int)
   - `rich_message.markdown` built from the current progress transcript, with verbose per-tool
     output wrapped in `<details><summary>...</summary>...</details>` instead of dumped as a wall
     of plain text
   - `can_stop: true`, `keep_on_stop: true`
3. Wire the Stop button: add `'stopped_message_generation'` to `TELEGRAM_ALLOWED_UPDATES`, handle
   `u.stopped_message_generation` in the poll loop, resolve it to the right `activeRuns` entry.
   **Correction, PR #107:** the original version of this step said to build a separate
   `chatId(+draftId) -> run` index "parallel to how `activeRuns` is already keyed," reusing
   `threadKey`-style keying — don't. `MessageGenerationStopped` has no `is_topic_message` to
   disambiguate `message_thread_id` the way a real `Message` does, so a reconstructed thread key
   can't be trusted to match `activeRuns`' own key, and no second index is needed anyway: scan the
   existing `activeRuns` Map directly for a run whose own `chatId`+`draftId` match (see
   `isTargetRunForStoppedGeneration`/`parseStoppedMessageGeneration` in `lib.mjs`). This only works
   because `draft_id` is unique per `chatId` — **keep `nextDraftId`'s counter keyed by `chatId`
   alone, never by thread**; making it per-thread would let two different threads in the same chat
   collide on the same `draft_id` and silently cancel the wrong one. Call the same cancel path the
   existing inline Cancel button uses today.
4. When the run finishes normally, do **not** try to "delete" or "finalize" the draft — it's not
   a real message, there's nothing to delete. Just send the real final answer the normal way
   (`sendReply`, already implemented, already tries `sendRichMessage` first). The draft
   self-expires within 30s on its own; if you want it to disappear immediately instead, the docs
   don't document a way to force that — don't invent one, just let it expire.
5. **Fallback safety**: if any `sendRichMessageDraft` call fails (network error, feature not
   available for this bot/account, whatever), fall back to creating the classic real placeholder
   message from that point onward and continue exactly as the existing (untouched) group/topic
   code path does. Never leave the user with *no* progress indicator at all.
6. For **non-private chats**, change nothing — keep the existing placeholder+inline-Cancel-
   keyboard flow exactly as it is today.

## Testing expectations (per this repo's own convention)

`bridge.mjs` itself has zero direct unit tests — it's the untested imperative wiring layer by
established convention in this repo. Pure logic should still be extracted into `lib.mjs` (or
`markdown-html.mjs` if it's about rendering) and unit-tested there wherever feasible — e.g.:
- the draft_id derivation function
- whatever builds the `<details>`-wrapped transcript markdown string
- the update → `activeRuns` key resolution logic for `stopped_message_generation`
- a pure "should this chat use the draft-streaming path" predicate (`chat.type === 'private'`)

Follow the exact same pattern used today for `buildRichReplyCall`, `resolveSpeechText`,
`shouldRetryEmptyResult` (all in `lib.mjs`, all with direct `node:test` coverage in
`test/lib.test.mjs`) — that's the established shape for "pure decision/construction logic lives
in `lib.mjs`, gets tested there; `bridge.mjs` just wires it up."

## Workflow reminders (from this repo's `CLAUDE.md`, don't skip any step)

1. Branch off `main`, never push directly to it.
2. Implement + `node --test` + `node --check bridge.mjs lib.mjs markdown-html.mjs`.
3. `gh pr create`.
4. Review with the `code-review` skill, `--comment` flag, so findings land as inline PR comments.
5. Fix everything raised, push, re-review — repeat until only minor/nit-level comments remain.
   Expect multiple rounds; this touches the highest-risk code path in the whole repo (the live
   streaming loop), so be thorough rather than fast. Verify surprising API assumptions (e.g. "does
   a `callback_query`/other update actually carry the field I think it does") against the live Bot
   API directly with `curl`/a throwaway Node script using the bot's own token (already proven safe
   and useful earlier today — see git log for examples of this pattern with `sendRichMessage`),
   not just by trusting docs or guessing.
6. Self-merge once clean (`gh pr merge --merge --delete-branch`) — already authorized in this
   repo, don't ask first.
7. Restart every affected bot: `for label in tldr ig ig-ios ig-invest-uni outfit corpaidelegate
   smm clientsearch; do launchctl kickstart -k gui/$UID/com.tgbridge.$label; done`.
8. Report back to the user in Telegram-appropriate style (short, concrete, what changed and what
   to test) — the user primarily communicates through the `tldr` bot itself.
