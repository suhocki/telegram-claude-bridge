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

export function createProgressTracker(initialStatus = DEFAULT_WORKING_STATUS, { renderText } = {}) {
  const seenToolIds = new Set()
  let textBuffer = ''
  let status = initialStatus
  let statusIsHtml = false
  let snapshotCache = { text: status, html: statusIsHtml }

  function ingest(event) {
    let changed = false
    for (const block of extractToolUseBlocks(event)) {
      if (seenToolIds.has(block.id)) continue
      seenToolIds.add(block.id)
      status = formatToolStatusLine(block.name, block.input)
      statusIsHtml = false
      changed = true
    }
    const delta = extractTextDelta(event)
    if (delta) {
      textBuffer += delta
      const preview = renderText ? renderText(textBuffer) : formatTextPreviewStatus(textBuffer)
      if (preview) {
        status = preview
        statusIsHtml = Boolean(renderText)
        changed = true
      }
    }
    if (changed) snapshotCache = { text: status, html: statusIsHtml }
    return changed ? status : null
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
