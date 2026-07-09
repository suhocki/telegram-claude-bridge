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

## e2e testing constraint

There is no MCP/API access to the human operator's personal Telegram account from a coding
session — only the bot's own token (send/receive as the bot). A true end-to-end test (human
sends a message -> bot processes -> reply arrives) requires the operator to actually send a
message from their own Telegram client; an agent can then verify the round-trip via the bridge's
log/state files, but cannot originate the "incoming user message" side itself.
