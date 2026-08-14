import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_WORKING_STATUS,
  MAX_EPHEMERAL_LINES,
  MAX_CHECKPOINT_LINES,
  createLineSplitter,
  parseJsonlLine,
  isResultEvent,
  extractSessionId,
  extractToolUseBlocks,
  extractTextDelta,
  extractThinkingDelta,
  extractToolResults,
  extractNewSubagentBlocks,
  extractFinishedSubagentIds,
  SUBAGENT_TOOL_NAME,
  summarizeToolInput,
  truncateStatus,
  formatTextPreviewStatus,
  createProgressTracker,
  createStatusUpdater,
  createChatRateGate,
} from '../stream-progress.mjs'

test('createLineSplitter yields complete lines and buffers partial ones', () => {
  const push = createLineSplitter()
  assert.deepEqual(push('{"a":1}\n{"b":2'), ['{"a":1}'])
  assert.deepEqual(push('}\n{"c":3}\n'), ['{"b":2}', '{"c":3}'])
  assert.deepEqual(push(''), [])
})

test('createLineSplitter drops blank lines', () => {
  const push = createLineSplitter()
  assert.deepEqual(push('\n\n{"a":1}\n\n'), ['{"a":1}'])
})

test('createLineSplitter handles a chunk split mid-line across many pushes', () => {
  const push = createLineSplitter()
  const line = '{"type":"result","result":"hi"}'
  const mid = Math.floor(line.length / 2)
  assert.deepEqual(push(line.slice(0, mid)), [])
  assert.deepEqual(push(`${line.slice(mid)}\n`), [line])
})

test('parseJsonlLine parses valid JSON', () => {
  assert.deepEqual(parseJsonlLine('{"type":"result"}'), { type: 'result' })
})

test('parseJsonlLine returns null on malformed JSON', () => {
  assert.equal(parseJsonlLine('not json'), null)
  assert.equal(parseJsonlLine(''), null)
})

test('isResultEvent recognizes the terminal result event only', () => {
  assert.equal(isResultEvent({ type: 'result', result: 'done' }), true)
  assert.equal(isResultEvent({ type: 'assistant' }), false)
  assert.equal(isResultEvent(null), false)
  assert.equal(isResultEvent(undefined), false)
})

test('extractSessionId reads session_id off any event that carries one, not just result', () => {
  assert.equal(extractSessionId({ type: 'system', subtype: 'init', session_id: 'abc-123' }), 'abc-123')
  assert.equal(extractSessionId({ type: 'rate_limit_event', session_id: 'abc-123' }), 'abc-123')
  assert.equal(extractSessionId({ type: 'result', session_id: 'abc-123' }), 'abc-123')
})

test('extractSessionId returns null for a missing, empty, or non-string session_id', () => {
  assert.equal(extractSessionId({ type: 'assistant' }), null)
  assert.equal(extractSessionId({ type: 'assistant', session_id: '' }), null)
  assert.equal(extractSessionId({ type: 'assistant', session_id: 42 }), null)
  assert.equal(extractSessionId(null), null)
  assert.equal(extractSessionId(undefined), null)
})

test('extractToolUseBlocks reads tool_use blocks off an assistant snapshot event', () => {
  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  }
  assert.deepEqual(extractToolUseBlocks(event), [{ id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }])
})

test('extractToolUseBlocks returns empty for non-assistant or malformed events', () => {
  assert.deepEqual(extractToolUseBlocks({ type: 'result' }), [])
  assert.deepEqual(extractToolUseBlocks({ type: 'assistant' }), [])
  assert.deepEqual(extractToolUseBlocks({ type: 'assistant', message: { content: 'nope' } }), [])
  assert.deepEqual(extractToolUseBlocks(null), [])
})

test('extractToolUseBlocks ignores tool_use blocks without an id', () => {
  const event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }
  assert.deepEqual(extractToolUseBlocks(event), [])
})

test('extractTextDelta reads assistant text deltas from partial-message stream events', () => {
  const event = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } }
  assert.equal(extractTextDelta(event), 'Hello')
})

test('extractTextDelta ignores other delta/event types', () => {
  assert.equal(extractTextDelta({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } } }), null)
  assert.equal(extractTextDelta({ type: 'stream_event', event: { type: 'message_start' } }), null)
  assert.equal(extractTextDelta({ type: 'assistant' }), null)
  assert.equal(extractTextDelta(null), null)
})

test('extractThinkingDelta reads extended-thinking deltas from partial-message stream events', () => {
  const event = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me check' } } }
  assert.equal(extractThinkingDelta(event), 'Let me check')
})

test('extractThinkingDelta ignores other delta/event types', () => {
  assert.equal(extractThinkingDelta({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }), null)
  assert.equal(extractThinkingDelta({ type: 'stream_event', event: { type: 'message_start' } }), null)
  assert.equal(extractThinkingDelta({ type: 'assistant' }), null)
  assert.equal(extractThinkingDelta(null), null)
})

test('extractToolResults reads tool_result blocks off a user message', () => {
  const event = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi', is_error: false }] } }
  assert.deepEqual(extractToolResults(event), [{ id: 'toolu_1', isError: false }])
})

test('extractToolResults reads multiple parallel tool_result blocks and defaults is_error to false', () => {
  const event = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
      ],
    },
  }
  assert.deepEqual(extractToolResults(event), [
    { id: 'toolu_1', isError: false },
    { id: 'toolu_2', isError: true },
  ])
})

test('extractToolResults returns empty for non-user or malformed events', () => {
  assert.deepEqual(extractToolResults({ type: 'assistant' }), [])
  assert.deepEqual(extractToolResults({ type: 'user', message: { content: 'nope' } }), [])
  assert.deepEqual(extractToolResults({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), [])
  assert.deepEqual(extractToolResults(null), [])
})

test('extractNewSubagentBlocks picks out only Task tool_use blocks not already tracked', () => {
  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: SUBAGENT_TOOL_NAME, input: { description: 'explore repo' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'toolu_3', name: SUBAGENT_TOOL_NAME, input: { description: 'run tests' } },
      ],
    },
  }
  const result = extractNewSubagentBlocks(event, new Set())
  assert.deepEqual(result.map(b => b.id), ['toolu_1', 'toolu_3'])
})

test('extractNewSubagentBlocks skips Task blocks whose id is already tracked', () => {
  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: SUBAGENT_TOOL_NAME, input: { description: 'explore repo' } },
        { type: 'tool_use', id: 'toolu_2', name: SUBAGENT_TOOL_NAME, input: { description: 'run tests' } },
      ],
    },
  }
  const result = extractNewSubagentBlocks(event, new Set(['toolu_1']))
  assert.deepEqual(result.map(b => b.id), ['toolu_2'])
})

test('extractNewSubagentBlocks accepts a Map (or anything with .has) as the tracked-ids set', () => {
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: SUBAGENT_TOOL_NAME, input: {} }] },
  }
  const tracked = new Map([['toolu_1', { messageId: 1 }]])
  assert.deepEqual(extractNewSubagentBlocks(event, tracked), [])
})

test('extractNewSubagentBlocks returns empty when there are no tool_use blocks at all', () => {
  assert.deepEqual(extractNewSubagentBlocks({ type: 'assistant', message: { content: [] } }, new Set()), [])
  assert.deepEqual(extractNewSubagentBlocks(null, new Set()), [])
})

test('extractFinishedSubagentIds picks out only tool_result ids that are currently tracked', () => {
  const event = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_untracked', is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_3', is_error: true },
      ],
    },
  }
  const result = extractFinishedSubagentIds(event, new Set(['toolu_1', 'toolu_3']))
  assert.deepEqual(result, ['toolu_1', 'toolu_3'])
})

test('extractFinishedSubagentIds returns empty when nothing tracked matches', () => {
  const event = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x' }] } }
  assert.deepEqual(extractFinishedSubagentIds(event, new Set(['toolu_1'])), [])
  assert.deepEqual(extractFinishedSubagentIds(null, new Set(['toolu_1'])), [])
})

test('summarizeToolInput picks the right field per tool and basenames paths', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test')
  assert.equal(summarizeToolInput('Edit', { file_path: '/repo/src/foo.py' }), 'foo.py')
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://example.com' }), 'https://example.com')
  assert.equal(summarizeToolInput('UnknownTool', { x: 1 }), null)
  assert.equal(summarizeToolInput('Bash', {}), null)
  assert.equal(summarizeToolInput('Bash', undefined), null)
})

test('truncateStatus leaves short text untouched and ellipsizes long text', () => {
  assert.equal(truncateStatus('short', 60), 'short')
  const long = 'x'.repeat(100)
  const result = truncateStatus(long, 60)
  assert.equal(result.length, 60)
  assert.ok(result.endsWith('…'))
})

test('createProgressTracker falls back to just the tool name when there is no summary to render', () => {
  const tracker = createProgressTracker()
  assert.equal(
    tracker.ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }] } }),
    '⏳ Task…'
  )
})

test('createProgressTracker never doubles up the ellipsis on a fallback tool line that needed truncating', () => {
  const tracker = createProgressTracker()
  const status = tracker.ingest({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'x'.repeat(100) } }] },
  })
  assert.equal(status.match(/…/g).length, 1)
})

test('formatTextPreviewStatus previews accumulated assistant text', () => {
  assert.equal(formatTextPreviewStatus('Looking into this now'), '✍️ Looking into this now')
  assert.equal(formatTextPreviewStatus('   '), null)
  assert.equal(formatTextPreviewStatus(''), null)
})

test('createProgressTracker starts at the default working status', () => {
  const tracker = createProgressTracker()
  assert.equal(tracker.current(), DEFAULT_WORKING_STATUS)
})

test('createProgressTracker reports a new status line on a fresh tool_use block', () => {
  const tracker = createProgressTracker()
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  }
  assert.equal(tracker.ingest(event), '⏳ Bash: npm test…')
  assert.equal(tracker.current(), '⏳ Bash: npm test…')
})

test('createProgressTracker does not re-announce a tool_use block already seen, and appends (not replaces) on a new one', () => {
  const tracker = createProgressTracker()
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  }
  tracker.ingest(event)
  assert.equal(tracker.ingest(event), null)
  const grown = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/a/foo.py' } },
      ],
    },
  }
  assert.equal(tracker.ingest(grown), '⏳ Bash: npm test…\n⏳ Edit: foo.py…')
})

test('createProgressTracker: a tool_result marks its history line done (✅) or failed (❌)', () => {
  const tracker = createProgressTracker()
  tracker.ingest({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/a/foo.py' } },
      ],
    },
  })
  const status = tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } })
  assert.equal(status, '✅ Bash: npm test…\n⏳ Edit: foo.py…')
  const status2 = tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }] } })
  assert.equal(status2, '✅ Bash: npm test…\n❌ Edit: foo.py…')
})

test('createProgressTracker: a tool_result for an unknown or already-finished id is ignored', () => {
  const tracker = createProgressTracker()
  tracker.ingest({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  })
  assert.equal(tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: false }] } }), null)
  tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] } })
  assert.equal(tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }] } }), null)
  assert.equal(tracker.current(), '✅ Bash: npm test…')
})

test('createProgressTracker: a thinking delta accumulates as a live preview distinct from the text preview', () => {
  const tracker = createProgressTracker()
  const thinking = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } } })
  assert.equal(tracker.ingest(thinking('Let me check')), '🤔 Let me check')
  assert.equal(tracker.ingest(thinking(' the tests')), '🤔 Let me check the tests')
})

test('createProgressTracker: switching from thinking to text freezes the thinking gist into history', () => {
  const tracker = createProgressTracker()
  const thinking = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } } })
  const text = t => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  tracker.ingest(thinking('Let me check the tests'))
  const status = tracker.ingest(text('All good'))
  assert.equal(status, '🤔 Let me check the tests\n✍️ All good')
})

test('createProgressTracker: a tool call after live text freezes it into history with a 💬 prefix', () => {
  const tracker = createProgressTracker()
  const text = t => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  tracker.ingest(text('Looking into it'))
  const status = tracker.ingest({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  })
  assert.equal(status, '💬 Looking into it\n⏳ Bash: npm test…')
})

test('createProgressTracker accumulates text deltas into a growing preview', () => {
  const tracker = createProgressTracker()
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  assert.equal(tracker.ingest(delta('Hello')), '✍️ Hello')
  assert.equal(tracker.ingest(delta(' world')), '✍️ Hello world')
})

test('createProgressTracker.snapshot starts as { text: initialStatus, html: false }', () => {
  const tracker = createProgressTracker()
  assert.deepEqual(tracker.snapshot(), { text: DEFAULT_WORKING_STATUS, html: false })
})

test('createProgressTracker.snapshot reflects a tool status line as non-html', () => {
  const tracker = createProgressTracker()
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  }
  tracker.ingest(event)
  assert.deepEqual(tracker.snapshot(), { text: '⏳ Bash: npm test…', html: false })
})

test('createProgressTracker.snapshot returns the same object reference across ingests that report no change', () => {
  const tracker = createProgressTracker()
  const before = tracker.snapshot()
  tracker.ingest({ type: 'system', subtype: 'init' })
  assert.equal(tracker.snapshot(), before)
})

test('createProgressTracker: without a renderTranscript option, text deltas still fall back to the truncated plain-text preview', () => {
  const tracker = createProgressTracker()
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  tracker.ingest(delta('Hello world'))
  assert.deepEqual(tracker.snapshot(), { text: '✍️ Hello world', html: false })
})

test('createProgressTracker: with a renderTranscript option, changes are rendered through it (history, live) and marked html', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, {
    renderTranscript: (history, live) => `[${history.join('|')}]<b>${live}</b>`,
  })
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  assert.equal(tracker.ingest(delta('Hello')), '[]<b>Hello</b>')
  assert.deepEqual(tracker.snapshot(), { text: '[]<b>Hello</b>', html: true })
  tracker.ingest(delta(' world'))
  assert.deepEqual(tracker.snapshot(), { text: '[]<b>Hello world</b>', html: true })
})

test('createProgressTracker: a tool_use event freezes live text into history (passed to renderTranscript) and stays html=true', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, {
    renderTranscript: (history, live) => JSON.stringify({ history, live }),
  })
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  tracker.ingest(delta('Hello'))
  const toolEvent = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  }
  tracker.ingest(toolEvent)
  const snap = tracker.snapshot()
  assert.equal(snap.html, true)
  assert.deepEqual(JSON.parse(snap.text), { history: ['💬 Hello', '⏳ Bash: npm test…'], live: '' })
})

test('createProgressTracker ignores events with nothing new to report', () => {
  const tracker = createProgressTracker()
  assert.equal(tracker.ingest({ type: 'system', subtype: 'init' }), null)
  assert.equal(tracker.ingest({ type: 'result', result: 'done' }), null)
})

test('regression: a renderTranscript that returns null does not clobber the prior status with null (and reports no change)', () => {
  let renderNull = false
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, {
    renderTranscript: (history, live) => (renderNull ? null : `[${history.join('|')}]${live}`),
  })
  const toolEvent = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  }
  const first = tracker.ingest(toolEvent)
  assert.equal(first, '[⏳ Bash: npm test…]')

  renderNull = true
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const second = tracker.ingest(delta('some text'))
  assert.equal(second, null, 'ingest should report no visible change when the renderer has nothing to show')
  assert.deepEqual(tracker.snapshot(), { text: first, html: true }, 'the previous good status must survive a null render')
})

test('createStatusUpdater fires onUpdate on an interval while the status changes', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let status = 'first'
  const updates = []
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => updates.push(s), initialStatus: status, intervalMs: 1000 })
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [])
  status = 'second'
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, ['second'])
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, ['second'])
  updater.stop()
})

test('createStatusUpdater.stop clears the interval so onUpdate never fires again', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let status = 'first'
  const updates = []
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => updates.push(s), initialStatus: status, intervalMs: 1000 })
  updater.stop()
  status = 'second'
  t.mock.timers.tick(5000)
  assert.deepEqual(updates, [])
  assert.equal(updater.alive, false)
})

test('createStatusUpdater.stop is idempotent and safe to call from multiple code paths (e.g. both the success path and a shared cleanup finally)', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const updater = createStatusUpdater({ getStatus: () => 'x', onUpdate: () => {}, intervalMs: 1000 })
  updater.stop()
  assert.doesNotThrow(() => updater.stop())
  assert.equal(updater.alive, false)
})

test('createStatusUpdater.pauseFor skips enough ticks to cover the requested backoff, then resumes', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let status = 'first'
  const updates = []
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => updates.push(s), initialStatus: status, intervalMs: 1000 })
  status = 'second'
  updater.pauseFor(2500)
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [])
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [])
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [])
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, ['second'])
  updater.stop()
})

test('createStatusUpdater.pauseFor calls during an active pause extend it rather than shortening it', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let status = 'first'
  const updates = []
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => updates.push(s), initialStatus: status, intervalMs: 1000 })
  status = 'second'
  updater.pauseFor(3000)
  updater.pauseFor(500)
  t.mock.timers.tick(1000)
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [], 'a shorter pauseFor call should not cut the longer pause short')
  t.mock.timers.tick(1000)
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, ['second'])
  updater.stop()
})

test('createChatRateGate starts unpaused', () => {
  const gate = createChatRateGate()
  assert.equal(gate.isPaused(), false)
})

test('createChatRateGate: pauseFor(ms) pauses immediately and resumes once real time advances past it', t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const gate = createChatRateGate()
  gate.pauseFor(3000)
  assert.equal(gate.isPaused(), true)
  t.mock.timers.tick(2999)
  assert.equal(gate.isPaused(), true)
  t.mock.timers.tick(2)
  assert.equal(gate.isPaused(), false)
})

test('createChatRateGate: a shorter pauseFor call during an active pause does not shorten it', t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const gate = createChatRateGate()
  gate.pauseFor(5000)
  gate.pauseFor(100)
  t.mock.timers.tick(4999)
  assert.equal(gate.isPaused(), true, 'the longer pause should still be in effect')
  t.mock.timers.tick(2)
  assert.equal(gate.isPaused(), false)
})

test('createStatusUpdater: a shared gate that is paused suppresses updates even when the status changes', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let status = 'first'
  const updates = []
  const sharedGate = createChatRateGate()
  sharedGate.pauseFor(10000)
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => updates.push(s), initialStatus: status, intervalMs: 1000, sharedGate })
  status = 'second'
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [], 'the shared gate being paused should block this controller too')
  t.mock.timers.tick(9000)
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, ['second'], 'once the shared pause elapses, the pending change should go out')
  updater.stop()
})

test('createStatusUpdater.pauseFor also pauses the shared gate, affecting sibling controllers', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const sharedGate = createChatRateGate()
  let statusA = 'a1'
  let statusB = 'b1'
  const updatesA = []
  const updatesB = []
  const updaterA = createStatusUpdater({ getStatus: () => statusA, onUpdate: s => updatesA.push(s), initialStatus: statusA, intervalMs: 1000, sharedGate })
  const updaterB = createStatusUpdater({ getStatus: () => statusB, onUpdate: s => updatesB.push(s), initialStatus: statusB, intervalMs: 1000, sharedGate })

  updaterA.pauseFor(5000)
  statusA = 'a2'
  statusB = 'b2'
  t.mock.timers.tick(1000)
  assert.deepEqual(updatesA, [], 'the controller that paused should itself stay paused')
  assert.deepEqual(updatesB, [], 'a sibling controller sharing the same gate should also be paused')

  t.mock.timers.tick(4000)
  t.mock.timers.tick(1000)
  assert.deepEqual(updatesA, ['a2'])
  assert.deepEqual(updatesB, ['b2'])
  updaterA.stop()
  updaterB.stop()
})

test('regression: stopping before writing an error message prevents a later stale tick from clobbering it (bridge.mjs catch-path ordering)', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let status = '⏳ Bash: some stale progress line'
  const writes = []
  const updater = createStatusUpdater({ getStatus: () => status, onUpdate: s => writes.push(s), initialStatus: status, intervalMs: 3000 })
  updater.stop()
  writes.push('⚠️ bridge error: boom')
  t.mock.timers.tick(10000)
  assert.deepEqual(writes, ['⚠️ bridge error: boom'])
})

test('createProgressTracker: a checkpoint (💬) collapses every ephemeral tool/thinking line that led up to it', () => {
  const tracker = createProgressTracker()
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const text = t => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })

  tracker.ingest(tool('toolu_1', 'Bash', { command: 'grep -rn foo' }))
  tracker.ingest(tool('toolu_2', 'Edit', { file_path: '/a/foo.py' }))
  tracker.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] } })
  assert.equal(tracker.current(), '✅ Bash: grep -rn foo…\n⏳ Edit: foo.py…')

  const status = tracker.ingest(text('Found it, writing the fix'))
  assert.equal(
    status,
    '✅ Bash: grep -rn foo…\n⏳ Edit: foo.py…\n✍️ Found it, writing the fix',
    'the working tail stays visible alongside the streaming live preview — nothing collapses yet'
  )

  const nextTool = tracker.ingest(tool('toolu_3', 'Bash', { command: 'npm test' }))
  assert.equal(
    nextTool,
    '💬 Found it, writing the fix\n⏳ Bash: npm test…',
    'freezing the text turns it into a permanent checkpoint and drops the two earlier tool lines entirely'
  )
})

test('createProgressTracker: ephemeral lines are capped at MAX_EPHEMERAL_LINES, oldest first', () => {
  const tracker = createProgressTracker()
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  let last
  for (let i = 1; i <= MAX_EPHEMERAL_LINES + 2; i += 1) {
    last = tracker.ingest(tool(`toolu_${i}`, 'Bash', { command: `step ${i}` }))
  }
  const lines = last.split('\n')
  assert.equal(lines.length, MAX_EPHEMERAL_LINES)
  assert.equal(lines[0], '⏳ Bash: step 3…', 'the two oldest calls (1 and 2) should have scrolled off')
  assert.equal(lines[lines.length - 1], `⏳ Bash: step ${MAX_EPHEMERAL_LINES + 2}…`)
})

test('createProgressTracker: checkpoint (💬) lines are capped at MAX_CHECKPOINT_LINES, oldest first', () => {
  const tracker = createProgressTracker()
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const text = t => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })

  // each text+tool pair freezes one checkpoint line (the tool_use event triggers freezeLive on the preceding text)
  for (let i = 1; i <= MAX_CHECKPOINT_LINES + 2; i += 1) {
    tracker.ingest(text(`step ${i}`))
    tracker.ingest(tool(`toolu_${i}`, 'Bash', { command: `cmd ${i}` }))
  }

  const checkpointLines = tracker.current().split('\n').filter(l => l.startsWith('💬'))
  assert.equal(checkpointLines.length, MAX_CHECKPOINT_LINES)
  assert.equal(checkpointLines[0], '💬 step 3', 'the two oldest checkpoints (1 and 2) should have scrolled off')
  assert.equal(checkpointLines[checkpointLines.length - 1], `💬 step ${MAX_CHECKPOINT_LINES + 2}`)
})

test('createProgressTracker: a tool_result for a line already evicted by the cap is quietly ignored', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, { maxEphemeralLines: 2 })
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  tracker.ingest(tool('toolu_1', 'Bash', { command: 'a' }))
  tracker.ingest(tool('toolu_2', 'Bash', { command: 'b' }))
  tracker.ingest(tool('toolu_3', 'Bash', { command: 'c' })) // evicts toolu_1
  const status = tracker.ingest({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }] },
  })
  assert.equal(status, null)
  assert.equal(tracker.current(), '⏳ Bash: b…\n⏳ Bash: c…')
})

test('createProgressTracker.historySnapshot freezes any trailing live text into a checkpoint before returning', () => {
  const tracker = createProgressTracker()
  tracker.ingest({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'still going' } } })
  assert.deepEqual(tracker.historySnapshot(), ['💬 still going'])
})

test('createProgressTracker.historySnapshot returns the checkpoint lines seen so far, oldest first', () => {
  const tracker = createProgressTracker()
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const text = t => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  tracker.ingest(text('first'))
  tracker.ingest(tool('toolu_1', 'Bash', { command: 'a' }))
  tracker.ingest(text('second'))
  assert.deepEqual(tracker.historySnapshot(), ['💬 first', '💬 second'])
})

test('createProgressTracker: initialCheckpointLines seeds history immediately, before any event is ingested', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, { initialCheckpointLines: ['💬 from before'] })
  assert.equal(tracker.current(), '💬 from before')
})

test('createProgressTracker: new checkpoints append after seeded initialCheckpointLines, not replacing them', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, { initialCheckpointLines: ['💬 from before'] })
  const status = tracker.ingest({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'continuing' } },
  })
  assert.equal(status, '💬 from before\n✍️ continuing')
})

test('createProgressTracker: initialCheckpointLines are subject to the same maxCheckpointLines cap as any other checkpoint', () => {
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, {
    maxCheckpointLines: 2,
    initialCheckpointLines: ['💬 one', '💬 two', '💬 three'],
  })
  assert.equal(tracker.current(), '💬 two\n💬 three')
})

test('regression: the subagent tool is really named "Agent" in a real captured claude -p stream, not "Task"', () => {
  const fixturePath = new URL('./fixtures/subagent-stream-sample.jsonl', import.meta.url)
  const raw = readFileSync(fixturePath, 'utf8')

  // hardcoded literally (not via SUBAGENT_TOOL_NAME) so this test still catches it if
  // that constant is ever wrongly changed back to "Task" or something else
  assert.ok(raw.includes('"name":"Agent"'), 'the captured stream should contain a literal "name":"Agent" tool_use block')
  assert.ok(!raw.includes('"name":"Task"'), 'the captured stream should not use "Task" as the subagent tool name')

  const events = raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))

  const tracked = new Set()
  let spawnedIds = []
  let finishedIds = []
  for (const event of events) {
    spawnedIds.push(...extractNewSubagentBlocks(event, tracked).map(b => b.id))
    for (const id of spawnedIds) tracked.add(id)
    finishedIds.push(...extractFinishedSubagentIds(event, tracked))
  }

  assert.equal(spawnedIds.length, 1, 'exactly one subagent should have been detected in this fixture')
  assert.deepEqual(finishedIds, spawnedIds, 'the one subagent detected should also be detected as finished')
})
