# telegram-claude-bridge — working conventions

## Development workflow

Every change (an issue from the GitHub tracker, a bugfix, whatever) goes through this loop:

1. Implement on a branch, with unit tests covering the new behavior and any other automated
   checks that are feasible for the change (e.g. `node --check` syntax check, a lint pass if one
   gets configured). Don't skip tests because the project is small — that's exactly when they're
   cheap to add.
2. Open a PR (`gh pr create`). Never push straight to `main`.
3. Review the PR with a **fresh agent that did not write the code** — no shared context with the
   implementation. Use the `code-review` skill with `--comment` so findings land as inline PR
   comments, not just prose.
4. Fix what the review raises, push, re-review. Repeat steps 3-4 until only minor/nit-level
   comments remain (or none at all).
5. Leave the PR open for the user to merge — do not self-merge. Matches how this user's other
   projects work (see global memory: no self-merge, user reviews and presses merge themselves).

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

## e2e testing constraint

There is no MCP/API access to the human operator's personal Telegram account from a coding
session — only the bot's own token (send/receive as the bot). A true end-to-end test (human
sends a message -> bot processes -> reply arrives) requires the operator to actually send a
message from their own Telegram client; an agent can then verify the round-trip via the bridge's
log/state files, but cannot originate the "incoming user message" side itself.
