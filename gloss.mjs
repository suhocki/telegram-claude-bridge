import { spawn } from 'node:child_process'
import { summarizeToolInput } from './stream-progress.mjs'

export const GLOSS_MODEL = 'claude-haiku-4-5-20251001'
// Measured live: `claude -p --model claude-haiku-4-5-20251001` on a short prompt takes
// ~9-12s wall clock, almost all CLI/session startup rather than generation — there's no
// faster way to reach a model under the "no API credits, CLI only" constraint.
export const GLOSS_TIMEOUT_MS = 20000

export function buildGlossPrompt(name, input) {
  const summary = summarizeToolInput(name, input)
  const action = summary ? `${name || 'tool'}: ${summary}` : name || 'a tool call'
  return [
    'Опиши это техническое действие для нетехнического читателя, ровно 5-7 слов, по-русски,',
    'одной строкой, без кавычек, без точки в конце, без инструментов и без вопросов в ответ —',
    'только сама фраза-описание.',
    `Действие: ${action}`,
  ].join('\n')
}

// Runs a one-shot `claude -p` completion and resolves to its trimmed stdout, or null on
// any failure (non-zero exit, timeout, spawn error) — glossing is a nice-to-have, never
// something the caller should have to handle as an error.
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
      child = spawnFn('claude', ['-p', prompt, '--model', model])
    } catch {
      finish(null)
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      finish(null)
      child.kill('SIGKILL')
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

// Serializes gloss requests one at a time — a turn with twenty tool calls shouldn't spawn
// twenty parallel `claude -p` processes fighting over the same rate limits. Each request
// still resolves independently and never rejects, so a failure never breaks the queue for
// requests behind it.
export function createToolGlosser({ run = runClaudeGloss } = {}) {
  let queue = Promise.resolve()

  function gloss(name, input) {
    const prompt = buildGlossPrompt(name, input)
    const result = queue.then(() => run(prompt).catch(() => null))
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return { gloss }
}
