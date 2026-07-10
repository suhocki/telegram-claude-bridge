import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunk,
  sanitizeAttr,
  buildSendMessageCalls,
  createKeyedQueue,
  classifyCommand,
  buildChannelPrompt,
  normalizeSession,
  accumulateSessionCost,
  crossedCostThreshold,
  buildCostWarning,
  formatStatusText,
} from '../lib.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('chunk: text under the limit is returned as a single part', () => {
  assert.deepEqual(chunk('hello', 10), ['hello'])
})

test('chunk: text exactly at the limit is not split', () => {
  const text = 'a'.repeat(10)
  assert.deepEqual(chunk(text, 10), [text])
})

test('chunk: splits on the last newline before the limit when one exists past half the limit', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6)
  const parts = chunk(text, 10)
  assert.deepEqual(parts, ['a'.repeat(6), 'b'.repeat(6)])
})

test('chunk: hard-cuts at the limit when no usable newline exists', () => {
  const text = 'a'.repeat(25)
  const parts = chunk(text, 10)
  assert.deepEqual(parts, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
})

test('chunk: default limit is 4096', () => {
  const text = 'a'.repeat(5000)
  const parts = chunk(text)
  assert.equal(parts[0].length, 4096)
  assert.equal(parts[1].length, 904)
})

test('sanitizeAttr: strips characters that could break out of an XML attribute', () => {
  assert.equal(sanitizeAttr('a<b>c[d]e\r\nf"g'), 'a_b_c_d_e__f_g')
})

test('sanitizeAttr: passes through a plain username untouched', () => {
  assert.equal(sanitizeAttr('suhocki'), 'suhocki')
})

test('sanitizeAttr: null/undefined become an empty string, not "null"/"undefined"', () => {
  assert.equal(sanitizeAttr(undefined), '')
  assert.equal(sanitizeAttr(null), '')
})

test('buildSendMessageCalls: single chunk gets reply_parameters when a message id is given', () => {
  const calls = buildSendMessageCalls('123', 'hello', 42)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'hello', reply_parameters: { message_id: 42, allow_sending_without_reply: true } },
  ])
})

test('buildSendMessageCalls: no reply_parameters when message id is omitted', () => {
  const calls = buildSendMessageCalls('123', 'hello')
  assert.deepEqual(calls, [{ chat_id: '123', text: 'hello' }])
})

test('buildSendMessageCalls: no reply_parameters when message id is null', () => {
  const calls = buildSendMessageCalls('123', 'hello', null)
  assert.deepEqual(calls, [{ chat_id: '123', text: 'hello' }])
})

test('buildSendMessageCalls: only the first chunk threads under the triggering message', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6)
  const calls = buildSendMessageCalls('123', text, 99, 10)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'a'.repeat(6), reply_parameters: { message_id: 99, allow_sending_without_reply: true } },
    { chat_id: '123', text: 'b'.repeat(6) },
  ])
})

test('buildSendMessageCalls: with three or more chunks, only the first threads and the rest do not', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6) + '\n' + 'c'.repeat(6)
  const calls = buildSendMessageCalls('123', text, 99, 10)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'a'.repeat(6), reply_parameters: { message_id: 99, allow_sending_without_reply: true } },
    { chat_id: '123', text: 'b'.repeat(6) },
    { chat_id: '123', text: 'c'.repeat(6) },
  ])
})

test('buildSendMessageCalls: message id 0 is a valid id and still threads', () => {
  const calls = buildSendMessageCalls('123', 'hi', 0)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'hi', reply_parameters: { message_id: 0, allow_sending_without_reply: true } },
  ])
})

test('classifyCommand: "/new" and "/reset" both classify as reset', () => {
  assert.equal(classifyCommand('/new'), 'reset')
  assert.equal(classifyCommand('/reset'), 'reset')
})

test('classifyCommand: "/compact" classifies as compact', () => {
  assert.equal(classifyCommand('/compact'), 'compact')
})

test('classifyCommand: "/status" classifies as status', () => {
  assert.equal(classifyCommand('/status'), 'status')
})

test('classifyCommand: ordinary text is not a command', () => {
  assert.equal(classifyCommand('hello'), null)
  assert.equal(classifyCommand('/newfoo'), null)
  assert.equal(classifyCommand('/compact now'), null)
})

test('classifyCommand: surrounding whitespace is ignored', () => {
  assert.equal(classifyCommand('  /new  '), 'reset')
  assert.equal(classifyCommand('\n/compact\n'), 'compact')
})

test('classifyCommand: null/undefined/empty text is not a command', () => {
  assert.equal(classifyCommand(undefined), null)
  assert.equal(classifyCommand(null), null)
  assert.equal(classifyCommand(''), null)
})

test('normalizeSession: null/undefined stays null', () => {
  assert.equal(normalizeSession(null), null)
  assert.equal(normalizeSession(undefined), null)
})

test('normalizeSession: a bare string (old state format) becomes {id, costUsd: 0}', () => {
  assert.deepEqual(normalizeSession('sess-abc'), { id: 'sess-abc', costUsd: 0 })
})

test('normalizeSession: an object is passed through, defaulting a missing costUsd to 0', () => {
  assert.deepEqual(normalizeSession({ id: 'sess-abc' }), { id: 'sess-abc', costUsd: 0 })
  assert.deepEqual(normalizeSession({ id: 'sess-abc', costUsd: 1.5 }), { id: 'sess-abc', costUsd: 1.5 })
})

test('accumulateSessionCost: starts a fresh session at the given delta when there is no prior session', () => {
  assert.deepEqual(accumulateSessionCost(null, 'sess-1', 0.02), { id: 'sess-1', costUsd: 0.02 })
})

test('accumulateSessionCost: adds the delta on top of the previous cumulative cost', () => {
  const prev = { id: 'sess-1', costUsd: 0.1 }
  assert.deepEqual(accumulateSessionCost(prev, 'sess-1', 0.05), { id: 'sess-1', costUsd: 0.15 })
})

test('accumulateSessionCost: a missing/NaN delta is treated as 0', () => {
  const prev = { id: 'sess-1', costUsd: 0.1 }
  assert.deepEqual(accumulateSessionCost(prev, 'sess-1', undefined), { id: 'sess-1', costUsd: 0.1 })
  assert.deepEqual(accumulateSessionCost(prev, 'sess-1', NaN), { id: 'sess-1', costUsd: 0.1 })
})

test('accumulateSessionCost: rounds away floating point drift', () => {
  const prev = { id: 'sess-1', costUsd: 0.1 }
  const result = accumulateSessionCost(prev, 'sess-1', 0.2)
  assert.equal(result.costUsd, 0.3)
})

test('accumulateSessionCost: adopts the new session id even if it changed', () => {
  const prev = { id: 'sess-old', costUsd: 0.1 }
  assert.deepEqual(accumulateSessionCost(prev, 'sess-new', 0.05), { id: 'sess-new', costUsd: 0.15 })
})

test('crossedCostThreshold: false when no threshold is configured', () => {
  assert.equal(crossedCostThreshold(0, 100, undefined), false)
  assert.equal(crossedCostThreshold(0, 100, 0), false)
})

test('crossedCostThreshold: true only the turn the cumulative cost first reaches the threshold', () => {
  assert.equal(crossedCostThreshold(4, 5, 5), true)
  assert.equal(crossedCostThreshold(4.9, 6, 5), true)
})

test('crossedCostThreshold: false once already over threshold (fires once, not every turn)', () => {
  assert.equal(crossedCostThreshold(5, 6, 5), false)
  assert.equal(crossedCostThreshold(10, 11, 5), false)
})

test('crossedCostThreshold: false while still under the threshold', () => {
  assert.equal(crossedCostThreshold(1, 2, 5), false)
})

test('buildCostWarning: formats cost and threshold with a suggestion to /new', () => {
  assert.equal(
    buildCostWarning(5.1234, 5),
    '⚠️ this session has cost $5.1234, over your $5 warning threshold — consider /new to start fresh.',
  )
})

test('formatStatusText: no session yet', () => {
  assert.equal(formatStatusText(null), 'ℹ️ no active session yet — send a message to start one.')
})

test('formatStatusText: reports session id and accumulated cost', () => {
  assert.equal(formatStatusText({ id: 'sess-1', costUsd: 0.1234 }), 'session: sess-1\ncost so far: $0.1234')
})

test('formatStatusText: defaults a missing costUsd to $0.0000', () => {
  assert.equal(formatStatusText({ id: 'sess-1' }), 'session: sess-1\ncost so far: $0.0000')
})

test('buildChannelPrompt: wraps text in a <channel> tag with the given metadata', () => {
  const prompt = buildChannelPrompt('123', 42, 'suhocki', '2026-07-10T00:00:00.000Z', 'hi there')
  assert.equal(
    prompt,
    '<channel source="telegram" chat_id="123" message_id="42" user="suhocki" ts="2026-07-10T00:00:00.000Z">\n' +
      'hi there\n' +
      '</channel>',
  )
})

test('createKeyedQueue: same key runs tasks strictly in order, one at a time', async () => {
  const queue = createKeyedQueue()
  const order = []
  const first = deferred()

  const p1 = queue.enqueue('chat1', async () => {
    order.push('start1')
    await first.promise
    order.push('end1')
  })
  const p2 = queue.enqueue('chat1', async () => {
    order.push('start2')
  })

  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(order, ['start1'])

  first.resolve()
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['start1', 'end1', 'start2'])
})

test('createKeyedQueue: different keys run concurrently, not serialized', async () => {
  const queue = createKeyedQueue()
  const order = []
  const blockA = deferred()

  const pA = queue.enqueue('chatA', async () => {
    order.push('startA')
    await blockA.promise
    order.push('endA')
  })
  const pB = queue.enqueue('chatB', async () => {
    order.push('startB')
    order.push('endB')
  })

  await pB
  assert.deepEqual(order, ['startA', 'startB', 'endB'])

  blockA.resolve()
  await pA
  assert.deepEqual(order, ['startA', 'startB', 'endB', 'endA'])
})

test('createKeyedQueue: a rejected task does not block later tasks for the same key', async () => {
  const queue = createKeyedQueue()
  const order = []

  const p1 = queue.enqueue('chat1', async () => {
    order.push('task1')
    throw new Error('boom')
  })
  const p2 = queue.enqueue('chat1', async () => {
    order.push('task2')
    return 'ok'
  })

  await assert.rejects(p1, /boom/)
  assert.equal(await p2, 'ok')
  assert.deepEqual(order, ['task1', 'task2'])
})

test('createKeyedQueue: enqueue resolves/rejects with the task\'s own outcome', async () => {
  const queue = createKeyedQueue()
  assert.equal(await queue.enqueue('k', () => 'value'), 'value')
  await assert.rejects(queue.enqueue('k', () => { throw new Error('nope') }), /nope/)
})
