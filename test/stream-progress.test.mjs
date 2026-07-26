import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WORKING_STATUS,
  createLineSplitter,
  parseJsonlLine,
  isResultEvent,
  extractToolUseBlocks,
  extractTextDelta,
  extractThinkingDelta,
  extractToolResults,
  summarizeToolInput,
  truncateStatus,
  formatToolStatusLine,
  formatTextPreviewStatus,
  formatRunOutcomeStatus,
  createProgressTracker,
  createStatusUpdater,
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

test('formatToolStatusLine matches the expected "tool: summary…" shape', () => {
  assert.equal(formatToolStatusLine('Bash', { command: 'npm test' }), '⏳ Bash: npm test…')
  assert.equal(formatToolStatusLine('Edit', { file_path: '/a/b/foo.py' }), '⏳ Edit: foo.py…')
})

test('formatToolStatusLine falls back to just the tool name when there is no summary', () => {
  assert.equal(formatToolStatusLine('Task', {}), '⏳ Task…')
  assert.equal(formatToolStatusLine(null, {}), '⏳ tool…')
})

test('formatToolStatusLine does not double up ellipses when truncated', () => {
  const line = formatToolStatusLine('Bash', { command: 'x'.repeat(100) }, 20)
  assert.equal(line.match(/…/g).length, 1)
})

test('formatTextPreviewStatus previews accumulated assistant text', () => {
  assert.equal(formatTextPreviewStatus('Looking into this now'), '✍️ Looking into this now')
  assert.equal(formatTextPreviewStatus('   '), null)
  assert.equal(formatTextPreviewStatus(''), null)
})

test('formatRunOutcomeStatus reflects success/failure', () => {
  assert.equal(formatRunOutcomeStatus(false), '✅ done')
  assert.equal(formatRunOutcomeStatus(true), '❌ failed')
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
