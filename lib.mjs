// Pure, testable helpers extracted out of bridge.mjs's imperative poll loop.

import path from 'node:path'

export function chunk(text, limit = 4096) {
  const out = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export function sanitizeAttr(s) {
  return String(s ?? '').replace(/[<>[\]\r\n"]/g, '_')
}

export function buildSendMessageCallsFromChunks(chatId, chunks, replyToMessageId, parseMode) {
  return chunks.map((part, i) => {
    const params = { chat_id: chatId, text: part }
    if (parseMode) params.parse_mode = parseMode
    if (i === 0 && replyToMessageId != null) {
      params.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true }
    }
    return params
  })
}

export function buildSendMessageCalls(chatId, text, replyToMessageId, limit = 4096, parseMode) {
  return buildSendMessageCallsFromChunks(chatId, chunk(text, limit), replyToMessageId, parseMode)
}

export function classifyCommand(text) {
  const t = String(text ?? '').trim()
  if (t === '/new' || t === '/reset') return 'reset'
  if (t === '/compact') return 'compact'
  if (t === '/status') return 'status'
  return null
}

export function normalizeSession(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') return { id: raw, costUsd: 0 }
  return { id: raw.id, costUsd: raw.costUsd ?? 0 }
}

export function accumulateSessionCost(session, sessionId, deltaUsd) {
  const prevCost = session?.costUsd ?? 0
  const cost = Math.round((prevCost + (Number(deltaUsd) || 0)) * 1e6) / 1e6
  return { id: sessionId, costUsd: cost }
}

export function crossedCostThreshold(prevCostUsd, newCostUsd, thresholdUsd) {
  if (!thresholdUsd) return false
  return prevCostUsd < thresholdUsd && newCostUsd >= thresholdUsd
}

export function buildCostWarning(costUsd, thresholdUsd) {
  return `⚠️ this session has cost $${costUsd.toFixed(4)}, over your $${thresholdUsd} warning threshold — consider /new to start fresh.`
}

export function formatStatusText(session) {
  if (!session) return 'ℹ️ no active session yet — send a message to start one.'
  return `session: ${session.id}\ncost so far: $${(session.costUsd ?? 0).toFixed(4)}`
}

export function buildChannelPrompt(chatId, messageId, user, ts, text, attrs = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ` ${k}="${sanitizeAttr(v)}"`)
    .join('')
  return `<channel source="telegram" chat_id="${chatId}" message_id="${messageId}" user="${user}" ts="${ts}"${extra}>\n${text}\n</channel>`
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export function extractAttachment(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1]
    return { kind: 'photo', fileId: best.file_id, size: best.file_size }
  }
  if (msg?.document) {
    const d = msg.document
    return { kind: 'document', fileId: d.file_id, size: d.file_size, mime: d.mime_type, name: d.file_name }
  }
  if (msg?.voice) {
    const v = msg.voice
    return { kind: 'voice', fileId: v.file_id, size: v.file_size, mime: v.mime_type }
  }
  if (msg?.audio) {
    const a = msg.audio
    return { kind: 'audio', fileId: a.file_id, size: a.file_size, mime: a.mime_type, name: a.file_name }
  }
  if (msg?.video) {
    const v = msg.video
    return { kind: 'video', fileId: v.file_id, size: v.file_size, mime: v.mime_type, name: v.file_name }
  }
  return null
}

export function buildAttachmentCaption(attachment) {
  if (!attachment) return ''
  switch (attachment.kind) {
    case 'photo':
      return '(photo)'
    case 'document':
      return `(document: ${attachment.name ?? 'file'})`
    case 'voice':
      return '(voice message)'
    case 'audio':
      return `(audio: ${attachment.name ?? 'audio'})`
    case 'video':
      return '(video)'
    default:
      return '(attachment)'
  }
}

export function exceedsAttachmentLimit(size) {
  return typeof size === 'number' && size > MAX_ATTACHMENT_BYTES
}

export function sanitizeIdForFilename(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
}

export function resolveAttachmentExtension(filePath, kind) {
  const fallback = kind === 'photo' ? 'jpg' : 'bin'
  if (!filePath || !filePath.includes('.')) return fallback
  const cleaned = filePath.split('.').pop().replace(/[^a-zA-Z0-9]/g, '')
  return cleaned || fallback
}

export function buildInboxFilename(timestampMs, fileUniqueId, filePath, kind) {
  const ext = resolveAttachmentExtension(filePath, kind)
  return `${timestampMs}-${sanitizeIdForFilename(fileUniqueId)}.${ext}`
}

const RM_SHORT_FLAG_CHARS = 'rfvid'
const rmFlagLookahead = (letter, long) =>
  `(?=[^\\n;]*?(?:\\s-[${RM_SHORT_FLAG_CHARS}]*${letter}[${RM_SHORT_FLAG_CHARS}]*\\b|\\s--${long}\\b))`
const RM_RF_RE = new RegExp(
  `\\brm\\b${rmFlagLookahead('r', 'recursive')}${rmFlagLookahead('f', 'force')}`,
  'i'
)

const RISKY_COMMAND_PATTERNS = [
  { name: 'rm -rf', re: RM_RF_RE },
  { name: 'git push --force', re: /\bgit\s+push\b[^\n]*\s(--force(-with-lease)?|-f)\b/i },
  { name: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git clean -f', re: /\bgit\s+clean\s+-\w*f\w*\b/i },
  { name: 'DROP TABLE/DATABASE', re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i },
  { name: 'DELETE FROM without WHERE', re: /\bDELETE\s+FROM\s+\S+\b(?![^\n;]*\bWHERE\b)/i },
  { name: 'mkfs', re: /\bmkfs(\.\w+)?\b/i },
  { name: 'dd to a device', re: /\bdd\s+[^\n]*\bof=\/dev\//i },
  { name: 'chmod -R 777', re: /\bchmod\s+-R\s+777\b/i },
  { name: 'fork bomb', re: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'pipe to shell', re: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i },
  { name: 'sudo rm', re: /\bsudo\s+rm\b/i },
]

export function matchRiskyCommand(text) {
  const t = String(text ?? '')
  for (const { name, re } of RISKY_COMMAND_PATTERNS) {
    if (re.test(t)) return name
  }
  return null
}

export function isConfirmation(text) {
  return String(text ?? '').trim().toUpperCase() === 'CONFIRM'
}

export function buildRiskyCommandWarning(matchName) {
  return (
    `⚠️ this message looks like it could trigger a risky command (${matchName}).\n\n` +
    'If you really want to proceed, reply with exactly: CONFIRM\n' +
    'Any other reply cancels it.'
  )
}

export function evaluateRiskyGuard(text, pending) {
  if (pending && isConfirmation(text)) {
    return { action: 'confirmed', text: pending.text }
  }
  const match = matchRiskyCommand(text)
  if (match) return { action: 'needsConfirmation', match, text }
  return { action: 'proceed', text }
}

export function resolveMessageMeta(decision, pendingEntry, fallbackMeta) {
  const meta = decision.action === 'confirmed' && pendingEntry ? pendingEntry : fallbackMeta
  return { messageId: meta.messageId, user: meta.user, ts: meta.ts }
}

const ATTACH_LINE_RE = /^ATTACH:\s*(.+?)\s*$/

export function extractAttachmentMarkers(text) {
  const lines = String(text ?? '').split('\n')
  const kept = []
  const paths = []
  for (const line of lines) {
    const m = line.match(ATTACH_LINE_RE)
    if (m) paths.push(m[1])
    else kept.push(line)
  }
  return { text: kept.join('\n').trimEnd(), paths }
}

const OUTBOUND_PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

export function pickOutboundSendMethod(filePath) {
  const name = String(filePath ?? '')
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return OUTBOUND_PHOTO_EXTS.has(ext) ? 'sendPhoto' : 'sendDocument'
}

export function assertSendablePath(filePath, protectedDir) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'empty attachment path' }
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, error: `attachment path must be absolute: ${filePath}` }
  }
  const resolved = path.resolve(filePath)
  const resolvedProtected = path.resolve(protectedDir)
  if (resolved === resolvedProtected || resolved.startsWith(resolvedProtected + path.sep)) {
    return { ok: false, error: `refusing to send a file from the bridge's own state directory: ${filePath}` }
  }
  return { ok: true }
}

export function buildOutboundAttachmentInstructions() {
  return [
    'You can attach files (images, documents, audio, video) to this reply.',
    'To do so, end your final answer with one line per file, in exactly this form:',
    'ATTACH: /absolute/path/to/file',
    "Only reference files that already exist on disk and use absolute paths. Never reference a path inside the bridge's own state/session directory.",
    'These marker lines are stripped from what the user sees on Telegram; each file is then sent to them as a photo (common image extensions) or a document (everything else).',
  ].join('\n')
}

export function buildReplyCallsFromChunks(chatId, chunks, replyToMessageId, parseMode, editMessageId) {
  return chunks.map((part, i) => {
    const params = { chat_id: chatId, text: part }
    if (parseMode) params.parse_mode = parseMode
    if (i === 0 && editMessageId != null) {
      return { method: 'editMessageText', params: { ...params, message_id: editMessageId } }
    }
    if (i === 0 && replyToMessageId != null) {
      params.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true }
    }
    return { method: 'sendMessage', params }
  })
}

const REACT_LINE_RE = /^REACT:\s*(.+?)\s*$/

export function extractReactionMarker(text) {
  const lines = String(text ?? '').split('\n')
  const kept = []
  let emoji = null
  for (const line of lines) {
    const m = line.match(REACT_LINE_RE)
    if (m) emoji = m[1]
    else kept.push(line)
  }
  return { text: kept.join('\n').trimEnd(), emoji }
}

export const RECEIPT_REACTION = '👀'
export const SUCCESS_REACTION = '✅'
export const ERROR_REACTION = '❌'

export function buildSetMessageReactionParams(chatId, messageId, emoji) {
  return {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  }
}

export function buildReactionMarkerInstructions() {
  return [
    "You can put an emoji reaction on the user's triggering Telegram message.",
    'To do so, include one line anywhere in your final answer, in exactly this form:',
    'REACT: <emoji>',
    'Use a single standard emoji (e.g. 👍, 🎉, 👀, ❌) that Telegram accepts as a message reaction.',
    "This marker line is stripped from what the user sees on Telegram. If omitted, the bridge sets a default ✅/❌ reaction based on whether the run succeeded or failed.",
  ].join('\n')
}

export function combineSystemPrompts(...parts) {
  return parts.filter(p => p != null && p !== '').join('\n\n')
}

export function createKeyedQueue() {
  const tails = new Map()

  function enqueue(key, task) {
    const prevTail = tails.get(key) ?? Promise.resolve()
    const result = prevTail.then(task)
    const tail = result.then(() => {}, () => {})
    tails.set(key, tail)
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }

  return { enqueue }
}
