# telegram-claude-bridge

Standalone bridge between Telegram and Claude Code. Polls the Telegram Bot API
directly and shells out to `claude -p --resume <session>` for every message —
no dependency on `claude --channels` (useful when that's blocked by org
policy, e.g. on an enterprise account).

Each bot instance is bound to one working directory (`cwd` in its config), so
Claude operates as if you'd run `claude` from that folder yourself, with a
persistent session per Telegram chat.

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

## Other behavior

- **Attachments**: photos, documents, voice/audio/video sent to the bot are downloaded and passed to Claude via an `attachment_path` on the channel tag (voice messages get transcribed first if `voiceTranscription` is configured).
- **Outbound files**: Claude can send files back by writing `ATTACH: /absolute/path` lines in its reply.
- **Reactions**: Claude can react to the triggering message with `REACT: <emoji>`.
- **Check-ins**: Claude can schedule a follow-up turn with `CHECKIN: <minutes> <what to check>` for work that keeps running after the reply is sent.
- **Risky command guard**: messages that look like they'd trigger something destructive (`rm -rf`, `git push --force`, `DROP TABLE`, etc.) require an explicit `CONFIRM` reply before running.
- **Cost warnings**: once a session's cumulative cost crosses `costWarnUsd`, the bot warns in-chat and suggests `/new`.
- **Groups**: group chats are ignored unless configured under `groups`; `requireMention` restricts replies to messages that @-mention the bot.

## Testing

Zero-dependency Node test runner:

```
node --test
```

CI (`.github/workflows/ci.yml`) runs the same on every push/PR against `main` with Node 20.
