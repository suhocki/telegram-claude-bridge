import path from 'node:path'

export const DEFAULT_WORKING_STATUS = '⏳ working…'

export function createLineSplitter() {
  let buffer = ''
  return chunk => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    return parts.filter(line => line.trim() !== '')
  }
}

export function parseJsonlLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export function isResultEvent(event) {
  return event?.type === 'result'
}

export function extractToolUseBlocks(event) {
  if (event?.type !== 'assistant') return []
  const content = event.message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(block => block?.type === 'tool_use' && typeof block.id === 'string')
    .map(block => ({ id: block.id, name: block.name, input: block.input }))
}

export function extractTextDelta(event) {
  if (event?.type !== 'stream_event') return null
  const inner = event.event
  if (inner?.type !== 'content_block_delta') return null
  if (inner.delta?.type !== 'text_delta') return null
  return typeof inner.delta.text === 'string' ? inner.delta.text : null
}

export function extractThinkingDelta(event) {
  if (event?.type !== 'stream_event') return null
  const inner = event.event
  if (inner?.type !== 'content_block_delta') return null
  if (inner.delta?.type !== 'thinking_delta') return null
  return typeof inner.delta.thinking === 'string' ? inner.delta.thinking : null
}

// tool_result blocks come back as a `user` message once a tool finishes running
export function extractToolResults(event) {
  if (event?.type !== 'user') return []
  const content = event.message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(block => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map(block => ({ id: block.tool_use_id, isError: Boolean(block.is_error) }))
}

// The subagent-launching tool is named "Agent" in claude -p's stream-json output
// (verified against a real captured run — not "Task", despite that being the more
// commonly assumed name).
export const SUBAGENT_TOOL_NAME = 'Agent'

// Which tool_use blocks in this event are a subagent call not already being
// tracked — i.e. ones that need their own placeholder message started.
export function extractNewSubagentBlocks(event, alreadyTrackedIds) {
  return extractToolUseBlocks(event).filter(
    block => block.name === SUBAGENT_TOOL_NAME && !alreadyTrackedIds.has(block.id)
  )
}

// Which currently-tracked subagent ids just finished (their tool_result came back) —
// i.e. ones whose placeholder message should now be deleted.
export function extractFinishedSubagentIds(event, trackedIds) {
  return extractToolResults(event)
    .map(result => result.id)
    .filter(id => trackedIds.has(id))
}

const TOOL_SUMMARY_KEYS = {
  Bash: 'command',
  Edit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Agent: 'description',
}

const PATH_SUMMARY_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit'])

export function summarizeToolInput(name, input) {
  const key = TOOL_SUMMARY_KEYS[name]
  if (!key) return null
  const raw = input?.[key]
  if (raw == null || raw === '') return null
  const value = String(raw)
  return PATH_SUMMARY_TOOLS.has(name) ? path.basename(value) : value
}

export function truncateStatus(text, maxLen = 60) {
  const t = String(text ?? '')
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen - 1).trimEnd()}…`
}

// The "Label: summary…" body rendered for a tool line, regardless of its current state emoji.
function formatToolBody(name, input, maxLen = 60) {
  const label = name || 'tool'
  const summary = summarizeToolInput(name, input)
  if (!summary) return `${label}…`
  const truncated = truncateStatus(summary, maxLen)
  const suffix = truncated.endsWith('…') ? '' : '…'
  return `${label}: ${truncated}${suffix}`
}

export function formatTextPreviewStatus(text, maxLen = 80) {
  const t = String(text ?? '').trim()
  if (!t) return null
  return `✍️ ${truncateStatus(t, maxLen)}`
}

const HISTORY_LINE_MAX_CHARS = 80

// How many "still working" lines (tool calls + frozen thinking) stay visible below the last checkpoint before the oldest ones scroll off.
export const MAX_EPHEMERAL_LINES = 6
// Same idea for frozen 💬 checkpoints themselves — without a cap, a long-running turn's live status grows without bound.
export const MAX_CHECKPOINT_LINES = 6

function renderEphemeral(entry) {
  if (entry.kind === 'thinking') return entry.text
  return `${entry.state} ${formatToolBody(entry.name, entry.input)}`
}

// Only frozen *text* segments (💬, for a human) become permanent checkpointLines; tool calls and frozen thinking are ephemeral and collapse away on the next checkpoint.
export function createProgressTracker(
  initialStatus = DEFAULT_WORKING_STATUS,
  { renderTranscript, maxEphemeralLines = MAX_EPHEMERAL_LINES, maxCheckpointLines = MAX_CHECKPOINT_LINES } = {}
) {
  const seenToolIds = new Set()
  const checkpointLines = []
  let ephemeral = []
  let liveText = ''
  let liveKind = null // 'thinking' | 'text' | null
  let status = initialStatus
  let statusIsHtml = false
  let snapshotCache = { text: status, html: statusIsHtml }

  function pushBounded(array, maxLen, item) {
    if (array.length >= maxLen) array.shift()
    array.push(item)
  }

  function pushEphemeral(entry) {
    pushBounded(ephemeral, maxEphemeralLines, entry)
  }

  function pushCheckpoint(line) {
    pushBounded(checkpointLines, maxCheckpointLines, line)
  }

  function freezeLive() {
    const trimmed = liveText.trim()
    if (trimmed) {
      if (liveKind === 'thinking') {
        pushEphemeral({ kind: 'thinking', text: `🤔 ${truncateStatus(trimmed, HISTORY_LINE_MAX_CHARS)}` })
      } else {
        pushCheckpoint(`💬 ${truncateStatus(trimmed, HISTORY_LINE_MAX_CHARS)}`)
        ephemeral = [] // a checkpoint is the summary of everything that led to it — collapse the rest
      }
    }
    liveText = ''
    liveKind = null
  }

  function liveDisplayText() {
    if (!liveText) return ''
    return liveKind === 'thinking' ? `🤔 thinking…\n${liveText}` : liveText
  }

  function historyLines() {
    return [...checkpointLines, ...ephemeral.map(renderEphemeral)]
  }

  function defaultRender() {
    const preview = liveText.trim()
      ? liveKind === 'thinking'
        ? `🤔 ${truncateStatus(liveText.trim(), HISTORY_LINE_MAX_CHARS)}`
        : formatTextPreviewStatus(liveText)
      : null
    return truncateStatus([...historyLines(), preview].filter(Boolean).join('\n'), 2000)
  }

  function commit() {
    const rendered = renderTranscript ? renderTranscript(historyLines(), liveDisplayText()) : defaultRender()
    // renderTranscript can legitimately return null (e.g. nothing fits the budget this
    // tick) — treat that the same as "nothing new to report" rather than letting null
    // overwrite a perfectly good prior status (and leak downstream into an edit)
    if (rendered == null) return null

    status = rendered
    statusIsHtml = Boolean(renderTranscript)
    snapshotCache = { text: status, html: statusIsHtml }
    return status
  }

  function ingest(event) {
    let changed = false

    for (const block of extractToolUseBlocks(event)) {
      if (seenToolIds.has(block.id)) continue
      seenToolIds.add(block.id)
      freezeLive()
      pushEphemeral({ kind: 'tool', id: block.id, name: block.name, input: block.input, state: '⏳' })
      changed = true
    }

    for (const result of extractToolResults(event)) {
      const entry = ephemeral.find(e => e.kind === 'tool' && e.id === result.id)
      if (!entry || entry.state !== '⏳') continue // scrolled off, unknown, or already marked — nothing to do
      entry.state = result.isError ? '❌' : '✅'
      changed = true
    }

    const thinkingDelta = extractThinkingDelta(event)
    if (thinkingDelta) {
      if (liveKind !== 'thinking') freezeLive()
      liveKind = 'thinking'
      liveText += thinkingDelta
      changed = true
    }

    const textDelta = extractTextDelta(event)
    if (textDelta) {
      if (liveKind !== 'text') freezeLive()
      liveKind = 'text'
      liveText += textDelta
      changed = true
    }

    if (!changed) return null
    return commit()
  }

  function current() {
    return status
  }

  // stable object reference across ticks unless ingest() actually changed something,
  // so createStatusUpdater's `latest === lastSent` dedupe keeps working with this shape too
  function snapshot() {
    return snapshotCache
  }

  return { ingest, current, snapshot }
}

// Shared across every controller writing to the same chat (root + all its parallel
// subagent placeholders), so a 429 on any one of them pauses every other concurrent
// edit loop too, instead of leaving siblings to keep hammering an already-rate-limited
// chat. Plain wall-clock time, not tick-counting, since it's read by independently
// ticking timers with no shared cadence to count in.
export function createChatRateGate() {
  let pausedUntilMs = 0
  return {
    isPaused: () => Date.now() < pausedUntilMs,
    pauseFor(ms) {
      pausedUntilMs = Math.max(pausedUntilMs, Date.now() + ms)
    },
  }
}

export function createStatusUpdater({ getStatus, onUpdate, initialStatus = DEFAULT_WORKING_STATUS, intervalMs = 3000, sharedGate = null }) {
  let alive = true
  let lastSent = initialStatus
  let skipTicks = 0
  const timer = setInterval(() => {
    if (!alive) return
    if (sharedGate?.isPaused()) return
    if (skipTicks > 0) {
      skipTicks -= 1
      return
    }
    const latest = getStatus()
    if (latest === lastSent) return
    lastSent = latest
    onUpdate(latest)
  }, intervalMs)

  return {
    stop() {
      if (!alive) return
      alive = false
      clearInterval(timer)
    },
    // back off after a rate-limit response (e.g. Telegram's 429 retry_after) by
    // skipping however many ticks roughly cover the requested wait, and — if this
    // updater shares a chat-level gate — pausing every sibling controller too
    pauseFor(ms) {
      // with a shared gate, route pausing through it exclusively — otherwise this
      // controller's own skipTicks sits frozen (never decremented) for as long as the
      // gate itself is paused, then resumes counting down afterwards, roughly doubling
      // the pause on whichever controller happened to trigger it
      if (sharedGate) sharedGate.pauseFor(ms)
      else skipTicks = Math.max(skipTicks, Math.ceil(ms / intervalMs))
    },
    get alive() {
      return alive
    },
  }
}
