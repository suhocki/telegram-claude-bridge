# Forum Topics: implementation plan

Status: **spec only, not implemented**. Companion to `OVERVIEW.md` in this folder.
Line numbers below are as of the audit done for this spec (main branch, commit
`304b9ed`) — re-check them before implementing, since this repo moves fast.

## 1. The `threadKey` helper

New pure function in `lib.mjs`, next to the other small pure helpers:

```js
export function threadKey(chatId, messageThreadId) {
  return messageThreadId != null ? `${chatId}:${messageThreadId}` : String(chatId)
}
```

Unit-testable in isolation: no thread id → bare chatId string (byte-identical to
today's key, so old `state.json` data stays valid); a thread id present → the
composite form. This is the single new primitive everything else below builds on.

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
- `lib.mjs:745-746` — `buildButtonTapSyntheticMessage`

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

## 5. `callback_data` redesign (Cancel / Join / Continue buttons)

Today: `buildCancelKeyboard`/`buildContinueKeyboard` (`lib.mjs:541-545, 573-575`)
encode `` `cancel:${chatId}` ``, `` `join:${chatId}` ``, `` `continue:${chatId}` ``.
`parseCallbackData` (`lib.mjs:577-582`, regex `CALLBACK_DATA_RE`) captures
everything after the first colon as `parsed.chatId`, and every consumer
(`bridge.mjs:1493, 1500`, etc.) uses that value directly as the state-lookup key.

New encoding: `` `${action}:${chatId}:${threadId ?? ''}` `` — empty segment when
there's no topic (private chat / non-forum group), so the composite key
reconstructs via `threadKey(chatId, threadId || undefined)`. Telegram's 64-byte
`callback_data` cap is not a practical concern here: chat ids run up to ~14
characters (negative supergroup ids), thread ids are small integers, well within
budget alongside the action word.

Update in lockstep: `CALLBACK_DATA_RE`, `parseCallbackData`, and every consumer
that currently treats `parsed.chatId` as *the* lookup key — those all need to
switch to computing `threadKey(parsed.chatId, parsed.threadId)` before touching
`activeRuns`/`state.pendingContinue`/etc.

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

## 7. Group authorization policy — deliberately unchanged

`resolveGroupPolicy`/`groupsConfig` (`lib.mjs:668-670`) and
`isSenderAllowedInGroup`/`shouldHandleGroupMessage` (`lib.mjs:672-675, 706-711`)
stay keyed by plain chat id, applying one allow-list/mention-policy to the whole
group regardless of topic. Per `OVERVIEW.md`, this is an explicit non-goal, not
an oversight — if a per-topic override is wanted later, `resolveGroupPolicy`
would need a `threadId` parameter and `groupsConfig` a nested shape, but nothing
in this spec requires it.

## 8. Auto-rename feature

### Trigger

Track a new persisted flag, `state.topicNamed[threadKey] = true`, set once a
topic has been renamed (or has permanently failed to rename — see below) so it's
never attempted twice. Fire the rename attempt the first time
`state.turns[threadKey].length` reaches 2 for a thread key that has a
`message_thread_id` (i.e., only for actual forum topics — private chats and
non-forum groups never trigger this) and isn't yet marked in
`state.topicNamed`.

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

`editForumTopic` requires the bot to hold the `can_manage_topics` admin right.
If the call fails:

- Log once (`log('topic rename failed', ...)`), and set
  `state.topicNamed[threadKey] = true` anyway (or a distinct
  `state.topicRenameDisabled = true` bot-wide flag, tripped after the *first*
  permission-shaped failure) so the bridge doesn't retry-and-fail on every
  single topic's 2nd message forever if the right is simply missing group-wide.
- Never surface this failure to the user in-chat — it's a nice-to-have, not
  something that should interrupt or annotate the actual conversation.

### Where this hooks into `handleMessage`

After `appendTurn`/`saveState` at the end of `handleMessage` (`bridge.mjs:1341-
1346`), check the trigger condition above and, if met, fire the rename as an
un-awaited background task (`.catch(() => {})`-guarded, same pattern as other
best-effort side calls in this file) so it never adds latency to the reply the
user is waiting for.

## 9. Testing plan

Unit-testable (pure functions, `node --test` as usual):

- `threadKey()` — bare chatId passthrough vs. composite form.
- `parseCallbackData` with the new three-segment encoding, including the
  empty-threadId-segment case.
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
2. Telegram-facing wiring: `message_thread_id` on outbound calls (§4) +
   `callback_data` redesign (§5). This is what makes the feature actually work
   end-to-end. Manual QA per §9 belongs here.
3. Auto-rename (§8), as a self-contained follow-up once (1) and (2) are live.

Each phase goes through this repo's usual loop: implement with tests where
feasible → PR → fresh-agent review → fix → re-review → self-merge.
