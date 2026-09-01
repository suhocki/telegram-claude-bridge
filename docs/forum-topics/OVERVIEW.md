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

Use Telegram's native **Forum Topics** as the unit of an isolated conversation:
each topic gets its own Claude session, its own command state (`/new`,
`/compact`, `/voice`, auth mode, risky-command confirmation, check-ins,
rewind-on-edit), fully independent from every other topic. Switching topics in
Telegram's UI (the horizontally-scrollable topic list) *is* switching
conversations — no bot command needed.

**Primary target, revised 2026-08-23: a bot's own private chat, not a
supergroup.** Telegram has a "Threaded Mode" setting in BotFather (Bot Settings)
that turns a bot's *existing private chat* into a forum — the same topic list
UI as a supergroup, but with no group to create or manage at all. This is
simpler than the original supergroup-based plan and was confirmed hands-on: with
this already toggled on for one bot, incoming messages inside a topic are
delivered and handled correctly, but the bot's own replies land in the wrong
place (the chat's General area) instead of back in the topic — exactly the gap
`IMPLEMENTATION.md` §4 already predicted (no outbound call sends
`message_thread_id` today). A supergroup with Topics enabled remains supported
too, and needs no separate implementation path: the design keys off per-message
Bot API fields (`is_topic_message` / `message_thread_id`), which work
identically regardless of whether the forum lives in a private chat or a
supergroup. Per the user's direction, the private-chat path is the priority;
supergroup-specific concerns (mainly group authorization policy, see below) are
explicitly deprioritized, not dropped.

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
- Auth mode (subscription vs API key) and model/reasoning-effort selection — now the
  pinned status message's own buttons, not slash commands.
- The risky-command confirmation guard (a "CONFIRM" typed in one topic must never
  confirm a risky command flagged in another).
- Scheduled check-ins.
- Rewind-on-message-edit (editing a message in one topic must never touch another
  topic's turn history or delete its bot messages).
- The Cancel/Join/Continue in-flight-run buttons and their underlying run state.

Two things stay chat-wide, unchanged, because they're not really
"conversation state": the group-level authorization policy (`groupsConfig` — who's
allowed to talk to the bot at all, and whether a mention is required — only
relevant at all for the deprioritized supergroup path, since a private chat's
authorization is just the existing allow-list check, untouched by this feature)
and the Telegram long-poll offset / working-phrase rotation, which are bot-global,
not per-chat, today.

## New feature: auto-naming a topic

Typing a topic name every time you want a fresh conversation defeats the point
(the whole draw is "one tap, empty context," same as ChatGPT/Gemini's new-chat
button). So: you create a topic with any placeholder name (a couple of random
characters is fine), send your first message(s), and the bridge renames the topic
itself once there's enough context to name it well — a work ticket number if
that's what the conversation is about, one or two words otherwise. This uses the
Bot API's `editForumTopic` method. In a supergroup that requires the bot to hold
the `can_manage_topics` admin right (a checkbox separate from plain "admin"); in
the private-chat-forum case there's no "admin" concept, so this needs hands-on
confirmation of whether a bot can rename its own private-chat topics
unconditionally or whether an equivalent permission gate exists there too — flag
as unverified in `IMPLEMENTATION.md` rather than assumed.

Renaming happens once per topic, after a small fixed number of messages (see
`IMPLEMENTATION.md` for the exact trigger and prompt), using one cheap, stateless
Claude call — not the ongoing conversation's own turn — so it never adds latency
or cost to the actual conversation. If the bot lacks `can_manage_topics`, or the
call fails for any reason, this fails silently (logged, not surfaced to the user)
and the topic just keeps its original name — never blocks or breaks the
conversation itself.

## Rollout

No data migration needed: existing `state.json` files are already valid
thread-keyed data (their thread key equals their chatId). The feature is opt-in
per chat, automatically — it only activates when a message actually carries
`is_topic_message: true`. Enabling it is a one-time, per-bot toggle in
BotFather ("Threaded Mode"), not something that requires creating a new chat —
the bot's existing private chat with the user becomes the forum.

One thing to confirm hands-on before implementing (see `IMPLEMENTATION.md`'s
verification note): whether Telegram's "General" area of a private-chat forum
behaves like a supergroup's General topic (messages there arrive *without*
`is_topic_message`, so the existing pre-feature conversation keeps working
untouched), or whether enabling Threaded Mode changes that chat's behavior more
broadly. The supergroup case is documented behavior; the private-chat case is
new enough that it's worth checking directly against a real bot rather than
assumed identical.

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
- Confirmed live, right now, on a bot with Threaded Mode already enabled: the
  bot replies to topic messages fine (content-wise — there's no per-topic
  session isolation yet, so every topic currently shares the one chat-wide
  session), but its own replies land in the chat's General area instead of the
  topic that was actually being used. This is the concrete, already-observed
  version of the §4 gap in `IMPLEMENTATION.md` (no outbound call sends
  `message_thread_id`) — not just a theoretical risk.

## Suggested phasing for the actual implementation (separate PRs, not this one)

1. Thread-key plumbing: the `threadKey()` helper, and widening every state field
   and in-memory map (sessions, risky-guard, continue-button, check-ins, turn
   history, active-run tracking, per-chat queues, auth mode, voice-reply flag) to
   use it. No user-visible behavior change yet for existing chats.
2. Telegram-facing changes: `message_thread_id` threaded through every outbound
   call (including the three raw-multipart upload methods), and reading the
   thread id off the Cancel/Join/Continue buttons' own message. This is what
   actually makes replies land back in the right topic and buttons resolve to
   the right topic's run — top priority, since it's a live, already-observed bug
   on a bot with Threaded Mode already enabled, not just a hypothetical.
3. Auto-rename feature, as a self-contained follow-up once (1) and (2) are live
   and manually verified.

Deliberately **not** in this phasing, per the user's explicit priority call: any
supergroup-specific work (extending `groupsConfig`/`resolveGroupPolicy` for
per-topic policy). The private-chat-forum path needs none of that, and it's
fine to revisit only if it turns out to be low-effort once (1) and (2) are done
— not worth planning for up front.

This spec (both files) is its own PR, reviewed independently per this repo's
usual policy, before any of the above phases are implemented.
