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
  Task: 'description',
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

// Builds a running transcript instead of a single overwritten status line: completed
// tool calls and frozen thinking/text segments accumulate in `historyLines` (each kept
// brief), while the segment currently streaming in (a thinking block or the reply text)
// stays fully visible as the "live" tail until the next tool call or kind switch freezes
// it into history too.
export function createProgressTracker(initialStatus = DEFAULT_WORKING_STATUS, { renderTranscript } = {}) {
  const seenToolIds = new Set()
  const finishedToolIds = new Set()
  const toolLineIndex = new Map()
  const historyLines = []
  let liveText = ''
  let liveKind = null // 'thinking' | 'text' | null
  let status = initialStatus
  let statusIsHtml = false
  let snapshotCache = { text: status, html: statusIsHtml }

  function freezeLive() {
    const trimmed = liveText.trim()
    if (trimmed) {
      const prefix = liveKind === 'thinking' ? '🤔' : '💬'
      historyLines.push(`${prefix} ${truncateStatus(trimmed, HISTORY_LINE_MAX_CHARS)}`)
    }
    liveText = ''
    liveKind = null
  }

  function liveDisplayText() {
    if (!liveText) return ''
    return liveKind === 'thinking' ? `🤔 thinking…\n${liveText}` : liveText
  }

  function defaultRender() {
    const preview = liveText.trim()
      ? liveKind === 'thinking'
        ? `🤔 ${truncateStatus(liveText.trim(), HISTORY_LINE_MAX_CHARS)}`
        : formatTextPreviewStatus(liveText)
      : null
    return truncateStatus([...historyLines, preview].filter(Boolean).join('\n'), 2000)
  }

  function ingest(event) {
    let changed = false

    for (const block of extractToolUseBlocks(event)) {
      if (seenToolIds.has(block.id)) continue
      seenToolIds.add(block.id)
      freezeLive()
      historyLines.push(formatToolStatusLine(block.name, block.input))
      toolLineIndex.set(block.id, historyLines.length - 1)
      changed = true
    }

    for (const result of extractToolResults(event)) {
      if (finishedToolIds.has(result.id)) continue
      const idx = toolLineIndex.get(result.id)
      if (idx === undefined) continue
      finishedToolIds.add(result.id)
      historyLines[idx] = historyLines[idx].replace(/^⏳/, result.isError ? '❌' : '✅')
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

    status = renderTranscript ? renderTranscript(historyLines.slice(), liveDisplayText()) : defaultRender()
    statusIsHtml = Boolean(renderTranscript)
    snapshotCache = { text: status, html: statusIsHtml }
    return status
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

export function createStatusUpdater({ getStatus, onUpdate, initialStatus = DEFAULT_WORKING_STATUS, intervalMs = 3000 }) {
  let alive = true
  let lastSent = initialStatus
  let skipTicks = 0
  const timer = setInterval(() => {
    if (!alive) return
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
    // skipping however many ticks roughly cover the requested wait
    pauseFor(ms) {
      skipTicks = Math.max(skipTicks, Math.ceil(ms / intervalMs))
    },
    get alive() {
      return alive
    },
  }
}
