import { spawn } from 'node:child_process'
import { summarizeToolInput, truncateStatus } from './stream-progress.mjs'

export const GLOSS_MODEL = 'claude-haiku-4-5-20251001'
// Measured live at ~9-12s wall clock, almost all CLI startup — no faster path exists under the CLI-only, no-API-credits constraint.
export const GLOSS_TIMEOUT_MS = 20000
// Mirrors bridge.mjs's own runClaude cancel(): SIGTERM first, SIGKILL only if it's still alive after this grace period.
export const GLOSS_KILL_GRACE_MS = 2000
const GLOSS_PROMPT_SUMMARY_MAX_CHARS = 200
// Per key (e.g. per chat, shared by its root and every subagent tracker): bounds how many `claude -p` processes one chat can have in flight at once.
const DEFAULT_MAX_QUEUE_LENGTH = 6

export function buildGlossPrompt(name, input) {
  const summary = summarizeToolInput(name, input)
  const truncated = summary ? truncateStatus(summary, GLOSS_PROMPT_SUMMARY_MAX_CHARS) : null
  const action = truncated ? `${name || 'tool'}: ${truncated}` : name || 'a tool call'
  return [
    'Опиши это техническое действие для нетехнического читателя, ровно 5-7 слов, по-русски,',
    'одной строкой, без кавычек, без точки в конце, без инструментов и без вопросов в ответ —',
    'только сама фраза-описание.',
    `Действие: ${action}`,
  ].join('\n')
}

// Guards against killing an already-exited child, same check bridge.mjs's own cancel() makes before either signal.
function killIfAlive(child, signal) {
  if (child.exitCode != null || child.signalCode != null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

// Resolves to trimmed stdout on a clean exit, or null on any failure — glossing is a nice-to-have, never something the caller must handle as an error.
export function runClaudeGloss(prompt, { spawnFn = spawn, timeoutMs = GLOSS_TIMEOUT_MS, model = GLOSS_MODEL, cwd } = {}) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      // bypassPermissions same as bridge.mjs's own runClaude — headless, no TTY to ever approve a tool-use prompt
      child = spawnFn(
        'claude',
        ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions'],
        { detached: true, cwd }
      )
    } catch {
      finish(null)
      return
    }

    const chunks = []
    const timer = setTimeout(() => {
      finish(null)
      killIfAlive(child, 'SIGTERM')
      setTimeout(() => killIfAlive(child, 'SIGKILL'), GLOSS_KILL_GRACE_MS)
    }, timeoutMs)

    // Decoded once at the end, not per chunk — a multi-byte character split across chunks would otherwise come out corrupted.
    child.stdout?.on('data', d => chunks.push(d))
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        finish(null)
        return
      }
      const out = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'))))
        .toString('utf8')
        .trim()
      finish(out || null)
    })
  })
}

function defaultEnqueue() {
  let tail = Promise.resolve()
  return (key, task) => {
    const result = tail.then(task)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

// enqueue defaults to one global un-keyed tail; inject a real per-key queue (e.g. lib.mjs's createKeyedQueue) so one chat's glossing can't starve another's.
export function createToolGlosser({ run = runClaudeGloss, enqueue = defaultEnqueue(), maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH, cwd } = {}) {
  const queueLengthByKey = new Map()

  function gloss(key, name, input) {
    const current = queueLengthByKey.get(key) ?? 0
    if (current >= maxQueueLength) return Promise.resolve(null)
    queueLengthByKey.set(key, current + 1)
    const prompt = buildGlossPrompt(name, input)
    const result = enqueue(key, () => run(prompt, { cwd }).catch(() => null))
    result.finally(() => {
      const remaining = queueLengthByKey.get(key) - 1
      if (remaining > 0) queueLengthByKey.set(key, remaining)
      else queueLengthByKey.delete(key) // don't hold a zero-valued entry forever in a long-running process
    })
    return result
  }

  return { gloss }
}
