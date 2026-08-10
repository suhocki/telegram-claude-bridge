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

export function formatToolStatusLine(name, input, maxLen = 60) {
  const label = name || 'tool'
  const summary = summarizeToolInput(name, input)
  if (!summary) return `⏳ ${label}…`
  const truncated = truncateStatus(summary, maxLen)
  const suffix = truncated.endsWith('…') ? '' : '…'
  return `⏳ ${label}: ${truncated}${suffix}`
}

export function formatTextPreviewStatus(text, maxLen = 80) {
  const t = String(text ?? '').trim()
  if (!t) return null
  return `✍️ ${truncateStatus(t, maxLen)}`
}

export function formatRunOutcomeStatus(isError) {
  return isError ? '❌ failed' : '✅ done'
}

const HISTORY_LINE_MAX_CHARS = 80

// How many "still working" lines (tool calls + frozen thinking) stay visible below the
// last checkpoint. Older ones just scroll off — they're not the record, the 💬
// checkpoints are.
export const MAX_EPHEMERAL_LINES = 6

// Renders one ephemeral (non-checkpoint) entry. Thinking entries are pre-baked text;
// tool entries carry their own state emoji plus either a human gloss (once one arrives
// from describeTool) or formatToolStatusLine's raw "Label: summary" fallback — reused
// verbatim (minus its hardcoded ⏳) so there's always something to show immediately,
// before any gloss has had a chance to come back, without duplicating its truncation
// and "always end in an ellipsis" behavior.
function renderEphemeral(entry) {
  if (entry.kind === 'thinking') return entry.text
  if (entry.gloss) return `${entry.state} ${truncateStatus(entry.gloss, HISTORY_LINE_MAX_CHARS)}`
  return `${entry.state}${formatToolStatusLine(entry.name, entry.input).slice(1)}`
}

// Builds a running transcript instead of a single overwritten status line. Only frozen
// *text* segments — the 💬 lines meant for a human to read — become permanent
// `checkpointLines`. Tool calls and frozen *thinking* segments are transient: they live
// in `ephemeral` (capped to MAX_EPHEMERAL_LINES) just to show something is still
// happening, and the whole batch collapses away the moment the next 💬 checkpoint lands,
// same as the one live segment (a thinking block or the reply text) that stays fully
// visible as the tail until the next tool call or kind switch freezes it too.
export function createProgressTracker(
  initialStatus = DEFAULT_WORKING_STATUS,
  { renderTranscript, maxEphemeralLines = MAX_EPHEMERAL_LINES, glossTool } = {}
) {
  const seenToolIds = new Set()
  const finishedToolIds = new Set()
  const checkpointLines = []
  let ephemeral = []
  let liveText = ''
  let liveKind = null // 'thinking' | 'text' | null
  let status = initialStatus
  let statusIsHtml = false
  let snapshotCache = { text: status, html: statusIsHtml }

  function pushEphemeral(entry) {
    if (ephemeral.length >= maxEphemeralLines) ephemeral.shift()
    ephemeral.push(entry)
  }

  function freezeLive() {
    const trimmed = liveText.trim()
    if (trimmed) {
      if (liveKind === 'thinking') {
        pushEphemeral({ kind: 'thinking', text: `🤔 ${truncateStatus(trimmed, HISTORY_LINE_MAX_CHARS)}` })
      } else {
        checkpointLines.push(`💬 ${truncateStatus(trimmed, HISTORY_LINE_MAX_CHARS)}`)
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
      pushEphemeral({ kind: 'tool', id: block.id, name: block.name, input: block.input, state: '⏳', gloss: null })
      changed = true
      // Fire-and-forget: describeTool() applies the gloss (and re-commits the status)
      // whenever/if it resolves. A slow or failing glossTool just leaves the raw
      // "Label: summary" fallback on screen — never blocks or breaks ingest() itself.
      if (glossTool) {
        Promise.resolve()
          .then(() => glossTool(block.name, block.input))
          .then(text => describeTool(block.id, text))
          .catch(() => {})
      }
    }

    for (const result of extractToolResults(event)) {
      if (finishedToolIds.has(result.id)) continue
      const entry = ephemeral.find(e => e.kind === 'tool' && e.id === result.id)
      if (!entry) continue // already scrolled off the ephemeral window, or unknown — nothing to mark
      finishedToolIds.add(result.id)
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

  // Applies a short human-language gloss (from a lightweight model, see gloss.mjs) to a
  // still-visible tool line, replacing its raw "Label: summary" fallback. A no-op if the
  // line already scrolled out of the ephemeral window by the time the gloss comes back —
  // there's nothing left on screen to upgrade.
  function describeTool(id, gloss) {
    const trimmed = String(gloss ?? '').trim()
    if (!trimmed) return null
    const entry = ephemeral.find(e => e.kind === 'tool' && e.id === id)
    if (!entry) return null
    entry.gloss = trimmed
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

  return { ingest, describeTool, current, snapshot }
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
