# Background jobs that survive the turn — investigation + fix plan

Status: implemented and shipped 2026-08-30 (`jobs.mjs` + job-runner wiring in `bridge.mjs`,
`buildJobMarkerInstructions` in `lib.mjs`). Unit tests (`test/jobs.test.mjs` and friends) and all
5 scripted e2e scenarios from the Test Plan below are green; the final human-in-Telegram
validation step is still owed to the operator. This doc is kept as the investigation record and
design reference — see the PR history on the `feature/background-job-runner` branch for the
implementation itself.

## Problem

When a bridge-driven `claude -p` turn starts background work (Bash with
`run_in_background: true`, or a background Agent), that work dies the moment the turn ends
and the `claude -p` process exits. From the user's point of view a long task "goes to the
background" and silently never completes. There is also no visibility: nothing in the chat
shows how many background tasks exist, whether they are alive, or how long is left.

## Root cause — verified by experiment, not guessed

Three experiments were run on 2026-08-30 (scripts below in "Repro scripts"):

1. **`run_in_background: true` Bash task, turn ends immediately** → the outer `claude -p`
   exited ~26s in; seconds later the background `sleep 45 && write-marker` process was gone
   from `ps` and the marker file was never written. So Claude Code itself tracks its
   backgrounded tasks and kills them on turn exit. This is deterministic (100% repro), not
   a flaky OS thing.
2. **Synchronous Bash that launches `nohup sh -c "..." & disown`, then the turn ends** →
   the outer `claude -p` exited ~10s in; the detached process kept running and wrote its
   marker on schedule. So a process detached *before* the turn ends survives — Claude only
   kills what it knows it owns.
3. (Context) `bridge.mjs` spawns `claude` with `detached: true` and on its own
   idle-timeout (`CLAUDE_TURN_TIMEOUT_MS`, default 20 min of no stdout) kills the **whole
   process group** via `process.kill(-child.pid, ...)`. `nohup` does NOT change the process
   group, so even a nohup-detached task is still killed if the *turn that spawned it* later
   trips the bridge's timeout or gets cancelled. This is the hole that makes an
   instructions-only fix insufficient.

Conclusion on "will better instructions alone fix it": **no.** Instructions can teach the
model to use the nohup pattern (helps a lot, and we should still add them), but the
process-group kill from bridge.mjs, cancel buttons, and bridge restarts
(`launchctl kickstart -k`) can still take the task down, and there is still zero visibility.
The real fix is to move ownership of long tasks out of the `claude` process tree entirely,
into the bridge, which is an immortal launchd daemon.

Existing mechanisms and why they don't cover this:
- `CHECKIN:` marker / `scheduleCheckin` — schedules a *new* `claude -p --resume` later. Good
  for "look at X again in N minutes", useless for keeping a real OS process alive: the
  original process is already dead by then.
- The `/tmp` self-restart trick (nohup'd `sleep N; launchctl kickstart`) — proof the detach
  pattern works, but ad-hoc and invisible.

## Fix design (high level)

Add a **bridge-owned job runner**. The key invariant: a long-running task is never a
descendant of any `claude` process. The bridge spawns it, owns it, watches it, reports on it.

Components, all inside this repo, zero new dependencies:

1. **Job spec files** — a new directory `state/jobs/<botSlug>/`. To start a job, the model
   (inside a turn) writes `<jobId>.json` with: `command` (string, run via `sh -c`), `cwd`,
   `description`, `etaMinutes` (optional), `notifyThreadKey` (which chat/thread to report
   into), and optionally `onDoneCheckin` `{minutes: 0, instruction}` — meaning "when the job
   finishes, resume the session and let it process the result". The turn then just replies
   and exits; it never waits.
2. **Job runner in bridge.mjs** — a watcher (fs polling on the jobs dir, same low-tech style
   as the retention sweep) picks up new spec files, spawns the command `detached: true` in
   its *own* process group (NOT the claude turn's group), redirects stdout/stderr to
   `state/jobs/<botSlug>/<jobId>.log`, and records the job in `state.json`
   (`state.jobs[jobId] = {pid, startedAt, etaMinutes, description, threadKey, status}`).
3. **Heartbeat = liveness check** — the runner checks each running job every ~30s:
   `process.kill(pid, 0)` for aliveness plus log-file mtime as the heartbeat. No cooperation
   needed from the job itself.
4. **Status message** — one bot message per thread with active jobs, edited in place on each
   sweep (reuse the existing `editMessageText` plumbing/rate-gate): for each job its
   description, elapsed time, ETA if given, and heartbeat state (`⏳ alive, last output 12s
   ago` / `⚠️ no output for 5m` / `💀 process gone`). When the last job in a thread finishes,
   edit the message to a final summary. Store the status message id in state so it survives
   bridge restarts.
5. **Completion hook** — when a job exits, mark status (`done`/`failed` + exit code) and, if
   `onDoneCheckin` was set, fire the existing check-in machinery immediately with an
   instruction like "job <id> (<description>) finished with exit code N, log at <path> —
   read it and report the result to the user". This reuses `runCheckin`'s queueing and reply
   plumbing as-is.
6. **Restart resilience** — on boot, re-adopt jobs from `state.json`: if pid still alive,
   resume watching; if dead, report it. Because jobs are their own process groups, a bridge
   restart does NOT kill them (this must be one of the e2e tests).
7. **Prompt instructions** — extend the `--append-system-prompt` builders in `lib.mjs`
   (next to `buildCheckinMarkerInstructions`) with a section telling the model: never use
   `run_in_background` for work that must outlive the turn; instead write a job spec file to
   `<jobs dir>` in the documented format and end the turn; the bridge runs it and reports.
   Include the exact JSON shape and one example.
8. **Safety** — validate specs (allow only when the spec file's parent dir is the expected
   jobs dir; cap concurrent jobs, e.g. 5 per bot; optional `timeoutMinutes` per job with a
   default, killing the job's process group on expiry and reporting it). Job cleanup after
   N days rides the existing retention sweep.

Out of scope for the first PR (note as follow-up issues if tempted): a cancel-job inline
button, cross-bot job listing, resource limits.

## Expected result

- A turn can start an hours-long task and reply instantly; the task keeps running after the
  turn exits, after a turn timeout, and after a bridge restart.
- The chat always shows a live, self-updating status message while jobs run: count, per-job
  heartbeat, elapsed/ETA — so the user knows what is still pending and when to check back.
- When a job ends, the session is resumed automatically (if requested) and the model reports
  the actual result, reading the job's log.
- The old failure mode (silent death of `run_in_background` work) is prevented by the new
  system-prompt instructions steering the model to the job runner.

## Test plan — all must pass before merge

Unit (node --test, zero deps, matches existing `test/` style — pure functions in `lib.mjs`
or a new `jobs.mjs`, heavy fs/spawn parts behind injectable seams):

- job spec validation: accepts the documented shape, rejects missing command/threadKey,
  rejects a path outside the jobs dir, rejects when over the concurrent-jobs cap.
- state transitions: pending → running → done/failed/timed-out; boot-time re-adoption logic
  for alive vs dead pids.
- status message rendering: given a set of jobs with fake timestamps, renders the expected
  text (alive / stale heartbeat / dead / final summary).
- completion → check-in instruction building.

Repro/e2e (scripted, no human needed except the final one):

- **Before/after A (the original bug path, expectation unchanged):** spawn
  `claude -p 'run sleep 45 && write marker via run_in_background, reply started'`; assert
  the marker does NOT appear. This documents the failure mode still exists upstream — the
  fix is that our instructions route around it.
- **After B (job runner happy path):** start a bridge against a scratch config; drop a job
  spec for `sleep 30 && date > marker`; assert: job picked up, status message sent and
  edited, marker written, job marked done, check-in fired.
- **After C (turn-timeout survival):** start a job, then kill the claude turn's process
  group the way bridge.mjs does (`process.kill(-pid)`); assert the job survives and
  completes.
- **After D (bridge-restart survival):** start a 60s job, `launchctl kickstart -k` (or just
  kill and relaunch the scratch bridge process); assert the job is re-adopted and its
  completion still reported.
- **After E (dead-job detection):** start a job, kill the job's pid directly; assert the
  status message flips to dead/failed and reports.

Final human validation (only step needing the operator): from Telegram ask the bot to run a
~2-minute background task; observe instant reply + live status message + final result
message. Then we consider this closed.

## Repro scripts (from the 2026-08-30 investigation)

Kill test — background task dies with the turn (marker must NOT appear):

```js
// /tmp/repro-test.mjs
import { spawn } from 'node:child_process'
const child = spawn('claude', [
  '-p',
  'Run Bash with run_in_background true: `sleep 45 && date > /tmp/repro-marker.txt`. Do NOT wait for it. Immediately reply "started" and end your turn.',
  '--output-format', 'json', '--permission-mode', 'bypassPermissions',
], { cwd: '/tmp', detached: true })
child.on('close', c => console.log('closed', c, new Date().toISOString()))
```

Survival test — pre-detached process outlives the turn (marker MUST appear; note macOS has
no `setsid`, plain `nohup ... & disown` was verified to work):

```js
// /tmp/repro-test3.mjs — same wrapper, prompt:
// Run this exact Bash command WITHOUT run_in_background:
// `nohup sh -c "sleep 20 && date > /tmp/repro-marker3.txt" >/tmp/repro-log3.txt 2>&1 < /dev/null & disown; echo launched`
// Then immediately reply "started" and end your turn.
```

## Key code landmarks

- `bridge.mjs`: `runClaude()` (spawn + timeouts + group kill), `scheduleCheckin`/`runCheckin`
  (reuse for completion hook), retention sweep timer (pattern for the jobs sweep),
  `createPlaceholderController` (editMessageText plumbing + rate gate).
- `lib.mjs`: `build*MarkerInstructions` (pattern for the new job instructions),
  `atomicWriteFileSync`, `threadKey`/`parseThreadKey`.
- `state/` layout: per-bot namespacing via `botSlug` (see `inboxDir`/`outboxDir`).
