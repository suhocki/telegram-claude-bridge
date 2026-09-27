// Pure, testable helpers for the bridge-owned background job runner (see docs/background-jobs-plan.md).

import path from 'node:path'
import { CHECKIN_MAX_MINUTES } from './lib.mjs'

export const DEFAULT_MAX_CONCURRENT_JOBS = 5
export const DEFAULT_JOB_TIMEOUT_MINUTES = 60
export const JOB_HEARTBEAT_STALE_MS = 5 * 60 * 1000
export const DEFAULT_JOB_NOTIFY_THREAD_RECENCY_MS = 15 * 60 * 1000
// Floor on how often the (subprocess-spawning) one-shot stale-heartbeat diagnosis check may re-run for the same job — it's cheap but not free, and this runs in a shared poll loop across every active job for every bot.
export const JOB_STALE_DIAGNOSIS_MIN_INTERVAL_MS = 3 * 60 * 1000
export const JOB_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
// __proto__ would reassign state.jobs's own prototype via state.jobs[jobId] = ...; the other two are blocked too, just in case.
const RESERVED_JOB_IDS = new Set(['__proto__', 'constructor', 'prototype'])

export function resolveJobsDir(stateDir, botSlug) {
  return path.join(stateDir, 'jobs', botSlug)
}

export function buildJobSpecPath(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.json`)
}

export function buildJobLogPath(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.log`)
}

export function isPathInsideDir(filePath, dir) {
  const resolved = path.resolve(filePath)
  const resolvedDir = path.resolve(dir)
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep)
}

// age >= 0 rejects a future timestamp (a backward clock step) as not-recent instead of failing open on a negative subtraction.
export function isRecentTimestamp(timestamp, now, maxAgeMs) {
  if (typeof timestamp !== 'number') return false
  const age = now - timestamp
  return age >= 0 && age <= maxAgeMs
}

export function isJobActive(record) {
  return record?.status === 'pending' || record?.status === 'running'
}

export function countActiveJobs(jobsMap) {
  return Object.values(jobsMap ?? {}).filter(isJobActive).length
}

export function validateJobSpec(
  spec,
  {
    jobId,
    jobsDir,
    filePath,
    activeCount = 0,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    isThreadKeyAuthorized = () => true,
    isThreadRecentlyActive = () => true,
  } = {}
) {
  if (!JOB_ID_RE.test(String(jobId ?? '')) || RESERVED_JOB_IDS.has(jobId)) return { ok: false, error: `invalid job id: ${jobId}` }
  if (filePath != null && jobsDir != null && !isPathInsideDir(filePath, jobsDir)) {
    return { ok: false, error: `job spec path is outside the jobs directory: ${filePath}` }
  }
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'job spec is not an object' }
  if (typeof spec.command !== 'string' || !spec.command.trim()) return { ok: false, error: 'job spec is missing "command"' }
  if (typeof spec.description !== 'string' || !spec.description.trim()) {
    return { ok: false, error: 'job spec is missing "description"' }
  }
  if (typeof spec.notifyThreadKey !== 'string' || !spec.notifyThreadKey.trim()) {
    return { ok: false, error: 'job spec is missing "notifyThreadKey"' }
  }
  if (!isThreadKeyAuthorized(spec.notifyThreadKey)) {
    return { ok: false, error: `"notifyThreadKey" (${spec.notifyThreadKey}) is not an authorized chat/thread for this bot` }
  }
  if (!isThreadRecentlyActive(spec.notifyThreadKey)) {
    return {
      ok: false,
      error: `"notifyThreadKey" (${spec.notifyThreadKey}) hasn't had any recent turn activity — refusing to notify what looks like a stale or wrong thread`,
    }
  }
  if (spec.cwd != null && (typeof spec.cwd !== 'string' || !spec.cwd.trim())) {
    return { ok: false, error: '"cwd" must be a non-empty string when given' }
  }
  if (spec.etaMinutes != null && !(typeof spec.etaMinutes === 'number' && spec.etaMinutes > 0)) {
    return { ok: false, error: '"etaMinutes" must be a positive number when given' }
  }
  if (spec.timeoutMinutes != null && !(typeof spec.timeoutMinutes === 'number' && spec.timeoutMinutes > 0)) {
    return { ok: false, error: '"timeoutMinutes" must be a positive number when given' }
  }
  if (spec.onDoneCheckin != null) {
    const c = spec.onDoneCheckin
    if (typeof c !== 'object') return { ok: false, error: '"onDoneCheckin" must be an object when given' }
    if (c.minutes != null && !(typeof c.minutes === 'number' && c.minutes >= 0 && c.minutes <= CHECKIN_MAX_MINUTES)) {
      return { ok: false, error: `"onDoneCheckin.minutes" must be a number between 0 and ${CHECKIN_MAX_MINUTES} when given` }
    }
    if (c.instruction != null && typeof c.instruction !== 'string') {
      return { ok: false, error: '"onDoneCheckin.instruction" must be a string when given' }
    }
  }
  if (activeCount >= maxConcurrentJobs) return { ok: false, error: `concurrent job cap reached (${maxConcurrentJobs})` }
  return { ok: true }
}

export function createJobRecord({ id, spec, now, logPath, defaultTimeoutMinutes = DEFAULT_JOB_TIMEOUT_MINUTES }) {
  return {
    id,
    description: spec.description,
    command: spec.command,
    cwd: spec.cwd ?? null,
    etaMinutes: spec.etaMinutes ?? null,
    timeoutMinutes: spec.timeoutMinutes ?? defaultTimeoutMinutes,
    notifyThreadKey: spec.notifyThreadKey,
    onDoneCheckin: spec.onDoneCheckin ?? null,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    lastHeartbeatAt: now,
    finishedAt: null,
    exitCode: null,
    signal: null,
    pid: null,
    logPath,
    killedForTimeout: false,
    reported: false,
    staleDiagnosis: null,
  }
}

export function markJobRunning(record, pid, now) {
  return { ...record, status: 'running', pid, startedAt: now, lastHeartbeatAt: now }
}

export function markJobFinished(record, { status, exitCode = null, signal = null, now }) {
  return { ...record, status, exitCode, signal, finishedAt: now }
}

// A dead pid on boot could mean the job actually finished or actually failed — the real exit code is unrecoverable across a restart, so it's "unknown" rather than guessed as either (unless it was already flagged for a timeout kill, which is a known reason).
export function reconcileJobsOnBoot(jobsMap, isAlivePid, now) {
  const jobs = { ...jobsMap }
  const deadJobIds = []
  for (const [jobId, record] of Object.entries(jobs)) {
    if (!isJobActive(record)) continue
    if (record.pid != null && isAlivePid(record.pid)) continue
    jobs[jobId] = markJobFinished(record, { status: record.killedForTimeout ? 'timed-out' : 'unknown', now })
    deadJobIds.push(jobId)
  }
  return { jobs, deadJobIds }
}

export function computeHeartbeatState(record, now, staleMs = JOB_HEARTBEAT_STALE_MS) {
  if (!isJobActive(record)) return null
  const age = now - (record.lastHeartbeatAt ?? record.startedAt ?? now)
  return age > staleMs ? 'stale' : 'alive'
}

// Throttle gate for the one-shot stale-heartbeat diagnosis check: re-run only every few minutes per job, keyed off the cached result's own timestamp rather than a separate side table.
export function shouldRunStaleDiagnosis(record, now, minIntervalMs = JOB_STALE_DIAGNOSIS_MIN_INTERVAL_MS) {
  const checkedAt = record.staleDiagnosis?.checkedAt
  return checkedAt == null || now - checkedAt >= minIntervalMs
}

// Prompt for the cheap one-shot model call that turns raw stale-heartbeat signal into a short human-readable status phrase. Pure text formatting — the actual subprocess call lives in bridge.mjs.
export function buildStaleDiagnosisPrompt({ description, staleSinceMs, logTail, branch, prUrl, prNumber }) {
  const lines = [
    'A background job spawned by an automation bridge has not produced new log output in a while.',
    'The job\'s process is confirmed still alive (its pid exists) — this is NOT a report that the job has died.',
    '',
    `Job description: ${description}`,
    `No new log output for: ${formatDuration(staleSinceMs)}`,
    '',
    branch ? `Git working directory branch: ${branch}` : 'Not running inside a git repository (no branch info available).',
  ]
  if (prUrl) lines.push(`Open pull request: #${prNumber} — ${prUrl}`)
  else if (branch) lines.push('No open pull request currently known for this branch.')
  lines.push(
    '',
    'Tail of its log file (may be empty if nothing has been written yet):',
    '---',
    logTail?.trim() ? logTail.trim() : '(empty)',
    '---',
    '',
    "Based only on this, write ONE short, honest, human-readable status phrase (under about 20 words, no markdown, no emoji) describing what's probably going on right now — for example noting an open PR number and that review/tests/merge are probably still running, or noting that nothing has visibly changed in a long time and it might be genuinely stuck.",
    'Do not guess wildly beyond the evidence given — if the signal is too thin to say anything useful, say so plainly instead of inventing detail.',
    'Also decide: does this genuinely look stuck or failed in a way that is not already obvious, as opposed to plausibly still working?',
    '',
    'Respond with ONLY a single-line JSON object, no code fences, no prose: {"phrase": "...", "looksStuckOrFailed": true|false}'
  )
  return lines.join('\n')
}

// Parses the model's own JSON reply from buildStaleDiagnosisPrompt above. Never throws — returns null on any malformed/missing output so the caller falls back to the bare heartbeat line.
export function parseStaleDiagnosisResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(rawText.trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed.phrase !== 'string' || !parsed.phrase.trim()) return null
  return { phrase: parsed.phrase.trim(), looksStuckOrFailed: Boolean(parsed.looksStuckOrFailed) }
}

// Plain message sent to the job's notify thread (not a status-line edit) the first time a diagnosis concludes the job genuinely looks stuck or failed.
export function buildStaleJobAlertMessage(job) {
  const phrase = job.staleDiagnosis?.phrase
  return `🚨 background job "${job.description}" (id ${job.id}) looks stuck or failed${phrase ? `: ${phrase}` : ''} — I'll leave it running, but you should take it from here.`
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function renderJobLine(job, now, staleMs = JOB_HEARTBEAT_STALE_MS) {
  const elapsed = formatDuration(now - (job.startedAt ?? job.createdAt))
  const eta = job.etaMinutes ? `, eta ${job.etaMinutes}m` : ''
  if (job.status === 'pending') return `⏳ ${job.description} — starting…`
  if (job.status === 'running') {
    const since = formatDuration(now - (job.lastHeartbeatAt ?? job.startedAt))
    const isStale = computeHeartbeatState(job, now, staleMs) === 'stale'
    const heartbeatText = isStale
      ? job.staleDiagnosis?.phrase
        ? `⚠️ ${job.staleDiagnosis.phrase}`
        : `⚠️ no output for ${since}`
      : `alive, last output ${since} ago`
    return `⏳ ${job.description} — ${elapsed} elapsed${eta} — ${heartbeatText}`
  }
  if (job.status === 'done') return `✅ ${job.description} — finished after ${elapsed} (exit ${job.exitCode})`
  if (job.status === 'timed-out') return `⏱️ ${job.description} — timed out after ${elapsed} and was stopped`
  if (job.status === 'unknown') return `❓ ${job.description} — lost track of it after ${elapsed} (bridge restarted while it was running — exact result unknown)`
  return `❌ ${job.description} — failed after ${elapsed}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}`
}

export function selectStatusRenderJobs(jobsForThread) {
  return jobsForThread.filter(j => isJobActive(j) || !j.reported)
}

export function renderJobsStatusMessage(jobs, now, { staleMs = JOB_HEARTBEAT_STALE_MS } = {}) {
  if (!jobs.length) return null
  const header = jobs.some(isJobActive) ? '🧵 background jobs:' : '✅ background jobs finished:'
  return [header, ...jobs.map(j => renderJobLine(j, now, staleMs))].join('\n')
}

export function groupJobsByThread(jobsMap) {
  // null-prototype so an attacker-chosen notifyThreadKey (e.g. "__proto__", "toString") can never resolve to an inherited value instead of a real bucket.
  const grouped = Object.create(null)
  for (const record of Object.values(jobsMap ?? {})) {
    ;(grouped[record.notifyThreadKey] ??= []).push(record)
  }
  return grouped
}

export function buildJobCompletionCheckinInstruction(job) {
  // A job that never made it past startJob's own spawn attempt (createJobRecord's startedAt stays null) has no log to point at.
  if (job.startedAt == null) {
    const base = `Background job "${job.description}" (id ${job.id}) failed to start and never ran — no log was produced. Report this to the user.`
    return job.onDoneCheckin?.instruction
      ? `${base}\n\nAdditional instruction given when the job was started: ${job.onDoneCheckin.instruction}`
      : base
  }
  const outcome =
    job.status === 'done'
      ? `finished with exit code ${job.exitCode}`
      : job.status === 'timed-out'
        ? `timed out after ${job.timeoutMinutes} minute(s) and was stopped`
        : job.status === 'unknown'
          ? 'was lost track of (the bridge restarted while it was running and it was gone by the time a new instance checked) — the actual outcome is unknown'
          : `failed${job.exitCode != null ? ` with exit code ${job.exitCode}` : ''}`
  const base = `Background job "${job.description}" (id ${job.id}) ${outcome}. Its full output log is at ${job.logPath} — read it and report the result to the user.`
  return job.onDoneCheckin?.instruction
    ? `${base}\n\nAdditional instruction given when the job was started: ${job.onDoneCheckin.instruction}`
    : base
}

export function buildJobCompletionCheckin(job) {
  return { minutes: job.onDoneCheckin?.minutes ?? 0, instruction: buildJobCompletionCheckinInstruction(job) }
}
