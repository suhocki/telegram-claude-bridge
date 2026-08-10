import { spawn } from 'node:child_process'
import { summarizeToolInput, truncateStatus } from './stream-progress.mjs'

export const GLOSS_MODEL = 'claude-haiku-4-5-20251001'
// Measured live at ~9-12s wall clock, almost all CLI startup — no faster path exists under the CLI-only, no-API-credits constraint.
export const GLOSS_TIMEOUT_MS = 20000
const GLOSS_PROMPT_SUMMARY_MAX_CHARS = 200
// Matches MAX_EPHEMERAL_LINES: no point queuing more requests than could still be on screen by the time they'd run.
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

// Resolves to trimmed stdout on a clean exit, or null on any failure — glossing is a nice-to-have, never something the caller must handle as an error.
export function runClaudeGloss(prompt, { spawnFn = spawn, timeoutMs = GLOSS_TIMEOUT_MS, model = GLOSS_MODEL } = {}) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      // detached so a timeout kills the whole process group, not just the top-level claude
      child = spawnFn('claude', ['-p', prompt, '--model', model], { detached: true })
    } catch {
      finish(null)
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      finish(null)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL') // group already gone (e.g. child exited just before the kill) — fall back to the single process
      }
    }, timeoutMs)

    child.stdout?.on('data', d => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', code => {
      clearTimeout(timer)
      finish(code === 0 ? out.trim() || null : null)
    })
  })
}

// Serializes requests (one `claude -p` at a time) and caps the backlog at maxQueueLength — beyond that, a queued request would only run once its line has likely already scrolled off, so it's skipped instead of wasted.
export function createToolGlosser({ run = runClaudeGloss, maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH } = {}) {
  let queue = Promise.resolve()
  let queueLength = 0

  function gloss(name, input) {
    if (queueLength >= maxQueueLength) return Promise.resolve(null)
    queueLength += 1
    const prompt = buildGlossPrompt(name, input)
    const result = queue.then(() => run(prompt).catch(() => null))
    queue = result.then(
      () => undefined,
      () => undefined
    )
    result.finally(() => {
      queueLength -= 1
    })
    return result
  }

  return { gloss }
}
