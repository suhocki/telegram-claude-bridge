# Forum Topics: implementation plan

Status: **spec only, not implemented**. Companion to `OVERVIEW.md` in this folder.
Line numbers below are as of the audit done for this spec (main branch, commit
`8706b27`) — re-check them before implementing, since this repo moves fast; two
voice-join PRs landed in the hours before this spec was written and are already
reflected here, but anything merged after `8706b27` won't be.

**Primary target, revised 2026-08-23**: a bot's own private chat with Threaded
Mode enabled via BotFather, not a supergroup — see `OVERVIEW.md` for why. This
changes nothing about the technical plan below: every mechanism here is keyed
off per-message Bot API fields (`is_topic_message` / `message_thread_id`), which
Telegram documents identically for both a private-chat forum and a
supergroup forum. Supergroup-specific work is called out explicitly (§7) as
deprioritized, not required for the primary path.

**Verification note, unresolved**: a live `getChat` call against the exact chat
this was tested in (via the bot's own token) returned no `is_forum` field, and
the general Bot API reference documents `is_forum` as supergroup-only — while a
separate, more specific Telegram doc (`core.telegram.org/api/forum`) explicitly
describes "Threaded Mode" as a real, bot-enablable private-chat feature, and a
third-party account independently describes using it for exactly this purpose
(per-topic isolated LLM sessions). Before starting implementation: capture one
real incoming update from an actual test topic (in whichever bot has Threaded
Mode enabled) and confirm `is_topic_message`/`message_thread_id` are actually
present on it — don't assume the mechanism from docs alone, since this feature
is new enough that documentation may be incomplete or ahead of what's live.

## 1. The `threadKey` helper

New pure function in `lib.mjs`, next to the other small pure helpers. **Gate on
`is_topic_message`, not merely on `message_thread_id` being present**:
Telegram's Bot API also stamps `message_thread_id` on ordinary reply-chains in
regular, non-forum groups (Telegram's generic "message threads," unrelated to
Forum Topics) — `is_topic_message` is the field that's `true` specifically when
the message actually belongs to a forum topic. Keying on `message_thread_id`
alone would silently fork an existing group's session the first time someone
replies to a message in it, which directly breaks the "nothing changes for
existing chats" guarantee this spec depends on.

```js
export function threadKey(chatId, msg) {
  return msg?.is_topic_message && msg.message_thread_id != null
    ? `${chatId}:${msg.message_thread_id}`
    : String(chatId)
}
```

Unit-testable in isolation: no `is_topic_message` (or it's false/absent) → bare
chatId string (byte-identical to today's key, so old `state.json` data stays
valid, and a plain reply-thread reply in a non-forum group is *not* mistaken for
a topic); `is_topic_message: true` with a thread id → the composite form. This is
the single new primitive everything else below builds on.

### Where to compute it

Every place `chatId` is currently derived from `msg.chat.id` needs to also read
`msg.message_thread_id` and compute the thread key at the same point:

- `bridge.mjs:611` — `handleEditedMessage`
- `bridge.mjs:909` — `isAuthorizedMessage` (only needs `chat.id`, not the key —
  authorization stays chat-wide per `OVERVIEW.md`, no change here)
- `bridge.mjs:1151` — `handleMessage`
- `bridge.mjs:1559,1566` — `poll()`'s update-dispatch loop
- `lib.mjs:716` — `isCallbackQueryAuthorized` (same as above — chat-wide, no
  change)
- `handleCallbackQuery` (`bridge.mjs:1482,1493`) — see §5 below; this one does
  **not** read `msg.chat.id`, it reads `cq.message.chat.id`, so it needs its own
  entry rather than reusing the `msg.chat.id` pattern above.
- `lib.mjs:743-751` — `buildButtonTapSyntheticMessage` — **implementer trap**:
  this function builds a synthetic message as a hand-written object literal
  (`message_id`, `chat`, `from`, `date`, `text`), not a spread of a real
  Telegram message. Unlike the join-tap synthetic message (`bridge.mjs`'s
  `handleJoinTap`, which spreads `...last` and gets `is_topic_message`/
  `message_thread_id` for free), this literal needs those two fields added
  explicitly (`is_topic_message: cq?.message?.is_topic_message`,
  `message_thread_id: cq?.message?.message_thread_id`) or the custom
  buttons-module fallback path silently loses thread isolation.

Convention: keep a local `chatId` variable for anything that's an actual Telegram
API `chat_id` parameter (unchanged), and introduce a separate `key` (or
`threadId`) variable for anything that indexes `state.*` or an in-memory `Map`.
Do not conflate the two — a bug here (e.g. accidentally using the composite key
as the API's `chat_id`) fails loudly (Telegram rejects the id), which is a safe
failure mode, but worth flagging in review.

## 2. Persisted `state` fields to re-key

All in `bridge.mjs`, all currently indexed by plain `chatId`. Change every read
and write site below to index by `threadKey(chatId, messageThreadId)` instead:

| Field | Write sites | Read sites |
|---|---|---|
| `state.sessions` | 615, 1039-1044, 1093-1097 | 633, 684, 693, 697, 1147, 1182, 1204, 1351 |
| `state.pendingRisky` | 1230 | 1227, 1235-1236, 634, 1183 |
| `state.pendingContinue` | 1101-1107, 1523, 1528 | 580-589, 1350-1392 |
| `state.pendingCheckins` | 663-668 | 635, 1185, boot re-arm at 240-241 |
| `state.turns` | 591-597 (`trackBotMessages`), 632 (rewind slice) | 610-640, 1183, 1341-1346, 1385-1390 |
| `state.authMode` | 1198 | 691, 1208, 1331, 1373 |
| `state.voiceReply` | 1077 | 1173 |

This must land as **one atomic change** — not field-by-field over several PRs.
Partially widening (e.g. `sessions` re-keyed but `turns` left on plain `chatId`)
reintroduces exactly the cross-topic corruption this spec exists to prevent (see
§5 below).

`state.offset` and the working-phrase rotation queue are bot-global, not
chat-keyed at all today — no change.

## 3. In-memory (non-persisted) structures to re-key

All in `bridge.mjs`:

- `activeRuns` (`Map`, declared line 234) — set at 1263, 1367; read at 1500,
  1560, 1570; deleted at 1125.
- `consumedByJoin` (`Map`, line 236) — write 1427-1432; read/delete 1468-1470.
- `chatQueue` (`createKeyedQueue()`, line 232) — every `.enqueue(chatId, ...)`
  call site: 657, 1437, 1464, 1486, 1531, 1564, 1572. `createKeyedQueue` itself
  (`lib.mjs:965-980`) is already generic over whatever key string it's given —
  no change needed there, just pass the widened key in.
- `joinKeyboardQueue` (line 238) — used at 1404, same story.
- `checkinTimers` (`Map`, line 240) — `armCheckinTimer`/`clearCheckinTimer`
  (642-660), re-armed on boot (241).

`subagentControllers` (declared locally inside `runClaudeTurn`, line 975) needs
no change — it's already scoped to one call of `runClaudeTurn`, i.e. already
per-thread once `runClaudeTurn` itself is invoked once per active thread key.

## 4. Telegram API calls needing `message_thread_id`

Bot API rule of thumb: any `sendMessage`/`sendPhoto`/`sendDocument`/`sendVoice`/
`sendMediaGroup`/`sendChatAction` call needs `message_thread_id` to land in the
right topic instead of the group's General thread. `editMessageText`,
`editMessageReplyMarkup`, `deleteMessage`, and `setMessageReaction` do **not**
need it — the target message already carries its own thread membership.

**JSON-bodied calls (already go through the shared `tg()` helper — add the param
to the params object at each site, conditionally, only when a thread id is
known):**

- `sendReply` → `buildReplyCallsFromChunks` (`lib.mjs:357-369`) — `bridge.mjs:251`
- `sendTranscriptQuote` (`bridge.mjs:267-273`, inline params)
- `freezePlaceholderAsTranscript`'s post-transcript placeholder →
  `buildWorkingPlaceholderParams` (`lib.mjs:594-597`) — `bridge.mjs:305`
- The working placeholder in `handleMessage` — `bridge.mjs:1267-1270`
- The subagent placeholder send — `bridge.mjs:984-988`
- `withTypingIndicator`'s `sendChatAction` calls — `bridge.mjs:928-940` (both
  931 and 933)

**Raw-`FormData` calls (currently have *no* thread-id parameter path at all —
need `form.append('message_thread_id', threadId)` added conditionally):**

- `sendAttachment` (sendPhoto/sendDocument) — `bridge.mjs:332-336`
- `sendAttachmentGroup` (sendMediaGroup) — `bridge.mjs:354-361`
- `sendVoiceReply` (sendVoice) — `bridge.mjs:821-825`

**No change needed** (confirmed in the audit): `editMessageText` sites
(`bridge.mjs:291-298`, `856-878`, `587`), `editMessageReplyMarkup` sites (964,
1109-1113, 1128, `lib.mjs:785-789`), `setMessageReaction` (`bridge.mjs:313-319`),
`deleteMessage` (601, 1011, 1064, 1140), and bot-level calls (`getMe`,
`getUpdates`, `setMyCommands`/`deleteMyCommands`, `getFile`).

## 5. Cancel / Join / Continue buttons — no `callback_data` change needed

Corrected from an earlier draft of this spec, which wrongly assumed
`parsed.chatId` (from `parseCallbackData`, `lib.mjs:577-582`) was used as the
state-lookup key. It isn't: `handleCallbackQuery` (`bridge.mjs:1482-1493`)
already deliberately ignores the `chatId` embedded in `callback_data` and
re-derives `chatId` fresh from `cq.message.chat.id` instead, with an existing
comment explaining why — *"derived from the button's own message, not the
callback_data payload, so a chat can only cancel/continue/join its own run"*
(`bridge.mjs:1492`). `parsed.chatId` (`lib.mjs:582`, the regex capture group) is
in fact never read anywhere in `bridge.mjs` today — confirmed via
`grep -n "parsed\." bridge.mjs`, which only turns up `parsed.action`.

Since the button's own message (`cq.message`) already carries
`is_topic_message`/`message_thread_id` — Telegram stamps every message with its
own thread membership, buttons included — the natural fix mirrors the existing
pattern exactly: compute `threadKey(chatId, cq.message)` right where `chatId`
is already derived (`bridge.mjs:1482,1493`), and use that for the
`activeRuns`/`consumedByJoin`/`state.pendingContinue` lookups in this handler.
**No change to `buildCancelKeyboard`, `buildContinueKeyboard`,
`CALLBACK_DATA_RE`, or `parseCallbackData` is needed at all** — trusting the
button's own message for the thread id is not just simpler than a
`callback_data` schema change, it's the same trust boundary the existing
chat-id handling already established, so it's the more consistent choice too.

The `if (!parsed)` fallback branch just above (`bridge.mjs:1479-1490`, the
custom-buttons-module path) derives its own `chatId` from `cq.message?.chat?.id`
the same way and feeds it straight into `chatQueue.enqueue(chatId, ...)` — needs
the same `threadKey(chatId, cq.message)` treatment for consistency, even though
it's a less-used path.

## 6. Rewind-on-edit correctness (the one place with a real bug risk)

`handleEditedMessage` (`bridge.mjs:610-640`) and `appendTurn`
(`lib.mjs:835-838`)/`findTurnIndexByMessageId`/`collectBotMessageIdsFrom`
(`lib.mjs:840-854`) treat `state.turns[key]` as one flat, arrival-ordered array.
Message ids don't collide across topics in the same chat, so the initial
`findIndex` lookup for the edited message would still land on the right entry
even with a shared key — but `slice(0, turnIndex)` (`bridge.mjs:632`) and
`collectBotMessageIdsFrom(turnList, turnIndex)` operate on **array position**,
not thread membership. With topics interleaved by arrival time in one shared
array, an edit in topic A would truncate turns and delete bot messages that
actually belong to topic B.

This resolves itself automatically and completely once `state.turns` is
re-keyed by thread key per §2 — each topic gets its own array, so "arrival
order" within that array is genuinely single-topic order again. No separate
fix is needed beyond doing §2 completely and atomically. Flagging this
explicitly because it's the one item where a partial rollout (turns not
re-keyed alongside sessions) produces silent, hard-to-notice data loss rather
than a loud error.

`rewindBackupDir` file naming (`bridge.mjs:569`) is already keyed by `sessionId`,
not chatId — once sessions are per-topic, backups are automatically
collision-free per topic too. No change needed there.

## 7. Group authorization policy — deliberately unchanged, and out of scope for now

`resolveGroupPolicy`/`groupsConfig` (`lib.mjs:668-670`) and
`isSenderAllowedInGroup`/`shouldHandleGroupMessage` (`lib.mjs:672-675, 706-711`)
stay keyed by plain chat id, applying one allow-list/mention-policy to the whole
group regardless of topic. This only matters at all for the supergroup variant
of this feature — the primary private-chat-forum target is still `chat.type ===
'private'`, so its existing allow-list check is completely untouched by any of
this. Per the user's 2026-08-23 priority call, supergroup support is
deprioritized (not required, welcome if it falls out for free, not worth extra
design/implementation effort) — if a per-topic override is wanted later,
`resolveGroupPolicy` would need a `threadId` parameter and `groupsConfig` a
nested shape, but nothing in the prioritized scope requires it.

## 8. Auto-rename feature

### Trigger

Track a new persisted flag, `state.topicNamed[threadKey] = true`, set once a
topic has been renamed (or has permanently failed to rename — see below) so it's
never attempted twice. Fire the rename attempt the first time
`state.turns[threadKey].length` reaches 2 for a thread key that came from an
actual topic (`is_topic_message: true` — whether that topic lives in a
private-chat forum or a supergroup forum, same trigger either way) and isn't
yet marked in `state.topicNamed`. A chat with no topic at all (private or
group) never triggers this, same as today.

### The rename call itself

One-off, stateless `claude -p` invocation — deliberately *not* `--resume`d into
the conversation's own session, so it costs nothing extra on the real
conversation's context or turn count:

```
claude -p "<system: reply with only a 1-2 word title (or a bare ticket/task
number if one is mentioned), no punctuation, no quotes, based on this
exchange>\n\n<first two turns' text>" --output-format json
```

Sanitize the result: strip newlines/quotes, trim to Telegram's 128-character
topic-title limit (`TRANSCRIPT_QUOTE_MAX_CHARS`-style truncation helper already
exists in `lib.mjs` as a pattern to follow — a small new `truncateStatus`-based
helper is enough, no need for anything fancier).

Call `tg('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name:
sanitizedTitle })`.

### Graceful degradation

In a supergroup, `editForumTopic` requires the bot to hold the
`can_manage_topics` admin right. Whether an equivalent permission gate exists
for a bot renaming topics in its own private-chat forum is unverified (there's
no "admin" concept in a private chat) — confirm hands-on before relying on
this working unconditionally there. Either way, if the call fails for any
reason:

- Log once (`log('topic rename failed', ...)`), and set
  `state.topicNamed[threadKey] = true` anyway (or a distinct
  `state.topicRenameDisabled = true` bot-wide flag, tripped after the *first*
  permission-shaped failure) so the bridge doesn't retry-and-fail on every
  single topic's 2nd message forever if the right is simply missing group-wide.
- Never surface this failure to the user in-chat — it's a nice-to-have, not
  something that should interrupt or annotate the actual conversation.

### Where this hooks in

`appendTurn` is called from **two** places, not one: the end of `handleMessage`
(`bridge.mjs:1341-1346`) and separately, with its own call, at the end of
`handleContinue` (`bridge.mjs:1385-1390`, the Cancel→Continue resume path). A
topic's turn count can reach the trigger threshold via either path (e.g. turn 1
from `handleMessage`, turn 2 from a Continue after a Cancel) — the rename check
needs to run after *both* `appendTurn` call sites, not just the one in
`handleMessage`, or a topic that happens to hit the threshold via `handleContinue`
permanently misses its rename (the count keeps climbing past the trigger with
`state.topicNamed` never set). Cleanest is probably a small shared helper
(`maybeRenameTopic(threadKey, chatId, messageThreadId)`) called from both sites
rather than duplicating the check inline twice.

Fire the rename as an un-awaited background task (`.catch(() => {})`-guarded,
same pattern as other best-effort side calls in this file) from wherever it's
called, so it never adds latency to the reply the user is waiting for.

## 9. Testing plan

Unit-testable (pure functions, `node --test` as usual):

- `threadKey()` — bare chatId passthrough (no `is_topic_message`) vs. composite
  form (`is_topic_message: true` with a thread id present).
- A title-sanitizing helper for the auto-rename feature (strip/trim logic).

Not unit-testable without a much larger test-harness investment (consistent
with this repo's existing gap — `bridge.mjs` has no exports or test file today,
and this spec doesn't propose changing that): the actual re-keying of
`activeRuns`/`chatQueue`/etc., the Telegram-call wiring, and the rewind
correctness fix. These need manual QA:

1. Create a forum group, enable Topics, add the bot as admin with
   `can_manage_topics`.
2. Open two topics, interleave messages between them (send in A, then B, then A
   again) — confirm each topic's Claude session only ever sees its own history
   (ask "what did I just say" in each and confirm no cross-contamination).
3. Trigger Cancel/Join/Continue buttons in topic A while topic B has its own
   in-flight run — confirm each button only ever affects its own topic's run.
4. Edit an old message in topic A — confirm topic B's turn history and bot
   messages are untouched.
5. Send 2 messages in a freshly created topic — confirm it gets auto-renamed;
   then temporarily revoke the bot's `can_manage_topics` right and repeat in a
   new topic — confirm it fails silently (logged, conversation unaffected) and
   isn't retried every message.

## 10. Suggested PR breakdown for the actual implementation

Matches `OVERVIEW.md`'s phasing:

1. `threadKey()` + re-key every state field and in-memory map (§1-3). No
   observable behavior change for existing chats; new behavior only reachable
   once `message_thread_id` starts appearing on incoming updates, which can't
   happen until phase 2 lands anyway — safe to land and merge on its own.
2. Telegram-facing wiring: `message_thread_id` on outbound calls (§4) + reading
   the thread id off the Cancel/Join/Continue buttons' own message, no
   `callback_data` format change needed (§5). This is what makes the feature
   actually work end-to-end — top priority, since it fixes an already-observed
   live bug (replies landing in General instead of the topic they belong to).
   Manual QA per §9 belongs here, run against the private-chat-forum bot first.
3. Auto-rename (§8), as a self-contained follow-up once (1) and (2) are live.

Not phased in at all right now: any supergroup-specific work (§7). Revisit only
if it turns out to fall out for free alongside the above — not worth planning
for up front per the user's priority call.

Each phase goes through this repo's usual loop: implement with tests where
feasible → PR → fresh-agent review → fix → re-review → self-merge.
