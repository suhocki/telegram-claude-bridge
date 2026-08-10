import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { GLOSS_MODEL, buildGlossPrompt, runClaudeGloss, createToolGlosser } from '../gloss.mjs'

function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.pid = pid
  child.killed = null
  child.kill = signal => {
    child.killed = signal
  }
  return child
}

test('buildGlossPrompt names the tool and its summarized input in the action line', () => {
  const prompt = buildGlossPrompt('Bash', { command: 'grep -rn QaAccountsApi' })
  assert.match(prompt, /Действие: Bash: grep -rn QaAccountsApi$/m)
})

test('buildGlossPrompt falls back to just the tool name when there is nothing to summarize', () => {
  const prompt = buildGlossPrompt('Task', {})
  assert.match(prompt, /Действие: Task$/m)
})

test('buildGlossPrompt falls back to a generic label when there is no tool name either', () => {
  const prompt = buildGlossPrompt(null, {})
  assert.match(prompt, /Действие: a tool call$/m)
})

test('buildGlossPrompt truncates a huge command instead of embedding it verbatim', () => {
  const prompt = buildGlossPrompt('Bash', { command: `echo ${'x'.repeat(5000)}` })
  const actionLine = prompt.split('\n').at(-1)
  assert.ok(actionLine.length < 250, `expected the action line to be capped, got ${actionLine.length} chars`)
  assert.ok(actionLine.endsWith('…'))
})

test('runClaudeGloss resolves to the trimmed stdout on a clean exit', async () => {
  const child = fakeChild()
  const spawnFn = () => child
  const promise = runClaudeGloss('prompt', { spawnFn })
  child.stdout.emit('data', '  Ищу использование QaAccountsApi\n')
  child.emit('close', 0)
  assert.equal(await promise, 'Ищу использование QaAccountsApi')
})

test('runClaudeGloss passes the requested model through to the spawned command', async () => {
  let seenArgs
  const child = fakeChild()
  const spawnFn = (cmd, args) => {
    seenArgs = args
    return child
  }
  const promise = runClaudeGloss('prompt', { spawnFn, model: 'claude-haiku-4-5-20251001' })
  child.emit('close', 0)
  await promise
  assert.deepEqual(seenArgs, ['-p', 'prompt', '--model', 'claude-haiku-4-5-20251001'])
})

test('runClaudeGloss spawns the child detached', async () => {
  let seenOpts
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: (cmd, args, opts) => { seenOpts = opts; return child } })
  child.emit('close', 0)
  await promise
  assert.deepEqual(seenOpts, { detached: true })
})

test('runClaudeGloss kills the whole process group (not just the child) on timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild(4242)
  const originalKill = process.kill
  const killed = []
  process.kill = (pid, signal) => killed.push([pid, signal])
  try {
    const promise = runClaudeGloss('prompt', { spawnFn: () => child, timeoutMs: 1000 })
    t.mock.timers.tick(1000)
    assert.equal(await promise, null)
    assert.deepEqual(killed, [[-4242, 'SIGKILL']])
    assert.equal(child.killed, null, 'the group kill should have succeeded, so the single-child fallback must not also fire')
  } finally {
    process.kill = originalKill
  }
})

test('runClaudeGloss falls back to killing just the child if the process group is already gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild(4242)
  const originalKill = process.kill
  process.kill = () => {
    throw new Error('ESRCH')
  }
  try {
    const promise = runClaudeGloss('prompt', { spawnFn: () => child, timeoutMs: 1000 })
    t.mock.timers.tick(1000)
    assert.equal(await promise, null)
    assert.equal(child.killed, 'SIGKILL')
  } finally {
    process.kill = originalKill
  }
})

test('runClaudeGloss resolves to null on a non-zero exit', async () => {
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: () => child })
  child.stdout.emit('data', 'partial nonsense')
  child.emit('close', 1)
  assert.equal(await promise, null)
})

test('runClaudeGloss resolves to null on empty stdout even with a clean exit', async () => {
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: () => child })
  child.emit('close', 0)
  assert.equal(await promise, null)
})

test('runClaudeGloss resolves to null if the child process errors instead of closing', async () => {
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: () => child })
  child.emit('error', new Error('ENOENT'))
  assert.equal(await promise, null)
})

test('runClaudeGloss resolves to null and kills the child if it runs past the timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: () => child, timeoutMs: 1000 })
  t.mock.timers.tick(1000)
  assert.equal(await promise, null)
  assert.equal(child.killed, 'SIGKILL')
})

test('runClaudeGloss resolves to null if spawning the command throws synchronously', async () => {
  const spawnFn = () => {
    throw new Error('spawn EMFILE')
  }
  assert.equal(await runClaudeGloss('prompt', { spawnFn }), null)
})

test('runClaudeGloss ignores a late close after the timeout already settled it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: () => child, timeoutMs: 1000 })
  t.mock.timers.tick(1000)
  const result = await promise
  child.stdout.emit('data', 'too late')
  child.emit('close', 0) // must not throw or change an already-settled promise
  assert.equal(result, null)
})

test('GLOSS_MODEL is exported as the default model runClaudeGloss uses', async () => {
  let seenArgs
  const child = fakeChild()
  const promise = runClaudeGloss('prompt', { spawnFn: (cmd, args) => { seenArgs = args; return child } })
  child.emit('close', 0)
  await promise
  assert.ok(seenArgs.includes(GLOSS_MODEL))
})

test('createToolGlosser.gloss runs requests one at a time, in order', async () => {
  const started = []
  const finished = []
  let releaseFirst
  const run = prompt => {
    started.push(prompt)
    if (started.length === 1) return new Promise(r => (releaseFirst = () => r('first result')))
    return Promise.resolve('second result')
  }
  const glosser = createToolGlosser({ run })

  const firstPromise = glosser.gloss('Bash', { command: 'a' })
  const secondPromise = glosser.gloss('Bash', { command: 'b' })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(started.length, 1, 'the second request must not start until the first settles')

  releaseFirst()
  finished.push(await firstPromise)
  finished.push(await secondPromise)
  assert.deepEqual(finished, ['first result', 'second result'])
  assert.equal(started.length, 2)
})

test('createToolGlosser.gloss: one request failing does not block or fail the next one', async () => {
  let call = 0
  const run = () => {
    call += 1
    return call === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
  }
  const glosser = createToolGlosser({ run })
  const first = await glosser.gloss('Bash', { command: 'a' })
  const second = await glosser.gloss('Bash', { command: 'b' })
  assert.equal(first, null)
  assert.equal(second, 'ok')
})

test('createToolGlosser.gloss skips new requests once the backlog hits maxQueueLength, without running claude -p for them', async () => {
  const started = []
  const resolvers = []
  const run = prompt => {
    started.push(prompt)
    return new Promise(r => resolvers.push(r))
  }
  const glosser = createToolGlosser({ run, maxQueueLength: 2 })

  const p1 = glosser.gloss('Bash', { command: 'a' })
  const p2 = glosser.gloss('Bash', { command: 'b' })
  const p3 = glosser.gloss('Bash', { command: 'c' }) // over the cap — must not even call run()

  assert.equal(await p3, null, 'the third request should be skipped immediately, not queued')
  assert.equal(started.length, 1, 'only the first request should have actually started (the second is still queued behind it)')

  resolvers[0]('done')
  await new Promise(r => setTimeout(r, 0)) // let the freed slot let run(prompt2) actually start
  assert.equal(started.length, 2)

  resolvers[1]('done')
  assert.equal(await p1, 'done')
  assert.equal(await p2, 'done')
})

test('createToolGlosser.gloss makes room again once an earlier request settles', async () => {
  const started = []
  const run = prompt => {
    started.push(prompt)
    return Promise.resolve('done')
  }
  const glosser = createToolGlosser({ run, maxQueueLength: 1 })

  await glosser.gloss('Bash', { command: 'a' })
  await glosser.gloss('Bash', { command: 'b' })
  assert.equal(started.length, 2, 'the second request should run once the first has fully settled and freed its slot')
})

test('createToolGlosser.gloss builds a fresh prompt per call from the tool name and input', async () => {
  const prompts = []
  const run = prompt => {
    prompts.push(prompt)
    return Promise.resolve('gloss')
  }
  const glosser = createToolGlosser({ run })
  await glosser.gloss('Edit', { file_path: '/a/foo.py' })
  assert.match(prompts[0], /Действие: Edit: foo.py$/m)
})
