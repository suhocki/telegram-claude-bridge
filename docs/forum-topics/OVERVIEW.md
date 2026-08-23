# Forum Topics: per-thread Claude sessions

Status: **spec only, not implemented**. This document is the high-level design.
See `IMPLEMENTATION.md` in this folder for the file-by-file technical plan.

## Problem

Today the bridge keeps exactly one Claude session per Telegram chat. In a private
chat that means one linear conversation: to start on something unrelated you run
`/new`, which wipes context, and there's no way back to the old conversation short
of not compacting/resetting in the first place. If you're juggling several
unrelated tasks (e.g. one per work ticket) you either live with one blended
context, or run one bot process per task — neither scales past a handful of
things in flight.

## Goal

Use Telegram's native **Forum Topics** (available on regular, non-Premium
accounts, in supergroups with Topics enabled — see the Telegram-side setup notes
already covered in chat) as the unit of an isolated conversation: each topic in
the group gets its own Claude session, its own command state (`/new`, `/compact`,
`/voice`, auth mode, risky-command confirmation, check-ins, rewind-on-edit), fully
independent from every other topic in the same group. Switching topics in
Telegram's UI (the horizontally-scrollable topic list) *is* switching
conversations — no bot command needed.

Non-goal, explicitly dropped in favor of this: the earlier "reply to an old
message to resume its session" idea. Forum Topics gives a native, discoverable UI
for the same outcome, so that alternative isn't being pursued.

## Design in one sentence

Everything that is currently keyed by `chatId` becomes keyed by a **thread key**:
`chatId` alone for a private chat or a non-forum group (unchanged from today), or
`chatId:messageThreadId` for a message that belongs to a forum topic. Nothing
changes for existing private-chat/group usage — a thread key with no topic *is*
today's chatId, byte for byte, so old `state.json` data keeps working with no
migration step.

## What becomes per-topic

Per the codebase audit (see `IMPLEMENTATION.md` for exact sites), *all* of the
following become scoped to the thread key, per the user's explicit call: "весь
функционал должен быть изолирован" — every piece of per-conversation behavior is
isolated per topic, with no exceptions:

- The Claude session itself (`state.sessions`) — the core of the feature.
- `/new`, `/compact`, `/status`.
- `/voice on|off` (voice-reply preference).
- `/subscription` / `/apikey` (auth mode).
- The risky-command confirmation guard (a "CONFIRM" typed in one topic must never
  confirm a risky command flagged in another).
- Scheduled check-ins.
- Rewind-on-message-edit (editing a message in one topic must never touch another
  topic's turn history or delete its bot messages).
- The Cancel/Join/Continue in-flight-run buttons and their underlying run state.

Two things stay chat-wide, unchanged, because they're not really
"conversation state": the group-level authorization policy (`groupsConfig` — who's
allowed to talk to the bot at all, and whether a mention is required) and the
Telegram long-poll offset / working-phrase rotation, which are bot-global, not
per-chat, today.

## New feature: auto-naming a topic

Typing a topic name every time you want a fresh conversation defeats the point
(the whole draw is "one tap, empty context," same as ChatGPT/Gemini's new-chat
button). So: you create a topic with any placeholder name (a couple of random
characters is fine), send your first message(s), and the bridge renames the topic
itself once there's enough context to name it well — a work ticket number if
that's what the conversation is about, one or two words otherwise. This uses the
Bot API's `editForumTopic` method, which requires the bot to hold the
`can_manage_topics` admin right in the group (a checkbox separate from plain
"admin" — the setup notes need to call this out explicitly).

Renaming happens once per topic, after a small fixed number of messages (see
`IMPLEMENTATION.md` for the exact trigger and prompt), using one cheap, stateless
Claude call — not the ongoing conversation's own turn — so it never adds latency
or cost to the actual conversation. If the bot lacks `can_manage_topics`, or the
call fails for any reason, this fails silently (logged, not surfaced to the user)
and the topic just keeps its original name — never blocks or breaks the
conversation itself.

## Rollout

No data migration needed: existing `state.json` files for private chats and
non-forum groups are already valid thread-keyed data (their thread key equals
their chatId). The feature is opt-in per chat, automatically — it only activates
when a message actually carries a `message_thread_id`, which only happens once
you've created a forum group and enabled Topics there.

## Known sharp edges (detailed in IMPLEMENTATION.md)

- The thread key must gate on `is_topic_message`, not merely on
  `message_thread_id` being present — Telegram also stamps `message_thread_id`
  on ordinary reply-chains in regular, non-forum groups, unrelated to Forum
  Topics. Gating on presence alone would silently fork an existing group's
  session the first time someone replies to a message in it.
- Rewind-on-edit's turn history is a flat array indexed by arrival order; if the
  key-widening isn't applied to *every* read/write site in one pass, topics can
  corrupt each other's turn history (truncate the wrong topic's messages, delete
  the wrong topic's bot messages) — this must land as one atomic change, not
  gradually.
- Three outbound-attachment methods build raw multipart bodies by hand today and
  have no thread-id parameter at all yet.
- The Cancel/Join/Continue buttons need **no** `callback_data` format change —
  the button's own message already carries its thread id, and the handler
  already deliberately re-derives the chat id from that message rather than
  trusting the callback payload, so the thread id follows the same pattern for
  free.

## Suggested phasing for the actual implementation (separate PRs, not this one)

1. Thread-key plumbing: the `threadKey()` helper, and widening every state field
   and in-memory map (sessions, risky-guard, continue-button, check-ins, turn
   history, active-run tracking, per-chat queues, auth mode, voice-reply flag) to
   use it. No user-visible behavior change yet for existing chats.
2. Telegram-facing changes: `message_thread_id` threaded through every outbound
   call (including the three raw-multipart upload methods), and reading the
   thread id off the Cancel/Join/Continue buttons' own message. This is what
   actually makes replies land back in the right topic and buttons resolve to
   the right topic's run.
3. Auto-rename feature, as a self-contained follow-up once (1) and (2) are live
   and manually verified across at least two concurrent topics.

This spec (both files) is its own PR, reviewed independently per this repo's
usual policy, before any of the above phases are implemented.
