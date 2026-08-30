// Pure, testable helpers for the bridge-owned background job runner (see docs/background-jobs-plan.md).

import path from 'node:path'
import { CHECKIN_MAX_MINUTES } from './lib.mjs'

export const DEFAULT_MAX_CONCURRENT_JOBS = 5
export const DEFAULT_JOB_TIMEOUT_MINUTES = 60
export const JOB_HEARTBEAT_STALE_MS = 5 * 60 * 1000
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
  }
}

export function markJobRunning(record, pid, now) {
  return { ...record, status: 'running', pid, startedAt: now, lastHeartbeatAt: now }
}

export function markJobFinished(record, { status, exitCode = null, signal = null, now }) {
  return { ...record, status, exitCode, signal, finishedAt: now }
}

// A dead pid on boot could mean the job actually finished, or the machine itself restarted mid-job; either way the real exit code is unrecoverable, so it's marked "done" (or "timed-out" if already flagged) rather than guessed as a failure.
export function reconcileJobsOnBoot(jobsMap, isAlivePid, now) {
  const jobs = { ...jobsMap }
  const deadJobIds = []
  for (const [jobId, record] of Object.entries(jobs)) {
    if (!isJobActive(record)) continue
    if (record.pid != null && isAlivePid(record.pid)) continue
    jobs[jobId] = markJobFinished(record, { status: record.killedForTimeout ? 'timed-out' : 'done', now })
    deadJobIds.push(jobId)
  }
  return { jobs, deadJobIds }
}

export function computeHeartbeatState(record, now, staleMs = JOB_HEARTBEAT_STALE_MS) {
  if (!isJobActive(record)) return null
  const age = now - (record.lastHeartbeatAt ?? record.startedAt ?? now)
  return age > staleMs ? 'stale' : 'alive'
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
    const heartbeatText =
      computeHeartbeatState(job, now, staleMs) === 'stale' ? `⚠️ no output for ${since}` : `alive, last output ${since} ago`
    return `⏳ ${job.description} — ${elapsed} elapsed${eta} — ${heartbeatText}`
  }
  if (job.status === 'done') {
    const exitText = job.exitCode != null ? ` (exit ${job.exitCode})` : ' (bridge restarted while it was running — exact result unknown)'
    return `✅ ${job.description} — finished after ${elapsed}${exitText}`
  }
  if (job.status === 'timed-out') return `⏱️ ${job.description} — timed out after ${elapsed} and was stopped`
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
  const outcome =
    job.status === 'done'
      ? job.exitCode != null
        ? `finished with exit code ${job.exitCode}`
        : 'finished (the bridge restarted while it was running, so the exact exit code is unknown)'
      : job.status === 'timed-out'
        ? `timed out after ${job.timeoutMinutes} minute(s) and was stopped`
        : `failed${job.exitCode != null ? ` with exit code ${job.exitCode}` : ''}`
  const base = `Background job "${job.description}" (id ${job.id}) ${outcome}. Its full output log is at ${job.logPath} — read it and report the result to the user.`
  return job.onDoneCheckin?.instruction
    ? `${base}\n\nAdditional instruction given when the job was started: ${job.onDoneCheckin.instruction}`
    : base
}

export function buildJobCompletionCheckin(job) {
  return { minutes: job.onDoneCheckin?.minutes ?? 0, instruction: buildJobCompletionCheckinInstruction(job) }
}
