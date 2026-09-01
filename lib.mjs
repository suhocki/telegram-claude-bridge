// Pure, testable helpers extracted out of bridge.mjs's imperative poll loop.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileSync, renameSync } from 'node:fs'
import { markdownToTelegramHtml, htmlToPlainFallback, escapeHtml } from './markdown-html.mjs'
import { truncateStatus } from './stream-progress.mjs'

// pid-suffixed so two processes writing the same path (e.g. auth-mode.json, shared across every bot) never share one tmp file.
export function atomicWriteFileSync(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}

// Gate on is_topic_message, not merely message_thread_id presence: Telegram also stamps the latter on plain reply-chains in non-forum groups.
export function threadKey(chatId, msg) {
  return msg?.is_topic_message && msg.message_thread_id != null ? `${chatId}:${msg.message_thread_id}` : String(chatId)
}

// Same gate as threadKey, but for the Telegram API parameter rather than the state-lookup key — never conflate the two.
export function resolveThreadId(msg) {
  return msg?.is_topic_message && msg.message_thread_id != null ? msg.message_thread_id : null
}

// Spreadable into a params object: {} when there's no thread id to attach, so call sites don't each repeat the same null check.
export function threadIdParam(threadId) {
  return threadId != null ? { message_thread_id: threadId } : {}
}

// Inverse of threadKey, for the few call sites (check-in re-arm/run) that only have the key on hand.
export function parseThreadKey(key) {
  const s = String(key)
  const idx = s.indexOf(':')
  if (idx === -1) return { chatId: s, threadId: null }
  return { chatId: s.slice(0, idx), threadId: Number(s.slice(idx + 1)) }
}

// Keeps only the tail once a growing buffer (stdout/stderr from a long-running subprocess) exceeds limit.
export function appendCapped(acc, piece, limit) {
  return (acc + piece).slice(-limit)
}

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

function mentionNamesBot(mentioned, botUsername) {
  return String(mentioned ?? '').toLowerCase() === String(botUsername ?? '').toLowerCase()
}

const COMMAND_WITH_OPTIONAL_MENTION_RE = /^(\/[a-zA-Z]+)(?:@([A-Za-z0-9_]+))?([\s\S]*)$/

function parseCommandMention(text, botUsername) {
  const m = text.match(COMMAND_WITH_OPTIONAL_MENTION_RE)
  if (!m) return null
  const [, command, mentioned, rest] = m
  if (mentioned && !mentionNamesBot(mentioned, botUsername)) return null
  return { command, rest }
}

export function classifyCommand(text, botUsername) {
  const parsed = parseCommandMention(String(text ?? '').trim(), botUsername)
  if (!parsed || parsed.rest !== '') return null
  if (parsed.command === '/new' || parsed.command === '/reset') return 'reset'
  if (parsed.command === '/compact') return 'compact'
  if (parsed.command === '/status') return 'status'
  if (parsed.command === '/subscription') return 'authSubscription'
  if (parsed.command === '/apikey') return 'authApiKey'
  if (parsed.command === '/config') return 'config'
  return null
}

// unset/unrecognized state defaults to the pre-existing "pass the env through" behavior
export function normalizeAuthMode(raw) {
  return raw === 'subscription' ? 'subscription' : 'apikey'
}

// One-time migration input: any chat anywhere having run /subscription before means the operator wants it, so it wins over apikey.
export function deriveLegacyAuthMode(authModeValues) {
  return authModeValues.includes('subscription') ? 'subscription' : 'apikey'
}

function authModeLabel(authMode) {
  return normalizeAuthMode(authMode) === 'subscription' ? 'subscription (OAuth)' : 'API key'
}

export function buildChildEnv(baseEnv, authMode) {
  if (normalizeAuthMode(authMode) !== 'subscription') return baseEnv
  const next = { ...baseEnv }
  delete next.ANTHROPIC_API_KEY
  return next
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

export function formatStatusText(session, authMode) {
  const base = session
    ? `session: ${session.id}\ncost so far: $${(session.costUsd ?? 0).toFixed(4)}`
    : 'ℹ️ no active session yet — send a message to start one.'
  return `${base}\nauth mode: ${authModeLabel(authMode)}`
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

export function extractReplyToMessageId(msg) {
  return msg?.reply_to_message?.message_id ?? null
}

// the run-starting message's own reply wins over the last joined fragment's, so a deliberate reply isn't lost behind a later non-reply fragment
export function resolveJoinedReplyToMessage(runReplyToMessage, lastFragmentReplyToMessage) {
  return runReplyToMessage ?? lastFragmentReplyToMessage ?? null
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

const KNOWN_SERVICE_MESSAGE_FIELDS = [
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'pinned_message',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'giveaway_created',
  'giveaway_completed',
  'boost_added',
  'users_shared',
  'chat_shared',
  'write_access_allowed',
  'proximity_alert_triggered',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
]

const BOOLEAN_SERVICE_MESSAGE_FIELDS = new Set(['group_chat_created', 'supergroup_chat_created', 'channel_chat_created', 'delete_chat_photo'])

export function isServiceMessage(msg) {
  return KNOWN_SERVICE_MESSAGE_FIELDS.some(field =>
    BOOLEAN_SERVICE_MESSAGE_FIELDS.has(field) ? msg?.[field] === true : msg?.[field] !== undefined
  )
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
  return { messageId: meta.messageId, user: meta.user, ts: meta.ts, replyToMessageId: meta.replyToMessageId ?? null }
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

export const MEDIA_GROUP_MAX_ITEMS = 10

export function partitionAttachmentPaths(filePaths) {
  const photoPaths = []
  const otherPaths = []
  for (const filePath of filePaths) {
    if (pickOutboundSendMethod(filePath) === 'sendPhoto') photoPaths.push(filePath)
    else otherPaths.push(filePath)
  }
  return { photoPaths, otherPaths }
}

export function chunkPaths(paths, size = MEDIA_GROUP_MAX_ITEMS) {
  const chunks = []
  for (let i = 0; i < paths.length; i += size) {
    chunks.push(paths.slice(i, i + size))
  }
  return chunks
}

// Pure description of a sendMediaGroup request body: which local file goes in which
// multipart field, and the `media` array (referencing fields via `attach://<field>`)
// Telegram expects as JSON. Keeping this separate from the actual fetch/FormData IO
// (in bridge.mjs) makes the field-naming/JSON-shape logic testable without a network.
export function buildMediaGroupPayload(filePaths) {
  const fields = filePaths.map((filePath, i) => ({ field: `file${i}`, filePath }))
  const media = fields.map(({ field }) => ({ type: 'photo', media: `attach://${field}` }))
  return { fields, media }
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
    'These marker lines are stripped from what the user sees on Telegram; each file is then sent to them as a photo (common image extensions) or a document (everything else). Two or more photos are sent together as a single Telegram album (one message, swipeable) instead of one message per photo — nothing extra to do for that, just list multiple ATTACH lines.',
  ].join('\n')
}

export function buildReplyCallsFromChunks(chatId, chunks, replyToMessageId, parseMode, editMessageId, threadId, keyboard) {
  return chunks.map((part, i) => {
    const params = { chat_id: chatId, text: part }
    if (parseMode) params.parse_mode = parseMode
    if (i === chunks.length - 1 && keyboard) params.reply_markup = keyboard
    if (i === 0 && editMessageId != null) {
      // editMessageText targets a message that already carries its own thread membership — no message_thread_id needed
      return { method: 'editMessageText', params: { ...params, message_id: editMessageId } }
    }
    Object.assign(params, threadIdParam(threadId))
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

// Telegram's setMessageReaction only accepts a fixed emoji whitelist — not
// the full list, just enough to document why ✅/❌ (tried first, both live
// REACTION_INVALID) aren't valid choices for success/error below.
export const ALLOWED_REACTION_EMOJI = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉',
  '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '🌚', '🌭',
  '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
])

export const RECEIPT_REACTION = '👀'
export const ERROR_REACTION = '😢'
export const AUTH_SWITCH_REACTION = '👍'

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
    "This marker line is stripped from what the user sees on Telegram. If omitted, the bridge clears its receipt reaction on success, or sets 😢 on error.",
  ].join('\n')
}

export const CHECKIN_MIN_MINUTES = 1
export const CHECKIN_MAX_MINUTES = 120
export const CHECKIN_MAX_CHAINED_HOPS = 20

export function checkinChainExceeded(hopCount) {
  return hopCount > CHECKIN_MAX_CHAINED_HOPS
}

// Folds a new check-in request into whatever's already pending for the same thread instead of clobbering it: the earlier dueAt wins, instructions concatenate, and hopCount takes the deeper of the two chains (a fresh marker's default hopCount must never reset an already-escalated chain back down).
export function mergePendingCheckin(existing, { sessionId, checkin, hopCount, now }) {
  const dueAt = now + checkin.minutes * 60_000
  return {
    dueAt: existing ? Math.min(existing.dueAt, dueAt) : dueAt,
    instruction: existing ? `${existing.instruction}\n\n${checkin.instruction}` : checkin.instruction,
    sessionId,
    hopCount: existing ? Math.max(existing.hopCount ?? 0, hopCount) : hopCount,
  }
}

const CHECKIN_LINE_RE = /^CHECKIN:\s*(\d+)\s+(.+?)\s*$/

export function extractCheckinMarker(text) {
  const lines = String(text ?? '').split('\n')
  const kept = []
  let checkin = null
  for (const line of lines) {
    const m = line.match(CHECKIN_LINE_RE)
    if (m) {
      const minutes = Number(m[1])
      if (minutes >= CHECKIN_MIN_MINUTES && minutes <= CHECKIN_MAX_MINUTES) {
        checkin = { minutes, instruction: m[2] }
      }
    } else {
      kept.push(line)
    }
  }
  return { text: kept.join('\n').trimEnd(), checkin }
}

export function buildCheckinMarkerInstructions() {
  return [
    'The process running this turn exits as soon as your reply is sent — a background Agent or task you started does NOT keep running on its own after that, even with run_in_background.',
    'If you started real background work this turn that will still be going after your reply, and you want a follow-up, include one line anywhere in your final answer, in exactly this form:',
    `CHECKIN: <minutes> <what to check on and report back>`,
    `<minutes> must be a whole number between ${CHECKIN_MIN_MINUTES} and ${CHECKIN_MAX_MINUTES}.`,
    'This marker line is stripped from what the user sees. After the delay, the bridge starts a fresh turn (resuming this same session) using your instruction as the prompt — use that turn to check on/nudge the background work and report progress to the user. Include another CHECKIN: line in that follow-up if more waiting is still needed; omit it once the work is done.',
    `A safety cap limits any chain to ${CHECKIN_MAX_CHAINED_HOPS} automated check-ins in a row; past that the bridge stops rescheduling and tells the user to check manually, so don't count on unlimited retries.`,
    "Don't use this for anything that finishes within your own current turn.",
  ].join('\n')
}

// notifyThreadKey is baked in per-call, not left for the model to derive — it's never told the threadKey/parseThreadKey format.
export function buildJobMarkerInstructions(jobsDir, notifyThreadKey) {
  return [
    'The process running this turn exits as soon as your reply is sent. Nothing you start survives that on its own — not run_in_background, not a detached/nohup\'d process — and even something you got to survive the turn can still be killed later by a turn timeout, a manual cancel, or a bridge restart.',
    'For any task that must keep running after this turn ends (more than a couple of minutes, or anything that should survive a restart), do NOT use run_in_background and do NOT try to detach a process yourself. Instead write a job spec file and end your turn — a separate, immortal bridge process starts, owns, and monitors the job for you, and reports back automatically.',
    `To do so, write a JSON file to exactly this path: ${jobsDir}/<jobId>.json — pick <jobId> yourself, letters/digits/"_"/"-" only, e.g. a short slug or a timestamp.`,
    'The file must contain a JSON object like this:',
    '{',
    '  "command": "sleep 30 && date > /tmp/marker.txt",',
    '  "description": "short human-readable summary of what this job does",',
    `  "notifyThreadKey": "${notifyThreadKey}",`,
    '  "cwd": "/optional/absolute/working/directory",',
    '  "etaMinutes": 5,',
    '  "timeoutMinutes": 60,',
    '  "onDoneCheckin": { "minutes": 0, "instruction": "optional extra instruction for the follow-up turn once this job finishes" }',
    '}',
    `Only "command", "description", and "notifyThreadKey" are required — always use exactly "${notifyThreadKey}" for "notifyThreadKey", copied verbatim, never invented or derived. "cwd" defaults to this session's own working directory when omitted. "timeoutMinutes" defaults to 60 and, on expiry, the bridge kills the job and reports it as timed out.`,
    'The bridge runs "command" through a shell, redirects its output to a log file next to the spec, and posts (then keeps live-editing) a status message in this chat until the job finishes.',
    'Do not background or detach anything inside "command" itself (no trailing &, no nohup, no disown) — the bridge already runs the whole command detached; backgrounding inside it too just makes the bridge think the job is done the moment the wrapper shell returns, while the real work keeps going unwatched.',
    'If you set "onDoneCheckin", the bridge automatically resumes this same session once the job finishes (immediately by default, or after "minutes" if given) with an instruction to read the job\'s log and report the result — you do not need your own CHECKIN: marker for that.',
    'Reply to the user now saying the job has started; do not wait for it to finish.',
  ].join('\n')
}

export function buildCheckinFollowupPrompt(instruction) {
  return `[AUTOMATED CHECK-IN — not a message from the user, scheduled by your own earlier CHECKIN: marker] ${instruction}`
}

export function buildContinuePrompt() {
  return '[CONTINUE — not a new message from the user. Your previous turn in this chat was interrupted by a user-requested cancel before it finished. Pick up where you left off and complete the original task; do not ask the user to repeat themselves.]'
}

const NO_REPLY_LINE_RE = /^NO_REPLY\s*$/

export function extractNoReplyMarker(text) {
  const lines = String(text ?? '').split('\n')
  const kept = []
  let noReply = false
  for (const line of lines) {
    if (NO_REPLY_LINE_RE.test(line)) noReply = true
    else kept.push(line)
  }
  return { text: kept.join('\n').trimEnd(), noReply }
}

export function buildNoReplyMarkerInstructions() {
  return [
    "If you handled this turn entirely through some other visible side effect (e.g. you edited a different message to show the outcome) and there is nothing left to tell the user, you can suppress this turn's confirmation reply.",
    'To do so, include one line anywhere in your final answer, in exactly this form:',
    'NO_REPLY',
    'This marker line is stripped. If nothing else is left in your answer, no message is sent for this turn at all (not even a placeholder) — only the receipt reaction is cleared. If any other text remains, it is still sent normally regardless of this marker. Only use this when the user already has clear confirmation another way; never use it to silently skip answering an actual question.',
  ].join('\n')
}

export function extractResponseMarkers(text) {
  const { text: withoutAttach, paths: attachPaths } = extractAttachmentMarkers(text)
  const { text: withoutReact, emoji: reactionEmoji } = extractReactionMarker(withoutAttach)
  const { text: withoutCheckin, checkin } = extractCheckinMarker(withoutReact)
  const { text: cleanedText, noReply } = extractNoReplyMarker(withoutCheckin)
  return { text: cleanedText, attachPaths, reactionEmoji, checkin, noReply }
}

export function combineSystemPrompts(...parts) {
  return parts.filter(p => p != null && p !== '').join('\n\n')
}

export function expandHome(filePath, homeDir) {
  if (typeof filePath !== 'string') return filePath
  if (filePath === '~') return homeDir
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2))
  return filePath
}

export const DEFAULT_WHISPER_BIN = 'whisper-cli'
export const DEFAULT_WHISPER_MODEL_PATH = '~/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin'
export const DEFAULT_WHISPER_LANGUAGE = 'auto'

export function buildFfmpegConvertArgs(inputPath, outputWavPath) {
  return ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputWavPath]
}

export function buildWhisperArgs(wavPath, modelPath, language, outputPrefix) {
  return ['-m', modelPath, '-f', wavPath, '-l', language || DEFAULT_WHISPER_LANGUAGE, '-otxt', '-of', outputPrefix, '-nt']
}

export function parseWhisperTranscript(raw) {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim()
}

export function buildVoiceTranscriptText(transcript) {
  const trimmed = String(transcript ?? '').trim()
  return trimmed ? `(voice message transcript)\n${trimmed}` : '(voice message transcript unavailable)'
}

export const TRANSCRIPT_QUOTE_MAX_CHARS = 3000

const DANGLING_ENTITY_BEFORE_ELLIPSIS_RE = /&[a-zA-Z0-9#]*(…)$/

export function buildTranscriptQuoteHtml(transcript) {
  const trimmed = String(transcript ?? '').trim()
  if (!trimmed) return null
  const escaped = escapeHtml(trimmed)
  const truncated = truncateStatus(escaped, TRANSCRIPT_QUOTE_MAX_CHARS)
  // a raw-character cut can land inside an entity escapeHtml introduced (e.g. "&amp" missing its ";") — drop it.
  const safe = truncated === escaped ? truncated : truncated.replace(DANGLING_ENTITY_BEFORE_ELLIPSIS_RE, '$1')
  return `<blockquote>${safe}</blockquote>`
}

export function buildCancelKeyboard(chatId, joinCount = 0) {
  const buttons = [{ text: '🚫 Cancel', callback_data: `cancel:${chatId}` }]
  if (joinCount > 0) buttons.push({ text: `⬇️ Join (${joinCount})`, callback_data: `join:${chatId}` })
  return { inline_keyboard: [buttons] }
}

export function buildJoinedPromptText(texts) {
  return texts.filter(t => t != null && t !== '').join('\n')
}

// non-voice attachments are still excluded — folding them in would silently drop the attachment
export function isJoinableMessage(msg, botUsername) {
  if (isServiceMessage(msg)) return false
  const attachment = extractAttachment(msg)
  if (attachment && attachment.kind !== 'voice') return false
  const text = attachment ? msg?.caption : msg?.text
  const hasText = typeof text === 'string' && text.trim()
  if (!attachment && !hasText) return false
  if (hasText) {
    if (classifyCommand(text, botUsername) !== null) return false
    if (parseVoiceToggleCommand(text, botUsername) !== null) return false
  }
  return true
}

export function resolveJoinFragmentText(msg, transcriptionOutcome) {
  const attachment = extractAttachment(msg)
  if (attachment?.kind !== 'voice') return msg?.text ?? msg?.caption ?? ''
  if (transcriptionOutcome && !transcriptionOutcome.error) return buildVoiceTranscriptText(transcriptionOutcome.text)
  return msg?.caption || buildAttachmentCaption(attachment)
}

export function buildContinueKeyboard(chatId) {
  return { inline_keyboard: [[{ text: '▶️ Continue', callback_data: `continue:${chatId}` }]] }
}

export function buildListenKeyboard(chatId) {
  return { inline_keyboard: [[{ text: '🎵 Прослушать', callback_data: `listen:${chatId}` }]] }
}

const CALLBACK_DATA_RE = /^(cancel|continue|join|listen):(.+)$/

export function parseCallbackData(data) {
  const m = String(data ?? '').match(CALLBACK_DATA_RE)
  return m ? { action: m[1], chatId: m[2] } : null
}

// claude CLI aliases (see `claude --help`); kept short since they double as button labels
export const CONFIG_MODELS = ['fable', 'sonnet', 'opus']
export const CONFIG_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const CONFIG_MODEL_LABELS = { fable: 'Fable', sonnet: 'Sonnet', opus: 'Opus' }

// per chat key, not global like auth-mode: a per-project quality/cost choice, not a machine-wide credential switch.
export function getModelConfig(modelConfigState, key) {
  return modelConfigState?.[key] ?? {}
}

// tapping the already-selected button again clears just that field, back to CLI default
export function setModelConfigField(modelConfigState, key, field, value) {
  const current = modelConfigState?.[key] ?? {}
  const nextEntry = { ...current }
  if (current[field] === value) delete nextEntry[field]
  else nextEntry[field] = value
  const next = { ...modelConfigState }
  if (Object.keys(nextEntry).length) next[key] = nextEntry
  else delete next[key]
  return next
}

export function resetModelConfig(modelConfigState, key) {
  const next = { ...modelConfigState }
  delete next[key]
  return next
}

export function isValidModelConfigValue(field, value) {
  if (field === 'reset') return true
  if (field === 'model') return CONFIG_MODELS.includes(value)
  if (field === 'effort') return CONFIG_EFFORTS.includes(value)
  return false
}

export function buildModelConfigArgs(entry) {
  const args = []
  if (entry?.model) args.push('--model', entry.model)
  if (entry?.effort) args.push('--effort', entry.effort)
  return args
}

function modelAndEffortLabels(entry) {
  const model = entry?.model ? CONFIG_MODEL_LABELS[entry.model] ?? entry.model : 'default'
  const effort = entry?.effort ?? 'default'
  return { model, effort }
}

export function buildConfigText(entry) {
  const { model, effort } = modelAndEffortLabels(entry)
  return `⚙️ model: ${model}\nreasoning effort: ${effort}\n\ntap to change, tap the same choice again to clear it, or reset both to default.`
}

export function buildConfigPinText(session, authMode, entry) {
  const { model, effort } = modelAndEffortLabels(entry)
  const cost = (Number.isFinite(session?.costUsd) ? session.costUsd : 0).toFixed(4)
  return `📌 config\nmodel: ${model}\nreasoning effort: ${effort}\nconnection: ${authModeLabel(authMode)}\nsession cost: $${cost}`
}

// Deliberately narrow to unambiguous "this thread is permanently unreachable" signals — "message can't be edited" also covers ambiguous, non-deletion causes (e.g. a lost permission), so it's left to the 'retry' default rather than risk unpinning a message that's still perfectly fine.
const CONFIG_PIN_GONE_RE = /message to (edit|pin) not found|chat not found|bot was (blocked|kicked)|bot is not a member/i

export function classifyConfigPinSyncError(message) {
  const text = String(message ?? '')
  if (/message is not modified/i.test(text)) return 'unmodified'
  if (CONFIG_PIN_GONE_RE.test(text)) return 'gone'
  return 'retry'
}

export function buildConfigKeyboard(chatId, entry) {
  const modelRow = CONFIG_MODELS.map(m => ({
    text: entry?.model === m ? `✅ ${CONFIG_MODEL_LABELS[m]}` : CONFIG_MODEL_LABELS[m],
    callback_data: `cfg:model:${m}:${chatId}`,
  }))
  const effortRow = CONFIG_EFFORTS.map(e => ({
    text: entry?.effort === e ? `✅ ${e}` : e,
    callback_data: `cfg:effort:${e}:${chatId}`,
  }))
  return {
    inline_keyboard: [modelRow, effortRow, [{ text: '↩️ Reset to default', callback_data: `cfg:reset:x:${chatId}` }]],
  }
}

export function buildConfigMessageParams(chatId, entry, threadId) {
  return {
    chat_id: chatId,
    text: buildConfigText(entry),
    reply_markup: buildConfigKeyboard(chatId, entry),
    ...threadIdParam(threadId),
  }
}

export function buildConfigEditParams(chatId, messageId, entry) {
  return {
    chat_id: chatId,
    message_id: messageId,
    text: buildConfigText(entry),
    reply_markup: buildConfigKeyboard(chatId, entry),
  }
}

// value is captured but deliberately ignored by the caller for 'reset' — kept in the payload only for a consistent cfg:<field>:<value>:<chatId> shape
const CONFIG_CALLBACK_RE = /^cfg:(model|effort|reset):([a-z]+):(.+)$/

export function parseConfigCallbackData(data) {
  const m = String(data ?? '').match(CONFIG_CALLBACK_RE)
  return m ? { field: m[1], value: m[2], chatId: m[3] } : null
}

// editMessageText drops any existing inline keyboard unless reply_markup is passed again on
// every edit, so the caller must thread `keyboard` through each streaming update or the Cancel
// button vanishes the moment the placeholder's first edit lands.
export function buildPlaceholderEditParams(chatId, messageId, status, isHtml = false, keyboard = null) {
  const base = isHtml
    ? { chat_id: chatId, message_id: messageId, text: status, parse_mode: 'HTML' }
    : { chat_id: chatId, message_id: messageId, text: status }
  return keyboard ? { ...base, reply_markup: keyboard } : base
}

export function buildWorkingPlaceholderParams(chatId, text, replyToMessageId, keyboard, threadId) {
  const base = { chat_id: chatId, text, reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true }, ...threadIdParam(threadId) }
  return keyboard ? { ...base, reply_markup: keyboard } : base
}

const VOICE_TOGGLE_ARG_RE = /^\s+(on|off)$/i

export function parseVoiceToggleCommand(text, botUsername) {
  const parsed = parseCommandMention(String(text ?? '').trim(), botUsername)
  if (!parsed || parsed.command.toLowerCase() !== '/voice') return null
  const m = parsed.rest.match(VOICE_TOGGLE_ARG_RE)
  return m ? m[1].toLowerCase() : null
}

export function setVoiceReplyPreference(voiceReplyState, chatId, enabled) {
  const next = { ...voiceReplyState }
  if (enabled) next[chatId] = true
  else delete next[chatId]
  return next
}

export function isVoiceReplyEnabled(voiceReplyState, chatId) {
  return Boolean(voiceReplyState?.[chatId])
}

export function buildVoiceToggleReply(enabled) {
  return enabled
    ? '🔊 voice replies are now ON — replies will also be sent as a voice note.'
    : '🔇 voice replies are now OFF — replies will be text only.'
}

export function buildSpeechText(text) {
  return htmlToPlainFallback(markdownToTelegramHtml(text ?? '')).trim()
}

export function truncateForSpeech(text, maxChars) {
  const t = String(text ?? '')
  if (!maxChars || t.length <= maxChars) return t
  return `${t.slice(0, maxChars - 1).trimEnd()}…`
}

export const DEFAULT_TTS_VOICE_ID = 'txnCCHHGKmYIwrn7HfHQ'
export const DEFAULT_TTS_MODEL_ID = 'eleven_multilingual_v2'
export const DEFAULT_TTS_VOICE_SETTINGS = {
  stability: 0.3,
  similarity_boost: 0.75,
  style: 0.45,
  use_speaker_boost: true,
}

export const DEFAULT_FISH_TTS_VOICE_ID = '0a690dbeb3984a9f88cd39353880775f'
export const DEFAULT_FISH_TTS_MODEL_ID = 's2.1-pro-free'

export function buildTtsRequestOptions(text, { voiceId, apiKey, modelId, voiceSettings } = {}) {
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    headers: {
      'content-type': 'application/json',
      accept: 'audio/mpeg',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: modelId ?? DEFAULT_TTS_MODEL_ID,
      voice_settings: voiceSettings ?? DEFAULT_TTS_VOICE_SETTINGS,
    }),
  }
}

export function buildFishTtsRequestOptions(text, { voiceId, apiKey, modelId } = {}) {
  return {
    url: 'https://api.fish.audio/v1/tts',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      model: modelId ?? DEFAULT_FISH_TTS_MODEL_ID,
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId ?? DEFAULT_FISH_TTS_VOICE_ID,
      format: 'mp3',
      mp3_bitrate: 128,
    }),
  }
}

export function normalizeTtsProvider(raw) {
  return raw === 'elevenlabs' ? 'elevenlabs' : 'fish'
}

const VOICE_REPLY_PROVIDER_DEFAULTS = {
  fish: {
    apiKeyPath: '~/.config/tts/fish.key',
    voiceId: DEFAULT_FISH_TTS_VOICE_ID,
    modelId: DEFAULT_FISH_TTS_MODEL_ID,
  },
  elevenlabs: {
    apiKeyPath: '~/.config/tts/elevenlabs.key',
    voiceId: DEFAULT_TTS_VOICE_ID,
    modelId: DEFAULT_TTS_MODEL_ID,
  },
}

// provider drives its own apiKeyPath/voiceId/modelId defaults so switching provider alone (without hand-copying the other three fields) can't leave a stale cross-provider id/key pairing.
export function resolveVoiceReplyConfig(overrides = {}) {
  const provider = normalizeTtsProvider(overrides.provider)
  return {
    maxTtsChars: 4000,
    ...VOICE_REPLY_PROVIDER_DEFAULTS[provider],
    ...overrides,
    provider,
  }
}

export function buildOutboxFilename(timestampMs, chatId) {
  return `${timestampMs}-${sanitizeIdForFilename(chatId)}.mp3`
}

export function isGroupChatType(chatType) {
  return chatType === 'group' || chatType === 'supergroup'
}

export function resolveGroupPolicy(groupsConfig, chatId) {
  return groupsConfig?.[String(chatId)] ?? null
}

export function isSenderAllowedInGroup(policy, userId) {
  if (!Array.isArray(policy?.allowFrom) || policy.allowFrom.length === 0) return true
  return policy.allowFrom.includes(String(userId))
}

export function isBotMentioned(msg, botUsername, botId) {
  const text = msg?.text ?? msg?.caption ?? ''
  const entities = msg?.entities ?? msg?.caption_entities ?? []
  if (!Array.isArray(entities)) return false
  for (const e of entities) {
    if (e.type === 'mention' && mentionNamesBot(text.slice(e.offset + 1, e.offset + e.length), botUsername)) {
      return true
    }
    if (e.type === 'text_mention' && e.user?.id != null && botId != null && String(e.user.id) === String(botId)) {
      return true
    }
    if (e.type === 'bot_command') {
      const command = text.slice(e.offset, e.offset + e.length)
      const at = command.indexOf('@')
      if (at !== -1 && mentionNamesBot(command.slice(at + 1), botUsername)) return true
    }
  }
  return false
}

export function isReplyToBot(msg, botId) {
  const replyFromId = msg?.reply_to_message?.from?.id
  return replyFromId != null && botId != null && String(replyFromId) === String(botId)
}

export function isMentioned(msg, botUsername, botId) {
  return isBotMentioned(msg, botUsername, botId) || isReplyToBot(msg, botId)
}

export function shouldHandleGroupMessage(msg, policy, botUsername, botId) {
  if (!policy) return false
  if (!isSenderAllowedInGroup(policy, msg?.from?.id)) return false
  if (policy.requireMention && !isMentioned(msg, botUsername, botId)) return false
  return true
}

// Same authorization rule as shouldHandleGroupMessage, minus the mention requirement —
// a button click isn't a message that can @-mention the bot.
export function isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig) {
  const chatId = String(cq?.message?.chat?.id ?? '')
  const userId = String(cq?.from?.id ?? '')
  if (isGroupChatType(cq?.message?.chat?.type)) {
    const policy = resolveGroupPolicy(groupsConfig, chatId)
    return Boolean(policy) && isSenderAllowedInGroup(policy, userId)
  }
  return allowedUserIds.includes(userId)
}

// A bot-config's optional buttonsModule field points at a project-owned .mjs implementing
// buildKeyboard(context)/handleCallback(callbackData, context) — resolved relative to the
// bot's own cwd (matching how other bot-relative paths in this repo are resolved), or used
// as-is when already absolute.
export function resolveButtonsModulePath(buttonsModule, cwd) {
  if (!buttonsModule) return null
  return path.isAbsolute(buttonsModule) ? buttonsModule : path.resolve(cwd, buttonsModule)
}

export function createButtonsModuleLoader(modulePath, importFn = specifier => import(pathToFileURL(specifier).href)) {
  if (!modulePath) return null
  let cached = null
  return function loadButtonsModule() {
    if (!cached) cached = importFn(modulePath)
    return cached
  }
}

export function buildButtonTapSyntheticMessage(cq, text) {
  return {
    message_id: cq?.message?.message_id,
    chat: cq?.message?.chat,
    from: cq?.from,
    date: cq?.message?.date ?? Math.floor(Date.now() / 1000),
    text,
    is_topic_message: cq?.message?.is_topic_message,
    message_thread_id: cq?.message?.message_thread_id,
  }
}

// Dispatches a callback_data the built-in cancel/join/continue parser didn't recognize to the
// bot's buttonsModule (if configured). All Telegram/queueing side effects are passed in so this
// stays testable without faking the network: tg answers the callback query, enqueueMessage is
// the seam a caller wires to chatQueue.enqueue(() => handleMessage(...)).
export async function handleUnrecognizedCallback(cq, { chatId, buttonsLoader, tg, isAuthorized, enqueueMessage, log } = {}) {
  if (!buttonsLoader) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})
    return { routed: 'noop' }
  }
  if (!isAuthorized) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized', show_alert: true }).catch(() => {})
    return { routed: 'unauthorized' }
  }
  let result
  let mod
  try {
    mod = await buttonsLoader()
    result = (await mod.handleCallback?.(cq.data, { chatId, cq })) ?? { handled: false }
  } catch (e) {
    log?.('buttons module handleCallback failed', e.message)
    result = { handled: false }
  }
  if (result.handled) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: result.answerText }).catch(() => {})
    // buildKeyboard is optional - older/simpler buttons modules only implement handleCallback
    let keyboard
    try {
      keyboard = await mod?.buildKeyboard?.({ chatId, cq })
    } catch (e) {
      log?.('buttons module buildKeyboard failed', e.message)
    }
    if (keyboard) {
      await tg('editMessageReplyMarkup', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: keyboard,
      }).catch(() => {})
    }
    return { routed: 'handled', answerText: result.answerText }
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'queued…' }).catch(() => {})
  enqueueMessage(buildButtonTapSyntheticMessage(cq, `Button tapped: ${cq.data}`))
  return { routed: 'fallback-message' }
}

export function buildBotIdentity(getMeResult) {
  return { id: String(getMeResult?.id ?? ''), username: getMeResult?.username ?? null }
}

// Passed explicitly on every getUpdates call: the token may carry an allowed_updates
// whitelist left over from an earlier bot setup, and edited_message missing from it would
// silently disable rewind-on-edit.
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query']

export function buildBotCommands() {
  return [
    { command: 'new', description: 'start a new conversation (clears the context)' },
    { command: 'status', description: 'show the session id and cost so far' },
    { command: 'compact', description: 'compact the conversation to free up context' },
    { command: 'subscription', description: 'run claude on the subscription (OAuth) login, everywhere' },
    { command: 'apikey', description: 'run claude on the ANTHROPIC_API_KEY, everywhere' },
    { command: 'config', description: 'choose the model and reasoning effort for this chat' },
  ]
}

// Telegram resolves the menu from the narrowest matching scope, so a list left on this token
// by an earlier bot (all_private_chats: /start, /help, /status) shadows the default one we set
// and no client-side cache flush brings ours back — the narrower list has to be deleted first.
export const TELEGRAM_COMMAND_SCOPES_TO_CLEAR = [
  { type: 'all_private_chats' },
  { type: 'all_group_chats' },
  { type: 'all_chat_administrators' },
]

export function buildBotMenuCalls() {
  return [
    ...TELEGRAM_COMMAND_SCOPES_TO_CLEAR.map(scope => ({ method: 'deleteMyCommands', params: { scope } })),
    { method: 'setMyCommands', params: { commands: buildBotCommands() } },
  ]
}

export const MAX_TRACKED_TURNS = 40

export function appendTurn(turns, chatId, turn, maxTurns = MAX_TRACKED_TURNS) {
  const list = [...(turns?.[String(chatId)] ?? []), turn]
  return { ...turns, [String(chatId)]: list.slice(-maxTurns) }
}

export function findTurnIndexByMessageId(turnList, messageId) {
  if (!Array.isArray(turnList)) return -1
  return turnList.findIndex(t => String(t?.userMessageId) === String(messageId))
}

export function findTurnIndexByBotMessageId(turnList, messageId) {
  if (!Array.isArray(turnList)) return -1
  return turnList.findIndex(t => (t?.botMessageIds ?? []).some(id => String(id) === String(messageId)))
}

export function collectBotMessageIdsFrom(turnList, fromIndex) {
  if (!Array.isArray(turnList)) return []
  const ids = []
  for (const turn of turnList.slice(Math.max(0, fromIndex))) {
    for (const id of turn?.botMessageIds ?? []) {
      if (id != null && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

export function claudeProjectDirName(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

export function buildSessionTranscriptPath(claudeConfigDir, cwd, sessionId) {
  return path.join(claudeConfigDir, 'projects', claudeProjectDirName(cwd), `${sessionId}.jsonl`)
}

function transcriptEntryText(entry) {
  const content = entry?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (block?.text ?? (typeof block?.content === 'string' ? block.content : ''))))
      .join('\n')
  }
  return ''
}

function isMainChainUserEntry(entry) {
  return entry?.type === 'user' && !entry?.isSidechain
}

export function findRewindCutIndex(lines, anchorMessageId) {
  const needle = `message_id="${anchorMessageId}"`
  for (let i = 0; i < lines.length; i++) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (isMainChainUserEntry(entry) && transcriptEntryText(entry).includes(needle)) return i
  }
  return -1
}

// A transcript trimmed down to nothing but bookkeeping entries (queue-operation, mode, …)
// can't be resumed as a conversation, so the caller drops the session instead of reusing it.
export function hasConversationEntry(lines) {
  return lines.some(line => {
    try {
      const entry = JSON.parse(line)
      return (entry?.type === 'user' || entry?.type === 'assistant') && !entry?.isSidechain
    } catch {
      return false
    }
  })
}

export function buildRewindUnavailableNotice() {
  return "✏️ can't rewind to that message — it isn't part of the current session's context anymore. Send it as a new message instead."
}

export function validateNotifyConfig(config) {
  if (!config || typeof config.botToken !== 'string' || !config.botToken.trim()) {
    return 'config is missing "botToken"'
  }
  if (config.apiBaseUrl != null && (typeof config.apiBaseUrl !== 'string' || !config.apiBaseUrl.trim())) {
    return '"apiBaseUrl" must be a non-empty string when given'
  }
  return null
}

// The absolute path bridge.mjs actually reads/writes as its state file, applying the same default it does.
export function resolveBotStateFile(configDir, stateFileValue) {
  return path.resolve(configDir, stateFileValue ?? 'state.json')
}

// The subdirectory name inbox/tmp/outbox/rewind-backups get namespaced under; a plain basename is fine since it's always joined back onto that bot's own stateDir.
export function resolveBotSlug(configDir, stateFileValue) {
  const resolved = resolveBotStateFile(configDir, stateFileValue)
  return path.basename(resolved, path.extname(resolved))
}

export const MAX_TIMEOUT_MS = 2 ** 31 - 1 // Node's setTimeout silently clamps anything past this to 1ms

// Fails fast on a copy-paste config mistake instead of looping forever in poll()'s retry loop or silently corrupting a shared state.json.
export function validateBridgeConfig(config, { stateFilePath, existingStateFilePaths = [] } = {}) {
  if (!config || typeof config.botToken !== 'string' || !config.botToken.trim()) {
    return 'config is missing "botToken"'
  }
  if (typeof config.cwd !== 'string' || !config.cwd.trim()) {
    return 'config is missing "cwd"'
  }
  if (config.stateFile != null && typeof config.stateFile !== 'string') {
    return '"stateFile" must be a string when given'
  }
  // allowedUserIds only gates DMs; a group-only bot is authorized via "groups" instead.
  const hasAllowedUserIds = Array.isArray(config.allowedUserIds) && config.allowedUserIds.length > 0
  const hasGroupsConfig = config.groups && typeof config.groups === 'object' && Object.keys(config.groups).length > 0
  if (!hasAllowedUserIds && !hasGroupsConfig) {
    return 'config has neither a non-empty "allowedUserIds" array nor any "groups" entries — nobody could ever be authorized'
  }
  // Full resolved path (case-insensitive, matching macOS's default filesystem), not just the basename-derived slug.
  if (stateFilePath != null && existingStateFilePaths.some(p => p.toLowerCase() === stateFilePath.toLowerCase())) {
    return `"stateFile" resolves to the same path (${stateFilePath}) as another config in this repo — each bot needs its own`
  }
  if (config.retentionDays != null && (typeof config.retentionDays !== 'number' || !(config.retentionDays > 0))) {
    return '"retentionDays" must be a positive number when given'
  }
  // 0 disables the timeout (runClaude/runSpawn's own convention); the upper bound guards against Node's silent setTimeout clamping.
  for (const field of ['claudeTurnTimeoutMs', 'claudeTurnAbsoluteTimeoutMs', 'subprocessTimeoutMs']) {
    const value = config[field]
    if (value != null && (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > MAX_TIMEOUT_MS)) {
      return `"${field}" must be a number between 0 and ${MAX_TIMEOUT_MS} when given`
    }
  }
  // If the backstop is shorter than the idle timeout it's meant to back up, it fires first and defeats the point of having an idle timeout at all.
  if (config.claudeTurnTimeoutMs > 0 && config.claudeTurnAbsoluteTimeoutMs > 0 && config.claudeTurnAbsoluteTimeoutMs < config.claudeTurnTimeoutMs) {
    return '"claudeTurnAbsoluteTimeoutMs" must be at least "claudeTurnTimeoutMs" when both are given'
  }
  if (config.maxConcurrentJobs != null && (typeof config.maxConcurrentJobs !== 'number' || !(config.maxConcurrentJobs > 0))) {
    return '"maxConcurrentJobs" must be a positive number when given'
  }
  if (config.jobDefaultTimeoutMinutes != null && (typeof config.jobDefaultTimeoutMinutes !== 'number' || !(config.jobDefaultTimeoutMinutes > 0))) {
    return '"jobDefaultTimeoutMinutes" must be a positive number when given'
  }
  if (config.jobSweepIntervalMs != null && (typeof config.jobSweepIntervalMs !== 'number' || !(config.jobSweepIntervalMs > 0) || config.jobSweepIntervalMs > MAX_TIMEOUT_MS)) {
    return `"jobSweepIntervalMs" must be a number between 0 (exclusive) and ${MAX_TIMEOUT_MS} when given`
  }
  if (
    config.jobNotifyThreadRecencyMs != null &&
    (typeof config.jobNotifyThreadRecencyMs !== 'number' || !(config.jobNotifyThreadRecencyMs > 0) || config.jobNotifyThreadRecencyMs > MAX_TIMEOUT_MS)
  ) {
    return `"jobNotifyThreadRecencyMs" must be a number between 0 (exclusive) and ${MAX_TIMEOUT_MS} when given`
  }
  if (config.apiBaseUrl != null && (typeof config.apiBaseUrl !== 'string' || !config.apiBaseUrl.trim())) {
    return '"apiBaseUrl" must be a non-empty string when given'
  }
  return null
}

export function resolveNotifyChatId(config, explicitChatId) {
  if (explicitChatId != null && String(explicitChatId).trim()) return String(explicitChatId).trim()
  if (config?.notifyChatId != null && String(config.notifyChatId).trim()) return String(config.notifyChatId).trim()
  const first = Array.isArray(config?.allowedUserIds) ? config.allowedUserIds[0] : null
  return first != null && String(first).trim() ? String(first).trim() : null
}

export function pickNotifyText(argText, stdinText) {
  const fromArg = String(argText ?? '').trim()
  if (fromArg) return fromArg
  return String(stdinText ?? '').trim()
}

export const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 15000

// A distinct class (not a plain Error) so callers can tell "our client gave up waiting"
// apart from "the request definitely failed" — the request may well have already
// reached Telegram and succeeded server-side, so retrying on a timeout specifically
// risks a duplicate send, unlike retrying on a connection-refused/DNS-style failure.
export class FetchTimeoutError extends Error {}

export function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new FetchTimeoutError(`fetch ${url} timed out after ${timeoutMs}ms`)),
    timeoutMs
  )
  return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export function createTelegramClient(apiBase, { fetchImpl = fetch } = {}) {
  return async function tg(method, params, { timeoutMs = DEFAULT_TELEGRAM_API_TIMEOUT_MS } = {}) {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      },
      timeoutMs
    )
    const data = await res.json()
    if (!data.ok) throw new Error(`${method} failed: ${data.description}`)
    return data.result
  }
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
