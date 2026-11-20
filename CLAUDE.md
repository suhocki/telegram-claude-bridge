# telegram-claude-bridge — working conventions

## Development workflow

No PR or review loop (the user dropped it on 2026-11-20). For every change:

1. Implement it with unit tests for the new behavior, plus `node --check` on touched files.
2. Run `npm test`. If everything passes and the change is verified, commit and push straight to `main`.
3. Restart the affected bots if needed (`launchctl kickstart -k gui/$UID/<label>`). If something breaks,
   the user notices quickly and asks for a fix as a separate task.

Restarting `com.tgbridge.tldr` from a turn that runs inside the tldr bot kills that turn too. Do it
through a delayed bridge job, or reply first.

## Testing

No test framework is installed yet — default to Node's built-in `node --test` + `node:assert`
runner to keep the project dependency-free (matches the existing zero-dependency style of
`bridge.mjs`, which only uses built-in `fetch`/`child_process`/`fs`). Only reach for an external
test/lint dependency if a real need shows up.

## Running as a launchd agent (macOS)

Manually backgrounding `node bridge.mjs ...` dies on logout/reboot/terminal close. Instead,
generate a `launchd` agent per bot/project (mirrors the pattern used for the yt-digest local
worker: `KeepAlive`, a log file under `~/Library/Logs/`):

```
node scripts/gen-launchagent.mjs com.tgbridge.tldr tldr.config.json com.tgbridge.tldr.plist
cp com.tgbridge.tldr.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.tgbridge.tldr.plist
```

This writes stdout/stderr to `~/Library/Logs/telegram-bridge-tldr.log` and restarts the bridge on
crash (`KeepAlive: true`) or login (`RunAtLoad: true`). `WorkingDirectory` is set to the repo dir
so the config/state paths in `tldr.config.json` resolve.

To restart after editing the config or pulling new code:

```
launchctl kickstart -k gui/$UID/com.tgbridge.tldr
```

The Anthropic API key is not in the plist. `bridge.mjs` reads it at startup from the macOS
Keychain item `anthropic-api-key` (override the name with `ANTHROPIC_API_KEY_KEYCHAIN_SERVICE`;
an env var that is already set wins). To set or rotate it:

```
security add-generic-password -U -a "$USER" -s anthropic-api-key -w
```

then kickstart every bot.

For a second bot/project, repeat with a different label, e.g. `com.tgbridge.ig` and
`ig.config.json`.

## Rewind on an edited message

Editing a Telegram message rewinds the conversation to just before that turn. There is no CLI
flag for this: `claude -p --resume <id>` keeps appending to the same session transcript at
`~/.claude/projects/<cwd-with-non-alphanumerics-replaced-by-dashes>/<session-id>.jsonl`, and it
resumes from the last entry in that file. So the bridge finds the `type: "user"` line carrying
`message_id="<edited id>"` (the bridge's own `<channel …>` prompt wrapper is the anchor) and
truncates the file there, backing the original up to `state/rewind-backups/<session-id>.jsonl`
first. This leans on Claude Code's on-disk transcript layout — if a future version changes it,
rewind degrades to the "can't rewind" notice rather than breaking normal replies.

The bot also deletes its own messages from that turn onwards (`state.turns` tracks them per
chat). It cannot delete the user's own later messages — a bot has no such permission in a
private chat.

## Bot command menu and scopes

`setMyCommands` without a `scope` only writes the `default` list. Telegram picks the menu from
the *narrowest* matching scope, so a list left on the token by an earlier bot — these tokens
previously ran an off-the-shelf client that registered `/start`, `/help`, `/status` under
`all_private_chats` — keeps winning in DMs and looks exactly like a stale client-side cache. It
isn't: no amount of blocking/restarting the bot or reinstalling the app changes it. On startup
the bridge therefore runs `deleteMyCommands` for `all_private_chats`, `all_group_chats` and
`all_chat_administrators` before `setMyCommands`. Chat-specific scopes can't be enumerated over
the API — if one ever gets set on a chat, delete it by hand for that `chat_id`.

To check what a token actually serves:

```
curl -sG "https://api.telegram.org/bot$TOKEN/getMyCommands" --data-urlencode 'scope={"type":"all_private_chats"}'
```

## e2e testing constraint

There is no MCP/API access to the human operator's personal Telegram account from a coding
session — only the bot's own token (send/receive as the bot). A true end-to-end test (human
sends a message -> bot processes -> reply arrives) requires the operator to actually send a
message from their own Telegram client; an agent can then verify the round-trip via the bridge's
log/state files, but cannot originate the "incoming user message" side itself.
