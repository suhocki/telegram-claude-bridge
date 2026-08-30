# telegram-claude-bridge

![Peak output, zero laptop time](assets/peak-productivity.jpg)

**You never have to touch your laptop again.** Dictate a task on your commute, review a diff from the couch, kick off a fix while you're making coffee — Claude Code runs entirely from Telegram, on your phone, in your pocket. No lid to open, no context-switch tax, no hunching over a desk.

**Run as many projects in parallel as you want.** Each bot is scoped to its own working directory with its own persistent session — spin one up per project and check on each for thirty seconds at a time instead of babysitting one terminal all day. That's what the graph above is: the highest sustained output of an entire career, and it happened without sitting at a desk for most of it.

**Why Telegram?** Because it already solved the hard parts — voice notes, push notifications, file transfer, multi-device sync, offline queuing — for free. This bridge just plugs Claude Code into all of that instead of reinventing it.

Standalone bridge between Telegram and Claude Code. Polls the Telegram Bot API
directly and shells out to `claude -p --resume <session>` for every message —
no dependency on `claude --channels` (useful when that's blocked by org
policy, e.g. on an enterprise account).

Each bot instance is bound to one working directory (`cwd` in its config), so
Claude operates as if you'd run `claude` from that folder yourself, with a
persistent session per Telegram chat.

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Running persistently (macOS launchd)](#running-persistently-macos-launchd)
- [Sending proactive messages](#sending-proactive-messages)
- [In-chat commands](#in-chat-commands)
- [Live progress in chat](#live-progress-in-chat)
- [Working placeholder phrases](#working-placeholder-phrases)
- [Other behavior](#other-behavior)
- [Testing](#testing)
- [Security considerations](#security-considerations)

## Requirements

- Node.js 20+ (uses built-in `fetch`, no npm dependencies)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude` must work in your shell)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- macOS, for the optional `launchd` auto-start setup (the bridge itself is cross-platform)
- Optional: `whisper-cli` + a whisper.cpp model for voice message transcription
- Optional: an ElevenLabs API key for voice replies

## Setup

1. Clone the repo and install nothing extra — it's dependency-free.

   ```
   git clone https://github.com/suhocki/telegram-claude-bridge.git
   cd telegram-claude-bridge
   ```

2. Copy the example config and fill it in:

   ```
   cp tldr.config.example.json my-bot.config.json
   ```

   Required fields:

   | Field | Description |
   |---|---|
   | `botToken` | Token from @BotFather |
   | `cwd` | Absolute path to the project Claude should operate in |
   | `allowedUserIds` | Telegram numeric user IDs allowed to talk to the bot (get yours from e.g. @userinfobot) |
   | `stateFile` | Where session/offset state is persisted, e.g. `state/my-bot.json` |

   Optional fields:

   | Field | Description |
   |---|---|
   | `notifyChatId` | Default chat for `notify.mjs` (falls back to `allowedUserIds[0]`) |
   | `groups` | Per-group-chat config, keyed by chat ID — `requireMention` (bot must be @-mentioned) and `allowFrom` (allowed user IDs in that group) |
   | `costWarnUsd` | Warn in-chat once session cost crosses this USD threshold |
   | `voiceTranscription` | `whisperBin`, `modelPath`, `language` for transcribing incoming voice messages |
   | `voiceReply` | `apiKeyPath`, `voiceId`, `modelId`, `maxTtsChars` for ElevenLabs TTS replies |
   | `claudeArgs` | Extra args appended to every `claude -p` invocation |
   | `appendSystemPrompt` | Extra system prompt appended for every message (the example file's default explains the channel-tag format, attachments, and the `ATTACH`/`REACT`/`CHECKIN` reply markers to Claude) |
   | `buttonsModule` | Path (absolute, or relative to `cwd`) to a `.mjs` file exporting `buildKeyboard(context)` and `async handleCallback(callbackData, context)`, for a project's own inline-keyboard buttons. Loaded once and cached. Any tap whose `callback_data` isn't the bridge's own `cancel`/`join`/`continue`/`cfg:*` (the `/config` model/effort picker) is delegated to `handleCallback`; if it returns `{ handled: false }`, the tap is queued as a synthetic text message instead of being silently dropped. If `buttonsModule` isn't configured at all, unrecognized taps are ignored exactly as before (no import attempted) |
   | `maxConcurrentJobs` | Cap on background jobs running at once per bot (see "Background jobs" under [Other behavior](#other-behavior)), default 5 |
   | `jobDefaultTimeoutMinutes` | Default per-job timeout before the bridge kills it, default 60 |
   | `jobSweepIntervalMs` | How often the bridge scans for new job specs and re-checks running jobs, default 15000 |
   | `jobNotifyThreadRecencyMs` | A job spec's `notifyThreadKey` is rejected if that thread hasn't had a turn within this long, default 900000 (15 min); always raised to at least `claudeTurnAbsoluteTimeoutMs` (or, if that's disabled via `0`, to the max delay Node allows) so a slow-but-legitimate turn's own job never gets rejected as stale — the effective default is therefore `claudeTurnAbsoluteTimeoutMs`'s own default of 4h, not 15 min |

   `.gitignore` already excludes `*.config.json` (except `*.config.example.json`) and `state/`, so real tokens never get committed.

3. Run it directly:

   ```
   node bridge.mjs my-bot.config.json
   ```

   Message the bot on Telegram from an allowed user ID and it will run Claude in `cwd` and reply.

## Running persistently (macOS launchd)

A plain `node bridge.mjs ...` in a terminal dies on logout/reboot/terminal close.
Generate and install a `launchd` agent instead:

```
node scripts/gen-launchagent.mjs com.tgbridge.mybot my-bot.config.json com.tgbridge.mybot.plist
cp com.tgbridge.mybot.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tgbridge.mybot.plist
```

This restarts the bridge on crash (`KeepAlive`) and on login (`RunAtLoad`), and
logs to `~/Library/Logs/telegram-bridge-mybot.log`.

After editing the config or pulling new code, restart with:

```
launchctl kickstart -k gui/$UID/com.tgbridge.mybot
```

Run multiple bots/projects by repeating this with a different label and config file.

## Sending proactive messages

`notify.mjs` lets any script push a message through a bot's token without
going through Telegram polling — handy for background jobs to report back:

```
node notify.mjs my-bot.config.json "build finished"
echo "some output" | node notify.mjs my-bot.config.json
node notify.mjs my-bot.config.json "custom text" 123456789   # explicit chat ID
```

Target chat defaults to `config.notifyChatId`, then `config.allowedUserIds[0]`.

## In-chat commands

- `/new` or `/reset` — start a fresh Claude session for this chat
- `/compact` — compact the current session
- `/status` — show current session info (cost, etc.)
- `/voice on` / `/voice off` — toggle sending replies as a voice note (requires `voiceReply` config)
- Replying `CONFIRM` to a risky-command warning lets it proceed; anything else cancels it

In a group, Telegram appends `@yourbotname` when a command is picked from the
group's command-menu suggestion (e.g. `/new@yourbotname`) — that form and the
plain typed form both work.

## Live progress in chat

This isn't "send message, wait, get one reply back" — you watch the agent work in real time, the same way you'd watch it in a terminal:

- **Instant receipt.** The moment your message is accepted, the bot reacts to it with 👀 — no wondering whether it got through.
- **One message, live-edited.** A single placeholder appears — its opening text is a fancy rotating Russian phrase (see [Working placeholder phrases](#working-placeholder-phrases)) instead of a fixed "⏳ working…" — and gets edited in place roughly every 1.3 seconds as Claude thinks, writes, and calls tools — a running transcript (tool calls turning ⏳ → ✅/❌, thinking, streamed reply text) inside one message instead of a flood of new ones. It's deleted outright once the real reply lands, so it never lingers as a stale "done" message.
- **Parallel agents, each visible.** Every subagent Claude spawns gets its *own* live-updating placeholder, threaded as a reply to the root message — fan work out across several subagents and watch all of them progress side by side, each one quietly disappearing once its piece finishes.
- **Rate-limit-safe.** All of a run's placeholders (root + every subagent) share one rate gate — if Telegram throttles one edit, every sibling pauses together instead of the others hammering an already-limited chat.
- **Cancel anytime.** Every in-progress placeholder carries an inline 🚫 Cancel button. Tap it and the run stops immediately (`SIGTERM` to the running `claude` process, `SIGKILL` after a few seconds if it hasn't exited) — no slash command, no waiting for a good moment.
- **Full formatting.** Replies render Telegram's real formatting — **bold**, *italic*, ~~strikethrough~~, inline `code`, fenced code blocks with syntax highlighting, links, and blockquotes — converted straight from Claude's Markdown and chunked to fit Telegram's message-length limit.
- **Reactions as status.** On completion the 👀 reaction is cleared on success (the reply message itself is the completion signal) or flips to 😢 on error, and the Cancel button disappears — glance at a chat full of bots and read the outcome from the reactions alone.

## Working placeholder phrases

The placeholder's opening text is picked from `working-phrases.json` (repo root, shared
across every bot/config) instead of a fixed string. `working-phrases.mjs` keeps a
per-bot queue in its state file: it hands out phrases one at a time, in file order, with
no repeats, and reloads the full list from `working-phrases.json` once the queue runs dry
or the date rolls over.

`scripts/update-working-phrases.mjs` regenerates `working-phrases.json` with a fresh
batch by asking `claude -p` for new Russian phrases; run it by hand or on a schedule:

```
node scripts/update-working-phrases.mjs
```

On failure (e.g. `claude` not on `PATH`, or a malformed response) it leaves the
existing file untouched rather than emptying it.

To run it automatically once a day via `launchd`:

```
node scripts/gen-working-phrases-launchagent.mjs com.tgbridge.working-phrases.plist
cp com.tgbridge.working-phrases.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tgbridge.working-phrases.plist
```

This defaults to 06:00 local time and logs to
`~/Library/Logs/telegram-bridge-working-phrases.log`.

## Other behavior

- **Attachments**: photos, documents, voice/audio/video sent to the bot are downloaded and passed to Claude via an `attachment_path` on the channel tag (voice messages get transcribed first if `voiceTranscription` is configured).
- **Voice-driving agents**: with `voiceTranscription` set up, sending a voice note works just as well as typing — dictate a task on the go and Claude runs it the same as a text message. The opening placeholder freezes into a permanent, quoted transcript instead of the usual fancy phrase, and live progress (plus the Cancel button) moves to a second, ordinary placeholder — so in a group everyone can see what was actually dictated, and it doesn't disappear once the run finishes. Worth setting up the whisper model up front if you plan to mostly drive the bot by voice.
- **Outbound files**: Claude can send files back by writing `ATTACH: /absolute/path` lines in its reply.
- **Reactions**: Claude can react to the triggering message with `REACT: <emoji>`.
- **Check-ins**: Claude can schedule a follow-up turn with `CHECKIN: <minutes> <what to check>` for work that keeps running after the reply is sent.
- **Background jobs**: `run_in_background` (Bash) and background Agents die the instant the turn that started them exits — Claude Code only tracks tasks it thinks it owns, and the bridge's own turn-timeout kill (`process.kill(-pid, ...)`) takes down even a `nohup`'d process, since `nohup` doesn't change the process group. Anything that must outlive the turn instead goes through a bridge-owned job runner: Claude drops a `<jobId>.json` spec file into `state/jobs/<bot>/` (the system prompt tells it the exact path and JSON shape every turn) and ends the turn; the bridge spawns the command detached in its own process group, redirects its output to a log file, and posts a status message in the chat that it keeps live-editing (elapsed time, heartbeat, ETA) until the job finishes. This makes the job independent of the `claude` process tree entirely, so it survives the turn ending, a turn timeout/cancel, and even a bridge restart (jobs still "running" in `state.json` are re-adopted by pid on boot). An optional `onDoneCheckin` on the spec resumes the session automatically once the job finishes, reusing the same check-in machinery as `CHECKIN:`, with an instruction to read the job's log and report the result.
- **Risky command guard**: messages that look like they'd trigger something destructive (`rm -rf`, `git push --force`, `DROP TABLE`, etc.) require an explicit `CONFIRM` reply before running.
- **Cost warnings**: once a session's cumulative cost crosses `costWarnUsd`, the bot warns in-chat and suggests `/new`.
- **Groups**: group chats are ignored unless configured under `groups`; `requireMention` restricts replies to messages that @-mention the bot.

## Testing

Zero-dependency Node test runner:

```
node --test
```

CI (`.github/workflows/ci.yml`) runs the same on every push/PR against `main` with Node 20.

## Security considerations

- All chat content (including anything Claude reads or does via connected tools) transits Telegram's servers as a third-party relay — treat it as leaving your own infrastructure.
- On a managed/corporate machine, EDR and web proxies can typically see the process spawning `claude`/`node` and the outbound HTTPS calls; TLS-inspecting proxies can see payload content too.
- If Claude has other integrations connected (e.g. via MCP) with access to internal systems, running this bridge extends that access to a personal chat channel outside normal oversight — that's a bigger risk than network detection itself.
- Using this on a corporate device may violate acceptable-use, data-handling, or (in regulated industries) communication record-keeping policies, independent of whether it's ever technically detected.
- Won't run / won't reach anything on: air-gapped machines, egress-allowlisted networks (only pre-approved domains reachable), locked-down devices with application allow-listing, or ephemeral VDI sessions with no persistent background process.
- Recommendation: keep this bridge scoped to personal/non-sensitive projects; don't route anything through it that touches employer systems or regulated data.
