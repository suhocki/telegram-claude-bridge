# Roadmap

Status: living checklist, started 2026-10-29, revised the same day after a critical multi-agent
review (see [Review findings](#review-findings-2026-10-29)). Tick items off as they land; add new
ideas to [Idea backlog](#idea-backlog) first and promote them into a phase once they're worth
doing.

## North star

**Your agent, on your own computer, driven from Telegram — and safe to leave running.**
The agent works where your files, repos and logged-in browser already are; Telegram is the
remote control. Credentials never leave your machine, and what the agent is *allowed* to do is
bounded by design, not by trust.

Audience: developers and automation-minded power users who already use a coding agent — not
"everyone". The average person is served fine by the ChatGPT/Gemini app; we don't compete there.

## Where we are (2026-10-29)

- Feature depth is strong: topics as separate sessions, live thinking/log streaming, voice
  both ways, attachments, background jobs that survive the turn, `/rewind` by editing a message,
  inline buttons, pinned config message, landing site.
- Distribution is ~zero: 2 GitHub stars, 0 forks after 347 commits / 134 PRs. Nothing has
  been posted anywhere.
- Setup is developer-only: BotFather token by hand, JSON config, macOS `launchd`, local
  `whisper-cli`.
- Security is "full trust": every turn runs `claude -p --permission-mode bypassPermissions`
  (`bridge.mjs`). Whoever controls the bot token or the owner's Telegram account gets a shell
  and the logged-in browser. "Local" alone is not a safety story yet.
- Platform risk: Anthropic ships its own `--channels` / Telegram plugin and mobile access, so
  chat → agent, streaming, voice and files get commoditized within ~12 months.

## Priorities

- **P0** — do next.
- **P1** — needed before calling it production-safe.
- **P2** — differentiators / hedges.
- **P3** — nice to have / exploratory.

---

## Phase 0 — Distribution before code (P0, feature freeze until ~100 stars)

- [ ] One 30-second video of the aha moment: voice note → live thinking stream → edit the
      message → agent rewinds and redoes it → background job reports while the phone is locked.
- [ ] Rewrite the top of `README.md`: GIF, one-sentence pitch, 3-step quick start. Move the
      config reference table further down (or into `docs/`).
- [ ] Pitch to test: *"Telegram as the IDE for your agent: a topic is a session, edit a message
      to rewind, jobs keep running while the phone is in your pocket."*
- [ ] Launch day: Show HN + r/ClaudeAI with the video, same day.
- [ ] Russian-speaking launch: Habr article + 3-5 AI/dev Telegram channels. The audience lives
      in Telegram, so does the product — strongest unfair advantage.
- [ ] Get listed: awesome-claude-code style lists, Claude Code plugin/marketplace listings.
- [ ] Project Telegram channel for changelog + demos.
- [ ] Consider a distinctive name — `telegram-claude-bridge` is generic and becomes wrong once
      other agent backends are supported.

## Phase 1 — Install in one command, on your own machine (P0)

- [ ] `npx telegram-claude-bridge init`: interactive wizard — BotFather steps with links,
      detects the owner's user ID from the first `/start`, writes config, installs the
      service. The bot then continues onboarding inside the chat.
- [ ] Bot creation without copy-pasting the token, via Telegram **Managed Bots** (Bot API 9.6,
      `t.me/newbot/{manager}/{username}` + `getManagedBotToken`): a small setup-only manager
      bot creates the user's personal bot after one confirmation tap and hands the token to the
      local installer via a pairing code, without storing it. Open questions before building:
      can the child bot be detached from the manager afterwards (the manager can otherwise
      always re-fetch/rotate the token), and how to make "we never keep your token" verifiable.
      The manual BotFather path stays as the zero-trust option.
- [ ] Linux support: `systemd` unit generator alongside `scripts/gen-launchagent.mjs`
      (home server / always-on mini PC).
- [ ] Config from env vars as well as JSON.
- [ ] Voice transcription fallback via an API when `whisper-cli` isn't installed.
- [ ] Versioned releases + changelog (tags, GitHub Releases), `/update` command.
- [ ] Docs: "keep the machine awake" guidance (caffeinate / power settings) and what happens
      when it sleeps.

## Phase 2 — Safe by design (P1, this is what makes "local-first" actually sell)

The question a user asks is not "where is my data?" but "if the bot goes rogue, what can it
break?". Today the answer is "everything". These items change that answer.

- [ ] **Capability modes instead of blanket bypass**: e.g. `read-only` (default for new
      installs) / `workspace` (write only inside allowlisted dirs/repos) / `full`. Switchable
      from the pinned config message.
- [ ] **Policy allowlist, not approve-everything**: allowed dirs, repos, commands, domains.
      Approvals only for "irreversible AND outside the allowlist" to avoid approval fatigue.
- [ ] **Confirm on the machine, not only in Telegram** for escalations (macOS notification /
      Touch ID / local code). The control channel must not be the only approval channel — a
      hijacked Telegram account can press "Allow" too.
- [ ] **Separate browser profile** for the agent — no bank/primary email by default; the user
      logs into what the agent may use, themselves.
- [ ] **Audit log**: append-only local log of tool calls and side effects, `/audit 24h` command
      with a readable summary and export.
- [ ] **Kill switch + dead-man pause**: `/stop all`, and auto-pause risky work if no local
      confirmation within N minutes.
- [ ] Prompt-injection hygiene: treat web/email content as untrusted in the system prompt,
      block outbound requests to non-allowlisted domains in restricted modes.
- [ ] Document the threat model honestly: Telegram bots are not end-to-end encrypted; bot
      token / account takeover implications; recommended Telegram 2FA.

## Phase 3 — Hedges and differentiators (P2)

Things platform vendors are unlikely to build.

- [ ] **Multiple agent backends** — Codex CLI, Gemini CLI, opencode behind the same bridge.
      The single biggest hedge against Anthropic shipping the obvious version.
- [ ] **Positioning for blocked environments**: Claude Code from your phone where the org
      policy disables `--channels` (already the bridge's origin story — make it a headline for
      the enterprise segment).
- [ ] **Mobile review console**: approve/deny buttons + readable diff viewer (Telegram Mini
      App or rendered images) — "review and ship on the go".
- [ ] **Team mode**: the agent in a team's group chat, topic per project, roles (who may run
      what), shared budget, audit per user. Self-hosted. The most likely paid segment.
- [ ] Scheduled tasks managed from the chat ("every morning check X and send a summary").
- [ ] Personal automation recipes for power users who need a real logged-in browser:
      marketplace monitoring, price watching, form filling (e.g. the Allegro flow).

## Deferred — hosted / one-tap for everyone

Hosted multi-tenant ("press /start on an official bot, done") contradicts local-first, is
expensive and risky to run solo, and competes head-on with Anthropic/OpenAI/Telegram itself.
Revisit only if Phase 0 shows clear demand from non-developers. Optional "deploy to your own
VPS" (Docker image, cloud-init) can live here too if users ask for it.

## Review findings (2026-10-29)

Four independent critical reviews (consumer need, security/trust, competition/moat, growth).
Consensus:

- The average person doesn't need this; ChatGPT/Gemini apps cover one-off tasks. Real need is
  in developers, enterprise devs blocked from official channels, and automation power users.
- "Local-first" is not a selling point by itself — every Claude Code user is already local.
  It only becomes one with a containment story (Phase 2).
- Chat ↔ agent, streaming, voice and files will be commoditized by the platforms. What
  survives: agent-agnosticism, Telegram-native depth (topics, groups, teams), and domain
  workflows the platforms won't build.
- 2 stars is a distribution problem, not a feature problem. Stop adding features until the
  existing ones have been shown to people.
- Pick one north star: the earlier "runs on a server" and "local-first" were contradictory.
  Local-first won.

## Idea backlog

Unsorted. Promote into a phase with a priority when it earns it.

- [ ] Share a topic's transcript as a public read-only link (demos, support).
- [ ] Weekly cost / activity digest per bot.
- [ ] Localisation of bot UI strings (RU / EN at minimum).
- [ ] Wake-on-LAN / "wake my Mac" helper for when the machine sleeps.
