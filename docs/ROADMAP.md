# Roadmap

Status: living checklist, started 2026-10-29. Tick items off as they land; add new ideas to
[Idea backlog](#idea-backlog) first and promote them into a phase once they're worth doing.

## North star

**One tap → your own AI agent in your personal Telegram.** A user who has never heard of
BotFather, Node, launchd or `claude -p` presses one button and gets a chat with threads
(one topic per project/task), live progress, voice in and out, files, and background jobs —
running on a server, not on their laptop.

## Where we are (2026-10-29)

- Feature depth is strong: topics as separate sessions, live thinking/log streaming, voice
  both ways, attachments, background jobs that survive the turn, `/rewind`, inline buttons,
  pinned config message, landing site.
- Distribution is ~zero: 2 GitHub stars, 0 forks after 347 commits / 134 PRs.
- Setup is developer-only: BotFather token by hand, JSON config, macOS `launchd`, local
  `whisper-cli`, a logged-in `claude` CLI on the same machine.
- Platform risk: Anthropic ships its own `--channels` / Telegram plugin and mobile access, so
  "run Claude from your phone" alone is not a moat. The moat has to be the Telegram-native UX
  plus a zero-friction install plus an audience.

**Takeaway: the next bottleneck is packaging and distribution, not features.** Phase 0 and 1
come before any new feature work.

## Priorities

- **P0** — blocks the north star or distribution; do next.
- **P1** — needed for a real public launch.
- **P2** — strong differentiators, after launch.
- **P3** — nice to have / exploratory.

---

## Phase 0 — Show what exists (P0, ~2 weeks, feature freeze)

- [ ] Record 2-3 short (≤60s) demo videos: voice task → live progress → diff/file back;
      parallel topics per project; background job finishing while the phone is locked.
- [ ] Rewrite the top of `README.md` around one GIF + a 3-step quick start.
- [ ] Publish the landing site (`site/`) on a real domain (GitHub Pages / Cloudflare Pages).
- [ ] Write one launch post in Russian (Habr) and one in English (dev.to / blog).
- [ ] Post to: r/ClaudeAI, Show HN, Russian-speaking AI/dev Telegram channels.
- [ ] Start a Telegram channel for the project (changelog + demos) — the audience lives in
      Telegram anyway.
- [ ] Track: stars, installs (see Phase 2 telemetry), and *what people ask for* — that decides
      between the directions in [Strategic directions](#strategic-directions).

## Phase 1 — Runs anywhere, installs with one command (P0)

Prerequisite for any server deployment: today the bridge assumes macOS + a local CLI.

- [ ] Linux support: `systemd` unit generator alongside `scripts/gen-launchagent.mjs`.
- [ ] `Dockerfile` + `docker-compose.yml`: Node, Claude Code CLI, whisper.cpp + a small model,
      state volume, health check. Image published to GHCR on every release.
- [ ] Config from env vars (not only JSON files) so container/PaaS deploys need no file editing.
- [ ] `npx telegram-claude-bridge init`: interactive wizard — asks for the bot token, links to
      BotFather with exact steps, detects the user ID from the first `/start`, writes config,
      installs the launchd/systemd service.
- [ ] Headless auth for the agent on a server: `ANTHROPIC_API_KEY` (BYOK) path documented and
      tested; check what Anthropic's terms allow for subscription tokens on third-party hosts
      before offering that option.
- [ ] Voice transcription fallback via an API when `whisper-cli` isn't installed.
- [ ] Versioned releases + changelog (tags, GitHub Releases).

## Phase 2 — One-click on your own server (P1)

"One button" for people willing to own a VPS. No shared infrastructure on our side yet.

- [ ] "Deploy" buttons: Railway / Render / Fly.io templates using the Docker image.
- [ ] Hetzner / DigitalOcean `cloud-init` script: paste into "user data", get a running bot.
- [ ] First-run onboarding inside Telegram: the bot greets the owner, enables topics, creates a
      starter topic, walks through choosing model / connecting a GitHub repo.
- [ ] Self-update command (`/update`) that pulls the new image/version and restarts.
- [ ] Opt-in anonymous install telemetry (count of active installs, version) — needed to know
      if anything is working.
- [ ] Security hardening for an internet-facing box: non-root user, workspace sandbox,
      secrets out of the repo dir, documented threat model (update
      `README.md#security-considerations`).

## Phase 3 — Hosted: press /start, done (P1, the real north star)

The only version where a non-developer gets it with literally one tap: a **shared, official
bot** (no BotFather step at all) backed by a multi-tenant service.

- [ ] Architecture doc: one public bot → router → per-user isolated workspace
      (container / Firecracker VM / per-user VPS), per-user session + state storage.
- [ ] Per-user isolation and resource limits (CPU, disk, network egress, job count).
- [ ] Billing: BYOK (user's API key) first; then our own plans with usage-based limits.
- [ ] Workspace persistence + backups; export/delete-my-data command.
- [ ] Abuse controls: rate limits, spend caps, kill switch.
- [ ] "Bring your own bot" option kept for power users who want their own token/branding.
- [ ] Legal: ToS, privacy policy, data processing — required before taking anyone's money.

## Phase 4 — Differentiators (P2)

Things official clients are unlikely to build, ranked by expected pull.

- [ ] **Approve dangerous actions with buttons** — e.g. "agent wants to `git push --force` →
      Allow / Deny", instead of blanket bypass permissions.
- [ ] **Telegram Mini App dashboard** — sessions, background jobs, cost per topic, settings
      without JSON, diff viewer for the last turn.
- [ ] **Multiple agent backends** — Codex CLI, Gemini CLI, opencode behind the same bridge.
      Biggest single hedge against platform risk.
- [ ] **Scheduled tasks UI** — "every morning at 9 check X and send a summary", managed from
      the chat.
- [ ] **Team / group mode** — the agent lives in a team's group chat, a topic per project,
      roles (who may run what), shared budget, per-user cost attribution.
- [ ] Project templates / skills gallery for non-developers (inbox triage, price watcher,
      daily digest, research assistant).
- [ ] Integrations via MCP presets: Gmail, Google Calendar, Notion, GitHub — one-tap connect.

## Strategic directions

Decide after Phase 0 based on who actually shows up. Not mutually exclusive, but focus wins.

1. **Open-source dev tool** — Claude Code power users who want mobile control. Realistic
   ceiling: a few thousand users. Pays in reputation/audience, not money. Lowest effort.
2. **Personal agent for everyone** — Phase 3 at consumer scale. Huge audience (Telegram, esp.
   CIS), but crowded (OpenClaw-style agents, OpenAI/Anthropic apps, Telegram's own AI) and
   expensive to run. Hard solo.
3. **AI teammate in team chats** — agencies/studios/small teams that already work in Telegram.
   Smaller audience, but each team can pay $20-200/month, and big platforms are unlikely to
   chase this regional niche. Most business-like option.

Signals to watch: teams asking for group-chat features → 3. Many non-dev users stuck at setup
→ 2. Mostly developers starring and filing PRs → 1.

## Idea backlog

Unsorted. Promote into a phase with a priority when it earns it.

- [ ] Share a topic's transcript as a public link (read-only) — good for demos and support.
- [ ] Weekly cost / activity digest per bot.
- [ ] Mobile-friendly diff rendering as images for long diffs.
- [ ] Localisation of bot UI strings (RU / EN at minimum).
- [ ] Referral / invite flow for the hosted version.
