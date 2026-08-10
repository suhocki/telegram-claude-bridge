// Pure, testable helpers extracted out of bridge.mjs's imperative poll loop.

import path from 'node:path'
import { markdownToTelegramHtml, htmlToPlainFallback } from './markdown-html.mjs'

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

export function buildCheckinFollowupPrompt(instruction) {
  return `[AUTOMATED CHECK-IN — not a message from the user, scheduled by your own earlier CHECKIN: marker] ${instruction}`
}

export function extractResponseMarkers(text) {
  const { text: withoutAttach, paths: attachPaths } = extractAttachmentMarkers(text)
  const { text: withoutReact, emoji: reactionEmoji } = extractReactionMarker(withoutAttach)
  const { text: cleanedText, checkin } = extractCheckinMarker(withoutReact)
  return { text: cleanedText, attachPaths, reactionEmoji, checkin }
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

export function buildCancelKeyboard(chatId) {
  return { inline_keyboard: [[{ text: '🚫 Cancel', callback_data: `cancel:${chatId}` }]] }
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

export function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`fetch ${url} timed out after ${timeoutMs}ms`)), timeoutMs)
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
