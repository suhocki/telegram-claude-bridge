import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHECKIN_MAX_MINUTES } from '../lib.mjs'
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  resolveJobsDir,
  buildJobSpecPath,
  buildJobLogPath,
  isPathInsideDir,
  isJobActive,
  countActiveJobs,
  validateJobSpec,
  createJobRecord,
  markJobRunning,
  markJobFinished,
  reconcileJobsOnBoot,
  computeHeartbeatState,
  formatDuration,
  renderJobLine,
  selectStatusRenderJobs,
  renderJobsStatusMessage,
  groupJobsByThread,
  buildJobCompletionCheckinInstruction,
  buildJobCompletionCheckin,
} from '../jobs.mjs'

const VALID_SPEC = {
  command: 'sleep 30 && date > /tmp/marker.txt',
  description: 'sleep then write a marker',
  notifyThreadKey: '58639685',
}

test('resolveJobsDir/buildJobSpecPath/buildJobLogPath: namespaced by botSlug, one file per job', () => {
  const jobsDir = resolveJobsDir('/repo/state', 'tldr')
  assert.equal(jobsDir, '/repo/state/jobs/tldr')
  assert.equal(buildJobSpecPath(jobsDir, 'abc123'), '/repo/state/jobs/tldr/abc123.json')
  assert.equal(buildJobLogPath(jobsDir, 'abc123'), '/repo/state/jobs/tldr/abc123.log')
})

test('isPathInsideDir: accepts a direct child, rejects a path traversal or sibling directory', () => {
  assert.equal(isPathInsideDir('/repo/state/jobs/tldr/abc.json', '/repo/state/jobs/tldr'), true)
  assert.equal(isPathInsideDir('/repo/state/jobs/tldr/../../etc/passwd', '/repo/state/jobs/tldr'), false)
  assert.equal(isPathInsideDir('/repo/state/jobs/other', '/repo/state/jobs/tldr'), false)
  assert.equal(isPathInsideDir('/repo/state/jobs/tldr', '/repo/state/jobs/tldr'), true)
})

test('isJobActive: pending/running are active, done/failed/timed-out are not', () => {
  assert.equal(isJobActive({ status: 'pending' }), true)
  assert.equal(isJobActive({ status: 'running' }), true)
  assert.equal(isJobActive({ status: 'done' }), false)
  assert.equal(isJobActive({ status: 'failed' }), false)
  assert.equal(isJobActive({ status: 'timed-out' }), false)
  assert.equal(isJobActive(null), false)
})

test('countActiveJobs: counts only pending/running entries', () => {
  const jobs = { a: { status: 'running' }, b: { status: 'done' }, c: { status: 'pending' }, d: { status: 'failed' } }
  assert.equal(countActiveJobs(jobs), 2)
  assert.equal(countActiveJobs({}), 0)
  assert.equal(countActiveJobs(undefined), 0)
})

test('validateJobSpec: accepts the fully documented shape', () => {
  const spec = {
    ...VALID_SPEC,
    cwd: '/repo',
    etaMinutes: 5,
    timeoutMinutes: 30,
    onDoneCheckin: { minutes: 0, instruction: 'read the log and report' },
  }
  assert.deepEqual(validateJobSpec(spec, { jobId: 'abc123' }), { ok: true })
})

test('validateJobSpec: accepts the minimal shape (only command/description/notifyThreadKey)', () => {
  assert.deepEqual(validateJobSpec(VALID_SPEC, { jobId: 'abc123' }), { ok: true })
})

test('validateJobSpec: rejects a missing/blank command', () => {
  for (const command of [undefined, '', '   ', 123]) {
    const result = validateJobSpec({ ...VALID_SPEC, command }, { jobId: 'abc123' })
    assert.equal(result.ok, false)
    assert.match(result.error, /command/)
  }
})

test('validateJobSpec: rejects a missing/blank notifyThreadKey', () => {
  for (const notifyThreadKey of [undefined, '', '   ']) {
    const result = validateJobSpec({ ...VALID_SPEC, notifyThreadKey }, { jobId: 'abc123' })
    assert.equal(result.ok, false)
    assert.match(result.error, /notifyThreadKey/)
  }
})

test('validateJobSpec: rejects a missing/blank description', () => {
  const result = validateJobSpec({ ...VALID_SPEC, description: '' }, { jobId: 'abc123' })
  assert.equal(result.ok, false)
  assert.match(result.error, /description/)
})

test('validateJobSpec: rejects an invalid job id (from an untrusted spec filename)', () => {
  for (const jobId of ['', '../escape', 'has spaces', 'a'.repeat(65)]) {
    const result = validateJobSpec(VALID_SPEC, { jobId })
    assert.equal(result.ok, false)
    assert.match(result.error, /job id/)
  }
})

test('validateJobSpec: rejects "__proto__"/"constructor"/"prototype" as a job id even though they match the id pattern', () => {
  for (const jobId of ['__proto__', 'constructor', 'prototype']) {
    const result = validateJobSpec(VALID_SPEC, { jobId })
    assert.equal(result.ok, false)
    assert.match(result.error, /job id/)
  }
})

test('validateJobSpec: rejects a spec file path outside the jobs dir', () => {
  const result = validateJobSpec(VALID_SPEC, {
    jobId: 'abc123',
    jobsDir: '/repo/state/jobs/tldr',
    filePath: '/repo/state/jobs/tldr/../../etc/abc123.json',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /outside the jobs directory/)
})

test('validateJobSpec: a spec file path inside the jobs dir passes', () => {
  const result = validateJobSpec(VALID_SPEC, {
    jobId: 'abc123',
    jobsDir: '/repo/state/jobs/tldr',
    filePath: '/repo/state/jobs/tldr/abc123.json',
  })
  assert.equal(result.ok, true)
})

test('validateJobSpec: rejects malformed optional fields (cwd/etaMinutes/timeoutMinutes/onDoneCheckin)', () => {
  assert.equal(validateJobSpec({ ...VALID_SPEC, cwd: '' }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, etaMinutes: 0 }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, etaMinutes: 'soon' }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, timeoutMinutes: -5 }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, onDoneCheckin: 'yes' }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, onDoneCheckin: { minutes: -1 } }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, onDoneCheckin: { instruction: 5 } }, { jobId: 'a' }).ok, false)
  assert.equal(validateJobSpec({ ...VALID_SPEC, onDoneCheckin: { minutes: 0, instruction: 'ok' } }, { jobId: 'a' }).ok, true)
})

test('validateJobSpec: onDoneCheckin.minutes is capped at CHECKIN_MAX_MINUTES, same bound as a model\'s own CHECKIN: marker', () => {
  assert.equal(validateJobSpec({ ...VALID_SPEC, onDoneCheckin: { minutes: CHECKIN_MAX_MINUTES } }, { jobId: 'a' }).ok, true)
  const result = validateJobSpec({ ...VALID_SPEC, onDoneCheckin: { minutes: CHECKIN_MAX_MINUTES + 1 } }, { jobId: 'a' })
  assert.equal(result.ok, false)
  assert.match(result.error, /onDoneCheckin\.minutes/)
})

test('validateJobSpec: rejects a notifyThreadKey the caller\'s isThreadKeyAuthorized predicate does not recognize', () => {
  const isThreadKeyAuthorized = key => key === '58639685'
  const rejected = validateJobSpec({ ...VALID_SPEC, notifyThreadKey: '999999' }, { jobId: 'a', isThreadKeyAuthorized })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /notifyThreadKey/)
  const accepted = validateJobSpec({ ...VALID_SPEC, notifyThreadKey: '58639685' }, { jobId: 'a', isThreadKeyAuthorized })
  assert.equal(accepted.ok, true)
})

test('validateJobSpec: without an isThreadKeyAuthorized predicate, any non-empty notifyThreadKey passes (backward compatible)', () => {
  assert.equal(validateJobSpec({ ...VALID_SPEC, notifyThreadKey: 'anything' }, { jobId: 'a' }).ok, true)
})

test('validateJobSpec: rejects when at or over the concurrent-jobs cap, accepts just under it', () => {
  const atCap = validateJobSpec(VALID_SPEC, { jobId: 'abc123', activeCount: 5, maxConcurrentJobs: 5 })
  assert.equal(atCap.ok, false)
  assert.match(atCap.error, /concurrent job cap/)
  const overCap = validateJobSpec(VALID_SPEC, { jobId: 'abc123', activeCount: 9, maxConcurrentJobs: 5 })
  assert.equal(overCap.ok, false)
  const underCap = validateJobSpec(VALID_SPEC, { jobId: 'abc123', activeCount: 4, maxConcurrentJobs: 5 })
  assert.equal(underCap.ok, true)
})

test('validateJobSpec: defaults the concurrent cap to DEFAULT_MAX_CONCURRENT_JOBS when not given', () => {
  const result = validateJobSpec(VALID_SPEC, { jobId: 'abc123', activeCount: DEFAULT_MAX_CONCURRENT_JOBS })
  assert.equal(result.ok, false)
  assert.match(result.error, new RegExp(String(DEFAULT_MAX_CONCURRENT_JOBS)))
})

test('createJobRecord: builds a pending record with the documented defaults', () => {
  const now = 1000
  const record = createJobRecord({ id: 'abc123', spec: VALID_SPEC, now, logPath: '/repo/state/jobs/tldr/abc123.log' })
  assert.equal(record.status, 'pending')
  assert.equal(record.id, 'abc123')
  assert.equal(record.description, VALID_SPEC.description)
  assert.equal(record.command, VALID_SPEC.command)
  assert.equal(record.notifyThreadKey, VALID_SPEC.notifyThreadKey)
  assert.equal(record.timeoutMinutes, DEFAULT_JOB_TIMEOUT_MINUTES)
  assert.equal(record.createdAt, now)
  assert.equal(record.startedAt, null)
  assert.equal(record.pid, null)
  assert.equal(record.reported, false)
})

test('createJobRecord: honors an explicit timeoutMinutes on the spec over the default', () => {
  const record = createJobRecord({ id: 'a', spec: { ...VALID_SPEC, timeoutMinutes: 15 }, now: 0, logPath: '/x.log' })
  assert.equal(record.timeoutMinutes, 15)
})

test('createJobRecord: honors a bot-level default timeout override when the spec omits one', () => {
  const record = createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log', defaultTimeoutMinutes: 120 })
  assert.equal(record.timeoutMinutes, 120)
})

test('state transitions: pending -> running -> done', () => {
  let record = createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' })
  assert.equal(record.status, 'pending')
  record = markJobRunning(record, 4242, 10)
  assert.equal(record.status, 'running')
  assert.equal(record.pid, 4242)
  assert.equal(record.startedAt, 10)
  record = markJobFinished(record, { status: 'done', exitCode: 0, now: 50 })
  assert.equal(record.status, 'done')
  assert.equal(record.exitCode, 0)
  assert.equal(record.finishedAt, 50)
  assert.equal(isJobActive(record), false)
})

test('state transitions: running -> failed keeps a non-zero exit code and signal', () => {
  let record = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  record = markJobFinished(record, { status: 'failed', exitCode: null, signal: 'SIGKILL', now: 5 })
  assert.equal(record.status, 'failed')
  assert.equal(record.signal, 'SIGKILL')
})

test('state transitions: running -> timed-out', () => {
  let record = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  record = markJobFinished(record, { status: 'timed-out', now: 5 })
  assert.equal(record.status, 'timed-out')
})

test('reconcileJobsOnBoot: a running job whose pid is still alive is left running (to be adopted)', () => {
  const jobs = { a: markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 999, 0) }
  const { jobs: next, deadJobIds } = reconcileJobsOnBoot(jobs, () => true, 100)
  assert.equal(next.a.status, 'running')
  assert.deepEqual(deadJobIds, [])
})

test('reconcileJobsOnBoot: a running job whose pid is gone is marked "unknown" (never guessed as done or failed) and reported as dead', () => {
  const jobs = { a: markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 999, 0) }
  const { jobs: next, deadJobIds } = reconcileJobsOnBoot(jobs, () => false, 100)
  assert.equal(next.a.status, 'unknown')
  assert.equal(next.a.finishedAt, 100)
  assert.deepEqual(deadJobIds, ['a'])
})

test('reconcileJobsOnBoot: a job that was mid-timeout-kill before the restart is reported as timed-out, not done', () => {
  let record = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 999, 0)
  record.killedForTimeout = true
  const { jobs: next, deadJobIds } = reconcileJobsOnBoot({ a: record }, () => false, 100)
  assert.equal(next.a.status, 'timed-out')
  assert.deepEqual(deadJobIds, ['a'])
})

test('reconcileJobsOnBoot: already-finished jobs are left untouched and never reported as newly dead', () => {
  let record = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 999, 0)
  record = markJobFinished(record, { status: 'done', exitCode: 0, now: 5 })
  const { jobs: next, deadJobIds } = reconcileJobsOnBoot({ a: record }, () => false, 100)
  assert.equal(next.a.status, 'done')
  assert.equal(next.a.exitCode, 0)
  assert.deepEqual(deadJobIds, [])
})

test('computeHeartbeatState: alive when recent output, stale once past the threshold, null once finished', () => {
  const running = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  running.lastHeartbeatAt = 1000
  assert.equal(computeHeartbeatState(running, 1000 + 60_000, 5 * 60_000), 'alive')
  assert.equal(computeHeartbeatState(running, 1000 + 6 * 60_000, 5 * 60_000), 'stale')
  const done = markJobFinished(running, { status: 'done', exitCode: 0, now: 2000 })
  assert.equal(computeHeartbeatState(done, 100_000, 5 * 60_000), null)
})

test('formatDuration: renders seconds/minutes/hours in the expected style', () => {
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(65_000), '1m 5s')
  assert.equal(formatDuration(3 * 3600_000 + 90_000), '3h 1m')
  assert.equal(formatDuration(-500), '0s')
})

test('renderJobLine: an alive running job shows elapsed time, eta, and a fresh heartbeat', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: { ...VALID_SPEC, etaMinutes: 5 }, now: 0, logPath: '/x.log' }), 1, 0)
  job.lastHeartbeatAt = 10_000
  const line = renderJobLine(job, 12_000, 5 * 60_000)
  assert.match(line, /sleep then write a marker/)
  assert.match(line, /elapsed/)
  assert.match(line, /eta 5m/)
  assert.match(line, /alive/)
  assert.doesNotMatch(line, /no output/)
})

test('renderJobLine: a stale running job (no recent output) is flagged distinctly from alive', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job.lastHeartbeatAt = 0
  const line = renderJobLine(job, 10 * 60_000, 5 * 60_000)
  assert.match(line, /no output for/)
})

test('renderJobLine: a done job reports its exit code', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'done', exitCode: 0, now: 30_000 })
  const line = renderJobLine(job, 30_000)
  assert.match(line, /✅/)
  assert.match(line, /exit 0/)
})

test('renderJobLine: an "unknown" job (bridge-restart survivor with no verifiable exit code) says so instead of guessing done or failed', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'unknown', now: 30_000 })
  const line = renderJobLine(job, 30_000)
  assert.match(line, /❓/)
  assert.match(line, /exact result unknown/)
})

test('renderJobLine: a failed job is visually distinct from done/timed-out ("dead" case)', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'failed', signal: 'SIGKILL', now: 30_000 })
  const line = renderJobLine(job, 30_000)
  assert.match(line, /❌/)
  assert.match(line, /failed/)
})

test('renderJobLine: a timed-out job says so', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'timed-out', now: 30_000 })
  const line = renderJobLine(job, 30_000)
  assert.match(line, /⏱️/)
  assert.match(line, /timed out/)
})

test('selectStatusRenderJobs: keeps active jobs and finished-but-not-yet-reported ones, drops already-reported ones', () => {
  const active = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  const freshlyDone = { ...markJobFinished({ ...active, id: 'b' }, { status: 'done', exitCode: 0, now: 5 }), reported: false }
  const alreadyReported = { ...markJobFinished({ ...active, id: 'c' }, { status: 'done', exitCode: 0, now: 5 }), reported: true }
  const result = selectStatusRenderJobs([active, freshlyDone, alreadyReported])
  assert.deepEqual(
    result.map(j => j.id),
    ['a', 'b']
  )
})

test('renderJobsStatusMessage: null when there is nothing to show', () => {
  assert.equal(renderJobsStatusMessage([], 0), null)
})

test('renderJobsStatusMessage: an active-jobs header while anything is still running/pending', () => {
  const running = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  const text = renderJobsStatusMessage([running], 1000)
  assert.match(text, /^🧵 background jobs:/)
})

test('renderJobsStatusMessage: a final-summary header once nothing is active anymore', () => {
  let job = markJobRunning(createJobRecord({ id: 'a', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'done', exitCode: 0, now: 1000 })
  const text = renderJobsStatusMessage([job], 1000)
  assert.match(text, /^✅ background jobs finished:/)
})

test('groupJobsByThread: groups job records by their notifyThreadKey', () => {
  const jobs = {
    a: { id: 'a', notifyThreadKey: '111' },
    b: { id: 'b', notifyThreadKey: '222' },
    c: { id: 'c', notifyThreadKey: '111' },
  }
  const grouped = groupJobsByThread(jobs)
  assert.deepEqual(
    grouped['111'].map(j => j.id),
    ['a', 'c']
  )
  assert.deepEqual(
    grouped['222'].map(j => j.id),
    ['b']
  )
})

test('groupJobsByThread: an empty/missing map groups to nothing', () => {
  assert.deepEqual(Object.keys(groupJobsByThread({})), [])
  assert.deepEqual(Object.keys(groupJobsByThread(undefined)), [])
})

test('groupJobsByThread: is immune to a notifyThreadKey that collides with an inherited Object property name', () => {
  const jobs = { a: { id: 'a', notifyThreadKey: '__proto__' }, b: { id: 'b', notifyThreadKey: 'constructor' } }
  const grouped = groupJobsByThread(jobs)
  assert.deepEqual(
    grouped['__proto__'].map(j => j.id),
    ['a']
  )
  assert.deepEqual(
    grouped['constructor'].map(j => j.id),
    ['b']
  )
})

test('buildJobCompletionCheckinInstruction: a successful job reports its exit code and log path', () => {
  let job = markJobRunning(createJobRecord({ id: 'j1', spec: VALID_SPEC, now: 0, logPath: '/x/j1.log' }), 1, 0)
  job = markJobFinished(job, { status: 'done', exitCode: 0, now: 30_000 })
  const instruction = buildJobCompletionCheckinInstruction(job)
  assert.match(instruction, /finished with exit code 0/)
  assert.match(instruction, /\/x\/j1\.log/)
  assert.match(instruction, /report the result to the user/)
})

test('buildJobCompletionCheckinInstruction: a failed job says so, a timed-out job says so distinctly', () => {
  let failed = markJobRunning(createJobRecord({ id: 'j1', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  failed = markJobFinished(failed, { status: 'failed', exitCode: 1, now: 1000 })
  assert.match(buildJobCompletionCheckinInstruction(failed), /failed with exit code 1/)

  let timedOut = markJobRunning(createJobRecord({ id: 'j2', spec: { ...VALID_SPEC, timeoutMinutes: 10 }, now: 0, logPath: '/x.log' }), 1, 0)
  timedOut = markJobFinished(timedOut, { status: 'timed-out', now: 1000 })
  assert.match(buildJobCompletionCheckinInstruction(timedOut), /timed out after 10 minute/)
})

test('buildJobCompletionCheckinInstruction: an "unknown" job (bridge-restart survivor) says its outcome is unknown, not that it succeeded or failed', () => {
  let job = markJobRunning(createJobRecord({ id: 'j1', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'unknown', now: 1000 })
  const instruction = buildJobCompletionCheckinInstruction(job)
  assert.match(instruction, /was lost track of/)
  assert.match(instruction, /outcome is unknown/)
})

test('buildJobCompletionCheckinInstruction: appends the spec\'s own onDoneCheckin.instruction when given', () => {
  let job = markJobRunning(
    createJobRecord({ id: 'j1', spec: { ...VALID_SPEC, onDoneCheckin: { instruction: 'convert the output to a PDF' } }, now: 0, logPath: '/x.log' }),
    1,
    0
  )
  job = markJobFinished(job, { status: 'done', exitCode: 0, now: 1000 })
  const instruction = buildJobCompletionCheckinInstruction(job)
  assert.match(instruction, /convert the output to a PDF/)
})

test('buildJobCompletionCheckin: defaults to an immediate (0-minute) check-in, honors an explicit delay', () => {
  let job = markJobRunning(createJobRecord({ id: 'j1', spec: VALID_SPEC, now: 0, logPath: '/x.log' }), 1, 0)
  job = markJobFinished(job, { status: 'done', exitCode: 0, now: 1000 })
  assert.equal(buildJobCompletionCheckin(job).minutes, 0)

  let delayed = markJobRunning(
    createJobRecord({ id: 'j2', spec: { ...VALID_SPEC, onDoneCheckin: { minutes: 3 } }, now: 0, logPath: '/x.log' }),
    1,
    0
  )
  delayed = markJobFinished(delayed, { status: 'done', exitCode: 0, now: 1000 })
  assert.equal(buildJobCompletionCheckin(delayed).minutes, 3)
})
