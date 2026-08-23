#!/usr/bin/env node
// Standalone Telegram <-> Claude Code bridge. Does NOT use `claude --channels`
// (blocked by org policy on the enterprise account) — just polls the Telegram
// Bot API directly and shells out to `claude -p --resume <session>` per message.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  rmSync,
  readdirSync,
  renameSync,
  copyFileSync,
  realpathSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  sanitizeAttr,
  createKeyedQueue,
  classifyCommand,
  buildChannelPrompt,
  normalizeSession,
  accumulateSessionCost,
  crossedCostThreshold,
  buildCostWarning,
  formatStatusText,
  evaluateRiskyGuard,
  buildRiskyCommandWarning,
  resolveMessageMeta,
  extractAttachment,
  extractReplyToMessageId,
  resolveJoinedReplyToMessage,
  buildAttachmentCaption,
  isServiceMessage,
  exceedsAttachmentLimit,
  buildInboxFilename,
  MAX_ATTACHMENT_BYTES,
  pickOutboundSendMethod,
  partitionAttachmentPaths,
  chunkPaths,
  buildMediaGroupPayload,
  assertSendablePath,
  buildOutboundAttachmentInstructions,
  combineSystemPrompts,
  buildReplyCallsFromChunks,
  buildReactionMarkerInstructions,
  buildCheckinMarkerInstructions,
  buildNoReplyMarkerInstructions,
  buildCheckinFollowupPrompt,
  extractResponseMarkers,
  checkinChainExceeded,
  CHECKIN_MAX_CHAINED_HOPS,
  buildSetMessageReactionParams,
  RECEIPT_REACTION,
  ERROR_REACTION,
  AUTH_SWITCH_REACTION,
  buildChildEnv,
  expandHome,
  DEFAULT_WHISPER_BIN,
  DEFAULT_WHISPER_MODEL_PATH,
  DEFAULT_WHISPER_LANGUAGE,
  buildFfmpegConvertArgs,
  buildWhisperArgs,
  parseWhisperTranscript,
  buildVoiceTranscriptText,
  buildTranscriptQuoteHtml,
  buildCancelKeyboard,
  buildContinueKeyboard,
  parseCallbackData,
  buildContinuePrompt,
  buildJoinedPromptText,
  isJoinableMessage,
  resolveJoinFragmentText,
  buildPlaceholderEditParams,
  buildWorkingPlaceholderParams,
  parseVoiceToggleCommand,
  setVoiceReplyPreference,
  isVoiceReplyEnabled,
  buildVoiceToggleReply,
  buildSpeechText,
  truncateForSpeech,
  DEFAULT_TTS_VOICE_ID,
  DEFAULT_TTS_MODEL_ID,
  buildTtsRequestOptions,
  buildOutboxFilename,
  isGroupChatType,
  resolveGroupPolicy,
  isCallbackQueryAuthorized,
  resolveButtonsModulePath,
  createButtonsModuleLoader,
  handleUnrecognizedCallback,
  shouldHandleGroupMessage,
  buildBotIdentity,
  buildBotMenuCalls,
  TELEGRAM_ALLOWED_UPDATES,
  appendTurn,
  findTurnIndexByMessageId,
  collectBotMessageIdsFrom,
  buildSessionTranscriptPath,
  findRewindCutIndex,
  hasConversationEntry,
  buildRewindUnavailableNotice,
  createTelegramClient,
  fetchWithTimeout,
  FetchTimeoutError,
} from './lib.mjs'
import { markdownToTelegramHtmlChunks, htmlToPlainFallback, renderTranscriptHtml } from './markdown-html.mjs'
import {
  DEFAULT_WORKING_STATUS,
  createLineSplitter,
  parseJsonlLine,
  isResultEvent,
  extractSessionId,
  createProgressTracker,
  createStatusUpdater,
  createChatRateGate,
  extractNewSubagentBlocks,
  extractFinishedSubagentIds,
} from './stream-progress.mjs'
import { loadWorkingPhrases, pickWorkingPhrase, todayDateString } from './working-phrases.mjs'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node bridge.mjs <config.json>')
  process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const { botToken, cwd, allowedUserIds, appendSystemPrompt, claudeArgs, costWarnUsd, groups, buttonsModule } = config
const groupsConfig = groups ?? {}
const stateFile = path.resolve(path.dirname(configPath), config.stateFile ?? 'state.json')
const stateDir = path.dirname(stateFile)
const inboxDir = path.join(stateDir, 'inbox')
const tmpDir = path.join(stateDir, 'tmp')
const outboxDir = path.join(stateDir, 'outbox')
const rewindBackupDir = path.join(stateDir, 'rewind-backups')
// Resolved against the bridge module's own directory, not cwd/configPath, so every config shares one file.
const workingPhrasesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'working-phrases.json')
const API = `https://api.telegram.org/bot${botToken}`
const GET_UPDATES_POLL_TIMEOUT_S = 30
const GET_UPDATES_FETCH_TIMEOUT_MS = 50000
const FILE_TRANSFER_TIMEOUT_MS = 60000
// Uploading several full-size photos in one sendMediaGroup call can genuinely take
// longer than a single-file send (Telegram processes/previews every item in the
// album) — a per-file budget on top of the base timeout avoids a false-timeout
// mid-upload, which used to cause a duplicate send (see sendAttachmentGroup).
const MEDIA_GROUP_PER_FILE_TIMEOUT_MS = 15000
const TTS_REQUEST_TIMEOUT_MS = 30000
// Telegram rate-limits editMessageText to roughly 1/sec per chat; this stays safely under
// that while still feeling "live" for the growing-text placeholder preview.
const STREAM_EDIT_INTERVAL_MS = 1300

const voiceTranscriptionConfig = {
  whisperBin: DEFAULT_WHISPER_BIN,
  modelPath: DEFAULT_WHISPER_MODEL_PATH,
  language: DEFAULT_WHISPER_LANGUAGE,
  ...config.voiceTranscription,
}

const voiceReplyConfig = {
  apiKeyPath: '~/.config/tts/elevenlabs.key',
  voiceId: DEFAULT_TTS_VOICE_ID,
  modelId: DEFAULT_TTS_MODEL_ID,
  maxTtsChars: 4000,
  ...config.voiceReply,
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function emptyState() {
  return {
    offset: 0,
    sessions: {},
    pendingRisky: {},
    voiceReply: {},
    pendingCheckins: {},
    turns: {},
    workingPhraseQueue: null,
    authMode: {},
    pendingContinue: {},
  }
}

function loadState() {
  if (!existsSync(stateFile)) return emptyState()
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.pendingRisky ??= {}
    state.voiceReply ??= {}
    state.pendingCheckins ??= {}
    state.turns ??= {}
    state.workingPhraseQueue ??= null
    state.authMode ??= {}
    state.pendingContinue ??= {}
    return state
  } catch {
    return emptyState()
  }
}

function saveState(state) {
  const tmp = stateFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  writeFileSync(stateFile, readFileSync(tmp))
}

// Reads working-phrases.json fresh each call; never throws, since it runs before handleMessage's own try/catch.
function nextWorkingPhrase() {
  try {
    const { phrase, nextState } = pickWorkingPhrase(
      state.workingPhraseQueue,
      loadWorkingPhrases(workingPhrasesFile),
      todayDateString()
    )
    state.workingPhraseQueue = nextState
    saveState(state)
    return phrase
  } catch (e) {
    log('failed to rotate working phrase', e.message)
    return DEFAULT_WORKING_STATUS
  }
}

const state = loadState()
const chatQueue = createKeyedQueue()
// chatId -> single in-flight run { cancel(), promptText, placeholderId, pending, finished, setKeyboard() }; chatQueue guarantees only one at a time.
const activeRuns = new Map()
// chatId -> Set<messageId> already folded into a join tap, so runQueuedMessage below no-ops their own already-queued run.
const consumedByJoin = new Map()
// serializes the join-count editMessageReplyMarkup calls per chat so back-to-back joins can't land out of order at Telegram
const joinKeyboardQueue = createKeyedQueue()
// setTimeout handles can't be persisted, so state.pendingCheckins is re-armed into this Map on every boot.
const checkinTimers = new Map()
for (const chatId of Object.keys(state.pendingCheckins)) armCheckinTimer(chatId)

const tg = createTelegramClient(API)
const loadButtonsModule = createButtonsModuleLoader(resolveButtonsModulePath(buttonsModule, cwd))

// Returns the ids of the messages it created (empty for an edit of an existing one) so a
// caller can remember them and delete them later on a rewind.
async function sendReply(chatId, text, replyToMessageId, editMessageId) {
  const chunks = markdownToTelegramHtmlChunks(text || '(empty response)')
  const sentIds = []
  for (const { method, params } of buildReplyCallsFromChunks(chatId, chunks, replyToMessageId, 'HTML', editMessageId)) {
    let sent = null
    try {
      sent = await tg(method, params)
    } catch (e) {
      log(`${method} failed, retrying as plain text`, e.message)
      const { parse_mode, ...plainParams } = params
      sent = await tg(method, { ...plainParams, text: htmlToPlainFallback(params.text) })
    }
    if (method === 'sendMessage' && sent?.message_id != null) sentIds.push(sent.message_id)
  }
  return sentIds
}

// Used when there's no placeholder to freeze into a quote (it never got sent, or freezing it
// failed) — the transcript still has to reach the chat somehow.
async function sendTranscriptQuote(chatId, quoteHtml, replyToMessageId) {
  const params = {
    chat_id: chatId,
    text: quoteHtml,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
  }
  try {
    const sent = await tg('sendMessage', params)
    return sent.message_id
  } catch (e) {
    log('failed to send transcript quote as HTML, retrying as plain text', e.message)
    const { parse_mode, ...plainParams } = params
    try {
      const sent = await tg('sendMessage', { ...plainParams, text: htmlToPlainFallback(quoteHtml) })
      return sent.message_id
    } catch (e2) {
      log('plain-text retry also failed to send transcript quote', e2.message)
      return null
    }
  }
}

async function freezePlaceholderAsTranscript(chatId, placeholderId, quoteHtml, workingStatus, cancelKeyboard) {
  const freezeParams = buildPlaceholderEditParams(chatId, placeholderId, quoteHtml, true)
  try {
    await tg('editMessageText', freezeParams)
  } catch (e) {
    log('failed to freeze placeholder as transcript quote, retrying as plain text', e.message)
    const { parse_mode, ...plainParams } = freezeParams
    try {
      await tg('editMessageText', { ...plainParams, text: htmlToPlainFallback(quoteHtml) })
    } catch (e2) {
      log('plain-text retry also failed to freeze placeholder', e2.message)
      return { frozen: false, placeholderId }
    }
  }
  try {
    const progressPlaceholder = await tg('sendMessage', buildWorkingPlaceholderParams(chatId, workingStatus, placeholderId, cancelKeyboard))
    return { frozen: true, placeholderId: progressPlaceholder.message_id }
  } catch (e) {
    log('failed to send post-transcript working placeholder', e.message)
    return { frozen: true, placeholderId: null }
  }
}

async function setReaction(chatId, messageId, emoji) {
  try {
    await tg('setMessageReaction', buildSetMessageReactionParams(chatId, messageId, emoji))
  } catch (e) {
    log('setMessageReaction failed', emoji, e.message)
  }
}

async function sendAttachment(chatId, filePath, replyToMessageId) {
  const guard = assertSendablePath(filePath, stateDir)
  if (!guard.ok) {
    log('refusing to send attachment', filePath, guard.error)
    return sendReply(chatId, `⚠️ ${guard.error}`, replyToMessageId).catch(() => [])
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendReply(chatId, `⚠️ attachment not found: ${filePath}`, replyToMessageId).catch(() => [])
  }
  const method = pickOutboundSendMethod(filePath)
  const field = method === 'sendPhoto' ? 'photo' : 'document'
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append(field, new Blob([readFileSync(filePath)]), path.basename(filePath))
  if (replyToMessageId != null) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }))
  }
  try {
    const res = await fetchWithTimeout(fetch, `${API}/${method}`, { method: 'POST', body: form }, FILE_TRANSFER_TIMEOUT_MS)
    const data = await res.json()
    if (!data.ok) throw new Error(data.description)
    return data.result?.message_id != null ? [data.result.message_id] : []
  } catch (e) {
    log('sendAttachment failed', filePath, e.message)
    return sendReply(chatId, `⚠️ failed to send attachment ${path.basename(filePath)}: ${e.message}`, replyToMessageId).catch(() => [])
  }
}

// Telegram albums (sendMediaGroup) only accept 2-10 items and only photo/video mixed
// together — never mixed with documents — so this is only ever called with a
// pre-partitioned, pre-chunked list of 2-10 photo paths from sendAttachments below.
async function sendAttachmentGroup(chatId, filePaths, replyToMessageId) {
  const { fields, media } = buildMediaGroupPayload(filePaths)
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('media', JSON.stringify(media))
  for (const { field, filePath } of fields) {
    form.append(field, new Blob([readFileSync(filePath)]), path.basename(filePath))
  }
  if (replyToMessageId != null) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }))
  }
  const timeoutMs = Math.max(FILE_TRANSFER_TIMEOUT_MS, filePaths.length * MEDIA_GROUP_PER_FILE_TIMEOUT_MS)
  try {
    const res = await fetchWithTimeout(fetch, `${API}/sendMediaGroup`, { method: 'POST', body: form }, timeoutMs)
    const data = await res.json()
    if (!data.ok) throw new Error(data.description)
    return (data.result || []).map((m) => m.message_id).filter((id) => id != null)
  } catch (e) {
    if (e instanceof FetchTimeoutError) {
      // Our client gave up waiting, but Telegram may well have already received and
      // sent the album — retrying by resending every file individually risks (and,
      // before this fix, caused in practice) a duplicate album + separate messages.
      // Report the ambiguous outcome instead of guessing.
      log('sendAttachmentGroup timed out, not retrying individually', filePaths.join(', '), e.message)
      return sendReply(
        chatId,
        `⚠️ sending ${filePaths.length} photos as an album timed out after ${timeoutMs}ms — it may have gone through anyway, check the chat before resending.`,
        replyToMessageId
      ).catch(() => [])
    }
    log('sendAttachmentGroup failed, falling back to individual sends', filePaths.join(', '), e.message)
    const ids = []
    for (const filePath of filePaths) {
      ids.push(...(await sendAttachment(chatId, filePath, replyToMessageId)))
    }
    return ids
  }
}

// Entry point for a batch of ATTACH paths from one reply: 2+ photos go out as a single
// Telegram album instead of one message per photo, everything else (single photo,
// documents) goes through the existing one-file-per-message sendAttachment.
async function sendAttachments(chatId, filePaths, replyToMessageId) {
  const ids = []
  const validPaths = []
  for (const filePath of filePaths) {
    const guard = assertSendablePath(filePath, stateDir)
    if (!guard.ok) {
      log('refusing to send attachment', filePath, guard.error)
      ids.push(...(await sendReply(chatId, `⚠️ ${guard.error}`, replyToMessageId).catch(() => [])))
      continue
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      ids.push(...(await sendReply(chatId, `⚠️ attachment not found: ${filePath}`, replyToMessageId).catch(() => [])))
      continue
    }
    validPaths.push(filePath)
  }

  const { photoPaths, otherPaths } = partitionAttachmentPaths(validPaths)
  for (const chunk of chunkPaths(photoPaths)) {
    if (chunk.length >= 2) {
      ids.push(...(await sendAttachmentGroup(chatId, chunk, replyToMessageId)))
    } else if (chunk.length === 1) {
      ids.push(...(await sendAttachment(chatId, chunk[0], replyToMessageId)))
    }
  }
  for (const filePath of otherPaths) {
    ids.push(...(await sendAttachment(chatId, filePath, replyToMessageId)))
  }
  return ids
}

const CANCEL_SIGKILL_GRACE_MS = 3000

// Returns { promise, cancel } instead of a plain Promise so a caller can kill the run
// early (e.g. a Telegram "Cancel" button) without waiting for it to finish on its own.
function runClaude(prompt, sessionId, onEvent, authMode) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ]
  if (sessionId) args.push('--resume', sessionId)
  args.push(
    '--append-system-prompt',
    combineSystemPrompts(
      buildOutboundAttachmentInstructions(),
      buildReactionMarkerInstructions(),
      buildCheckinMarkerInstructions(),
      buildNoReplyMarkerInstructions(),
      appendSystemPrompt
    )
  )
  if (Array.isArray(claudeArgs)) args.push(...claudeArgs)

  // detached so `child.pid` is its own process-group leader: killing -child.pid kills
  // the whole tree (claude itself plus any Bash-spawned OS subprocesses), not just claude
  const child = spawn('claude', args, { cwd, env: buildChildEnv(process.env, authMode), detached: true })
  const pushChunk = createLineSplitter()
  let result = null
  let capturedSessionId = null
  let err = ''
  let stdoutTail = ''
  child.stdout.on('data', d => {
    const text = d.toString()
    stdoutTail = (stdoutTail + text).slice(-2000)
    for (const line of pushChunk(text)) {
      const event = parseJsonlLine(line)
      if (!event) continue
      // captured from the first event, not just `result`, so a hard kill still leaves a resumable id
      if (capturedSessionId == null) capturedSessionId = extractSessionId(event)
      if (isResultEvent(event)) result = event
      if (onEvent) {
        // onEvent may be async (it can send/delete subagent placeholder messages);
        // fire-and-forget it here, same as before, but catch both sync throws and
        // async rejections so a failure never crashes the stdout handler
        Promise.resolve()
          .then(() => onEvent(event))
          .catch(e => log('progress onEvent handler failed', e.message))
      }
    }
  })
  child.stderr.on('data', d => (err += d))

  let sigkillTimer = null
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => {
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (result) return resolve(result)
      reject(new Error(err || `claude exited ${code} with no result event\n${stdoutTail}`))
    })
  })

  function cancel() {
    if (child.exitCode != null || child.signalCode != null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (e) {
      log('cancel: SIGTERM failed', e.message)
    }
    sigkillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (e) {
          log('cancel: SIGKILL failed', e.message)
        }
      }
    }, CANCEL_SIGKILL_GRACE_MS)
  }

  return { promise, cancel, getSessionId: () => capturedSessionId }
}

const claudeConfigDir = expandHome(process.env.CLAUDE_CONFIG_DIR || '~/.claude', homedir())

// the OAuth login lives in ~/.claude.json, unaffected by a CLAUDE_CONFIG_DIR override
function hasOAuthLogin() {
  try {
    const data = JSON.parse(readFileSync(path.join(homedir(), '.claude.json'), 'utf8'))
    return Boolean(data?.oauthAccount)
  } catch (e) {
    log('hasOAuthLogin: could not read/parse ~/.claude.json', e.message)
    return false
  }
}

const AUTH_MODE_PREREQUISITES = {
  subscription: () =>
    hasOAuthLogin() ? null : '⚠️ no Claude subscription (OAuth) login found on this machine — run `claude login` first, then try again.',
  apikey: () => (process.env.ANTHROPIC_API_KEY ? null : '⚠️ ANTHROPIC_API_KEY is not set in this process — nothing to switch to.'),
}

// claude derives the project dir name from the *resolved* cwd (/tmp -> /private/tmp on macOS)
const resolvedCwd = (() => {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
})()

function resolveTranscriptPath(sessionId) {
  for (const dir of [resolvedCwd, cwd]) {
    const candidate = buildSessionTranscriptPath(claudeConfigDir, dir, sessionId)
    if (existsSync(candidate)) return candidate
  }
  try {
    for (const projectDir of readdirSync(path.join(claudeConfigDir, 'projects'))) {
      const candidate = path.join(claudeConfigDir, 'projects', projectDir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch (e) {
    log('failed to scan claude project dirs', e.message)
  }
  return null
}

// Claude Code resumes a session from the last entry of its transcript, so dropping every
// line from a given turn onwards is what makes `--resume` come back with the context as it
// was *before* that turn — i.e. the CLI's own rewind, done from the outside.
function rewindTranscript(sessionId, anchorMessageId) {
  const file = resolveTranscriptPath(sessionId)
  if (!file) return { ok: false, error: `no transcript file for session ${sessionId}` }
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
  const cutIndex = findRewindCutIndex(lines, anchorMessageId)
  if (cutIndex < 0) return { ok: false, error: `message ${anchorMessageId} not found in ${path.basename(file)}` }
  const kept = lines.slice(0, cutIndex)
  try {
    mkdirSync(rewindBackupDir, { recursive: true })
    copyFileSync(file, path.join(rewindBackupDir, `${sessionId}.jsonl`))
  } catch (e) {
    log('rewind backup failed, continuing anyway', e.message)
  }
  const tmp = `${file}.rewind.tmp`
  writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '')
  renameSync(tmp, file)
  return { ok: true, removed: lines.length - kept.length, sessionUsable: hasConversationEntry(kept) }
}

// clears a stale Continue button/state left over from a turn a newer message/reset/rewind has since superseded
async function clearPendingContinue(chatId) {
  const pending = state.pendingContinue[chatId]
  if (!pending) return
  delete state.pendingContinue[chatId]
  if (pending.placeholderId != null) {
    // an abandoned Continue offer needs a terminal marker, not just a stripped keyboard, or the last progress line looks like a stuck bot
    const text = [...(pending.checkpointHistory ?? []), '🚫 cancelled'].join('\n')
    await tg('editMessageText', buildPlaceholderEditParams(chatId, pending.placeholderId, text, false, { inline_keyboard: [] })).catch(() => {})
  }
}

function trackBotMessages(chatId, ids) {
  const turnList = state.turns[String(chatId)]
  if (!turnList?.length || !ids?.length) return
  const lastTurn = turnList[turnList.length - 1]
  lastTurn.botMessageIds = [...(lastTurn.botMessageIds ?? []), ...ids]
  saveState(state)
}

async function deleteBotMessages(chatId, ids) {
  for (const messageId of ids) {
    await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(e =>
      log('failed to delete bot message on rewind', messageId, e.message)
    )
  }
}

// An edited Telegram message means "pretend everything from here on never happened":
// rewind the claude session to just before that turn, wipe the bot's own follow-up
// messages, then run the edited text as if it had just arrived.
async function handleEditedMessage(msg) {
  const chatId = String(msg.chat.id)
  const turnList = state.turns[chatId] ?? []
  const turnIndex = findTurnIndexByMessageId(turnList, msg.message_id)
  const turn = turnIndex >= 0 ? turnList[turnIndex] : null
  const session = normalizeSession(state.sessions[chatId])

  if (!turn || !session || turn.sessionId !== session.id) {
    log('rewind unavailable', chatId, msg.message_id, 'turn=', Boolean(turn), 'session=', session?.id)
    await sendReply(chatId, buildRewindUnavailableNotice(), msg.message_id).catch(() => {})
    return
  }

  const rewind = rewindTranscript(session.id, turn.anchorMessageId ?? turn.userMessageId)
  if (!rewind.ok) {
    log('rewind failed', chatId, rewind.error)
    await sendReply(chatId, buildRewindUnavailableNotice(), msg.message_id).catch(() => {})
    return
  }
  log('rewound session', session.id, 'dropped', rewind.removed, 'transcript lines from turn', turnIndex)

  await deleteBotMessages(chatId, collectBotMessageIdsFrom(turnList, turnIndex))
  state.turns[chatId] = turnList.slice(0, turnIndex)
  if (!rewind.sessionUsable) delete state.sessions[chatId]
  delete state.pendingRisky[chatId]
  cancelCheckin(chatId)
  await clearPendingContinue(chatId)
  saveState(state)

  await handleMessage(msg)
}

function clearCheckinTimer(chatId) {
  const handle = checkinTimers.get(chatId)
  if (handle) {
    clearTimeout(handle)
    checkinTimers.delete(chatId)
  }
}

function armCheckinTimer(chatId) {
  clearCheckinTimer(chatId)
  const pending = state.pendingCheckins[chatId]
  if (!pending) return
  const delayMs = Math.max(0, pending.dueAt - Date.now())
  const handle = setTimeout(() => {
    checkinTimers.delete(chatId)
    chatQueue.enqueue(chatId, () => runCheckin(chatId)).catch(e => log('queued runCheckin rejected', e))
  }, delayMs)
  checkinTimers.set(chatId, handle)
}

function scheduleCheckin(chatId, sessionId, checkin, hopCount = 1) {
  state.pendingCheckins[chatId] = {
    dueAt: Date.now() + checkin.minutes * 60_000,
    instruction: checkin.instruction,
    sessionId,
    hopCount,
  }
  saveState(state)
  armCheckinTimer(chatId)
}

function cancelCheckin(chatId) {
  clearCheckinTimer(chatId)
  delete state.pendingCheckins[chatId]
}

async function runCheckin(chatId) {
  const pending = state.pendingCheckins[chatId]
  if (!pending) return
  delete state.pendingCheckins[chatId]
  saveState(state)

  const sessionId = normalizeSession(state.sessions[chatId])?.id ?? pending.sessionId
  if (!sessionId) {
    log('skipping check-in, no session to resume', chatId)
    return
  }

  try {
    const { promise: checkinPromise } = runClaude(buildCheckinFollowupPrompt(pending.instruction), sessionId, undefined, state.authMode[chatId])
    const result = await checkinPromise
    const priorSession = normalizeSession(state.sessions[chatId])
    let newSession = priorSession
    if (result.session_id) {
      newSession = accumulateSessionCost(newSession, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    const { text: cleanedResult, attachPaths, checkin: nextCheckin, noReply } = extractResponseMarkers(result.result)
    const costWarningCrossed = newSession && crossedCostThreshold(priorSession?.costUsd ?? 0, newSession.costUsd, costWarnUsd)
    const suppressReply = noReply && !cleanedResult && !result.is_error && !costWarningCrossed
    let replyText = result.is_error ? `⚠️ ${cleanedResult || 'check-in error'}` : cleanedResult || '(empty check-in response)'
    if (costWarningCrossed) {
      replyText = `${buildCostWarning(newSession.costUsd, costWarnUsd)}\n\n${replyText}`
    }
    if (!suppressReply) {
      trackBotMessages(chatId, await sendReply(chatId, replyText))
    }
    if (!result.is_error) {
      trackBotMessages(chatId, await sendAttachments(chatId, attachPaths))
      if (nextCheckin) {
        const hopCount = (pending.hopCount ?? 1) + 1
        if (checkinChainExceeded(hopCount)) {
          await sendReply(
            chatId,
            `⚠️ automated check-in chain hit its ${CHECKIN_MAX_CHAINED_HOPS}-hop safety cap — stopping here, please check on it yourself.`
          )
        } else {
          scheduleCheckin(chatId, newSession?.id ?? sessionId, nextCheckin, hopCount)
        }
      }
    }
  } catch (e) {
    log('runCheckin failed', chatId, e.message)
    await sendReply(chatId, `⚠️ automated check-in failed: ${e.message}`).catch(() => {})
  }
}

async function downloadAttachment(attachment) {
  if (exceedsAttachmentLimit(attachment.size)) {
    return { error: `attachment is ${attachment.size} bytes, over Telegram's ${MAX_ATTACHMENT_BYTES} byte bot-download cap` }
  }
  try {
    const file = await tg('getFile', { file_id: attachment.fileId })
    if (!file.file_path) return { error: 'Telegram returned no file_path for this attachment' }
    const res = await fetchWithTimeout(
      fetch,
      `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
      {},
      FILE_TRANSFER_TIMEOUT_MS
    )
    if (!res.ok) return { error: `download failed: HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(inboxDir, { recursive: true })
    const filename = buildInboxFilename(Date.now(), file.file_unique_id, file.file_path, attachment.kind)
    const filePath = path.join(inboxDir, filename)
    writeFileSync(filePath, buf)
    return { path: filePath }
  } catch (e) {
    return { error: e.message }
  }
}

function runSpawn(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let err = ''
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500).trim()}`))
    })
  })
}

async function transcribeVoice(filePath) {
  mkdirSync(tmpDir, { recursive: true })
  const base = path.join(tmpDir, `${Date.now()}-${path.basename(filePath, path.extname(filePath))}`)
  const wavPath = `${base}.wav`
  const txtPath = `${base}.txt`
  try {
    await runSpawn('ffmpeg', buildFfmpegConvertArgs(filePath, wavPath))
    const modelPath = expandHome(voiceTranscriptionConfig.modelPath, homedir())
    await runSpawn(voiceTranscriptionConfig.whisperBin, buildWhisperArgs(wavPath, modelPath, voiceTranscriptionConfig.language, base))
    return { text: parseWhisperTranscript(readFileSync(txtPath, 'utf8')) }
  } catch (e) {
    return { error: e.message }
  } finally {
    rmSync(wavPath, { force: true })
    rmSync(txtPath, { force: true })
  }
}

async function downloadAttachmentLogged(attachment) {
  const result = await downloadAttachment(attachment)
  if (result.error) log('attachment download failed', attachment.kind, result.error)
  return result
}

async function transcribeVoiceLogged(filePath) {
  const transcription = await transcribeVoice(filePath)
  if (transcription.error) log('voice transcription failed', transcription.error)
  return transcription
}

async function sendVoiceReply(chatId, text, replyToMessageId) {
  const speechText = truncateForSpeech(buildSpeechText(text), voiceReplyConfig.maxTtsChars)
  if (!speechText) return []
  let apiKey
  try {
    apiKey = readFileSync(expandHome(voiceReplyConfig.apiKeyPath, homedir()), 'utf8').trim()
  } catch {
    log('voice reply skipped: no TTS api key at', voiceReplyConfig.apiKeyPath)
    return []
  }
  try {
    const { url, headers, body } = buildTtsRequestOptions(speechText, {
      voiceId: voiceReplyConfig.voiceId,
      apiKey,
      modelId: voiceReplyConfig.modelId,
      voiceSettings: voiceReplyConfig.voiceSettings,
    })
    const res = await fetchWithTimeout(fetch, url, { method: 'POST', headers, body }, TTS_REQUEST_TIMEOUT_MS)
    if (!res.ok) throw new Error(`TTS request failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(outboxDir, { recursive: true })
    const filePath = path.join(outboxDir, buildOutboxFilename(Date.now(), chatId))
    writeFileSync(filePath, buf)
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('voice', new Blob([buf]), path.basename(filePath))
    if (replyToMessageId != null) {
      form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }))
    }
    const sendRes = await fetchWithTimeout(fetch, `${API}/sendVoice`, { method: 'POST', body: form }, FILE_TRANSFER_TIMEOUT_MS)
    const data = await sendRes.json()
    if (!data.ok) throw new Error(data.description)
    return data.result?.message_id != null ? [data.result.message_id] : []
  } catch (e) {
    log('sendVoiceReply failed', e.message)
    return []
  }
}

// Drives one Telegram message's live "⏳ working…" placeholder: a progress tracker plus
// the periodic editMessageText loop that renders it. Used both for the root placeholder
// of a run and for each parallel subagent (Agent tool) placeholder spawned during it.
function createPlaceholderController(
  chatId,
  initialMessageId,
  sharedGate = null,
  keyboard = null,
  initialStatus = DEFAULT_WORKING_STATUS,
  initialCheckpointLines = []
) {
  let messageId = initialMessageId
  // mutable: lets setKeyboard() update an already-streaming placeholder's Join count outside the periodic tick
  let currentKeyboard = keyboard
  const tracker = createProgressTracker(initialStatus, {
    renderTranscript: (historyLines, liveText) => renderTranscriptHtml(historyLines, liveText),
    initialCheckpointLines,
  })

  async function editPlaceholder({ text, html }) {
    if (messageId == null) return
    const params = buildPlaceholderEditParams(chatId, messageId, text, html, currentKeyboard)
    try {
      await tg('editMessageText', params)
    } catch (e) {
      if (/message is not modified/i.test(e.message)) return
      const retryAfterMatch = e.message.match(/retry after (\d+)/i)
      if (retryAfterMatch) {
        statusUpdater.pauseFor(Number(retryAfterMatch[1]) * 1000)
        log('editMessageText rate-limited, pausing streaming updates', e.message)
        return
      }
      if (!params.parse_mode) {
        log('editMessageText failed', e.message)
        return
      }
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: htmlToPlainFallback(params.text),
        ...(currentKeyboard ? { reply_markup: currentKeyboard } : {}),
      }).catch(e2 => log('editMessageText fallback failed', e2.message))
    }
  }

  const statusUpdater = createStatusUpdater({
    getStatus: () => tracker.snapshot(),
    onUpdate: latestStatus => editPlaceholder(latestStatus),
    initialStatus: tracker.snapshot(),
    intervalMs: STREAM_EDIT_INTERVAL_MS,
    sharedGate,
  })

  return {
    tracker,
    editPlaceholder,
    statusUpdater,
    ingest(event) {
      tracker.ingest(event)
    },
    // subagent placeholders are registered before their sendMessage call resolves
    // (see routeEvent), so their messageId isn't known yet at construction time
    setMessageId(id) {
      messageId = id
    },
    setKeyboard(kb) {
      currentKeyboard = kb
    },
  }
}

function isAuthorizedMessage(msg) {
  const chatId = String(msg.chat.id)
  const userId = String(msg.from?.id ?? '')
  if (isGroupChatType(msg.chat.type)) {
    const policy = resolveGroupPolicy(groupsConfig, chatId)
    // a join-synthesized message isn't itself a fresh @mention, but it continues a run this chat already passed the mention gate to start
    const effectivePolicy = msg.joinedFromActiveRun && policy ? { ...policy, requireMention: false } : policy
    if (!shouldHandleGroupMessage(msg, effectivePolicy, botIdentity.username, botIdentity.id)) {
      log('dropped group message', chatId, 'policy not satisfied for user', userId)
      return false
    }
    return true
  }
  if (!allowedUserIds.includes(userId)) {
    log('dropped message from non-allowed user', userId)
    return false
  }
  return true
}

async function withTypingIndicator(chatId, fn) {
  let typingAlive = true
  const typing = setInterval(() => {
    if (typingAlive) tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }, 4000)
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  try {
    return await fn()
  } finally {
    typingAlive = false
    clearInterval(typing)
  }
}

// shared by handleMessage and handleContinue, so both get the same progress/cancel/continue plumbing; run is a pre-created, pre-registered activeRuns entry (see addPendingJoinMessage/handleJoinTap)
async function runClaudeTurn(
  chatId,
  run,
  {
    prompt,
    sessionId,
    authMode,
    priorSession,
    workingStatus,
    botMessageIds,
    originMessageId = null,
    isCompact = false,
    isResume = false,
    checkpointHistory = [],
    turnMeta = {},
  }
) {
  const cancelKeyboard = buildCancelKeyboard(chatId, run.pending.length)
  let currentPlaceholderId = run.placeholderId
  if (currentPlaceholderId != null && isResume) {
    // the placeholder still shows the progress log from before cancelling — swap only the button, keep the text
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: currentPlaceholderId, reply_markup: cancelKeyboard }).catch(() => {})
  }

  // shared by root + every subagent placeholder below, so a 429 on any one of them
  // backs off every concurrent edit loop writing to this same chat
  const chatRateGate = createChatRateGate()
  const rootController = createPlaceholderController(chatId, currentPlaceholderId, chatRateGate, cancelKeyboard, workingStatus, checkpointHistory)
  run.setKeyboard = kb => rootController.setKeyboard(kb)

  // one placeholder message per parallel subagent (Agent tool call), keyed by that
  // tool_use's id; created when it starts, deleted once its tool_result comes back
  const subagentControllers = new Map()

  async function routeEvent(event) {
    const parentId = event?.parent_tool_use_id ?? null
    const parentEntry = parentId ? subagentControllers.get(parentId) : null
    ;(parentEntry ? parentEntry.controller : rootController).ingest(event)

    for (const block of extractNewSubagentBlocks(event, subagentControllers)) {
      const controller = createPlaceholderController(chatId, null, chatRateGate)
      const messageIdPromise = tg('sendMessage', {
        chat_id: chatId,
        text: DEFAULT_WORKING_STATUS,
        ...(currentPlaceholderId != null ? { reply_parameters: { message_id: currentPlaceholderId, allow_sending_without_reply: true } } : {}),
      })
        .then(sub => {
          controller.setMessageId(sub.message_id)
          return sub.message_id
        })
        .catch(e => {
          log('failed to send subagent placeholder', e.message)
          return null
        })
      // register synchronously, *before* the sendMessage above settles: extractNewSubagentBlocks
      // is dedup'd against this map, and every event is routed through its own fire-and-forget
      // microtask (see runClaude's onEvent), so a later event for this same subagent id must see
      // it as already-tracked immediately rather than racing to spawn a duplicate placeholder
      subagentControllers.set(block.id, { controller, messageIdPromise })
    }

    for (const id of extractFinishedSubagentIds(event, subagentControllers)) {
      const entry = subagentControllers.get(id)
      if (!entry) continue
      subagentControllers.delete(id)
      entry.controller.statusUpdater.stop()
      const messageId = await entry.messageIdPromise
      if (messageId != null) {
        await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(e => log('failed to delete subagent placeholder', e.message))
      }
    }
  }

  let cancelled = false
  let continueArmed = false
  let getSessionId = () => null
  try {
    if (run.finished) throw new Error('cancelled before the run could start')
    const claude = runClaude(prompt, sessionId, event => routeEvent(event), authMode)
    getSessionId = claude.getSessionId
    run.cancel = () => {
      if (cancelled) return
      cancelled = true
      run.finished = true
      claude.cancel()
    }
    const result = await claude.promise
    // claude can catch SIGTERM and still emit a result event before exiting, so a resolved promise doesn't rule out a cancel
    if (cancelled) {
      const err = new Error('cancelled after the run had already produced a result')
      err.cancelledResult = result
      throw err
    }
    run.finished = true
    // no finalStatus edit: the placeholder gets deleted outright below, once the real reply is sent
    rootController.statusUpdater.stop()
    let newSession = priorSession
    if (result.session_id) {
      newSession = accumulateSessionCost(newSession, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    const { text: cleanedResult, attachPaths, reactionEmoji, checkin, noReply } = extractResponseMarkers(result.result)
    const costWarningCrossed = newSession && crossedCostThreshold(priorSession?.costUsd ?? 0, newSession.costUsd, costWarnUsd)
    // NO_REPLY only ever suppresses an otherwise-empty, otherwise-unremarkable turn — an error, /compact, or a cost warning always still gets sent
    const suppressReply = noReply && !cleanedResult && !result.is_error && !isCompact && !costWarningCrossed
    let replyText = result.is_error
      ? `⚠️ ${cleanedResult || 'error'}`
      : isCompact
        ? `✅ conversation compacted.${cleanedResult ? `\n\n${cleanedResult}` : ''}`
        : (cleanedResult || '(empty response)')
    if (costWarningCrossed) {
      replyText = `${buildCostWarning(newSession.costUsd, costWarnUsd)}\n\n${replyText}`
    }
    if (!suppressReply) {
      // new message, not an edit of the placeholder, so Telegram pushes a notification
      botMessageIds.push(...(await sendReply(chatId, replyText, originMessageId)))
    }
    if (currentPlaceholderId != null) {
      // only untrack on a confirmed delete, so a failed one still gets the finally block's cleanup + a rewind retry
      try {
        await tg('deleteMessage', { chat_id: chatId, message_id: currentPlaceholderId })
        const idx = botMessageIds.indexOf(currentPlaceholderId)
        if (idx !== -1) botMessageIds.splice(idx, 1)
        currentPlaceholderId = null
        run.placeholderId = null
      } catch (e) {
        log('failed to delete working placeholder', e.message)
        // fall back to a terminal status edit so a stuck delete doesn't leave a stale phrase forever
        await rootController.editPlaceholder({ text: result.is_error ? '❌ failed' : '✅ done', html: false })
      }
    }
    if (!result.is_error) {
      botMessageIds.push(...(await sendAttachments(chatId, attachPaths, originMessageId)))
      if (isVoiceReplyEnabled(state.voiceReply, chatId)) {
        botMessageIds.push(...(await sendVoiceReply(chatId, cleanedResult, originMessageId)))
      }
      if (checkin) scheduleCheckin(chatId, newSession?.id ?? sessionId, checkin)
    }
    if (originMessageId != null) {
      // on success, clear the 👀 receipt reaction instead of swapping in a 👍 — the reply itself is the signal now
      await setReaction(chatId, originMessageId, reactionEmoji || (result.is_error ? ERROR_REACTION : null))
    }
  } catch (e) {
    run.finished = true
    rootController.statusUpdater.stop()
    if (cancelled) {
      // a hard kill often beats runClaude's own capturedSessionId to any stream line, so fall back to the resume id this turn was already given
      const resumableSessionId = e.cancelledResult?.session_id ?? getSessionId() ?? sessionId
      if (resumableSessionId) {
        state.sessions[chatId] = accumulateSessionCost(
          normalizeSession(state.sessions[chatId]),
          resumableSessionId,
          e.cancelledResult?.total_cost_usd ?? 0
        )
      }
      if (currentPlaceholderId != null && resumableSessionId) {
        // leave the placeholder's progress log as-is — only the button changes, so Continue can pick up on the same visible history
        state.pendingContinue[chatId] = {
          sessionId: resumableSessionId,
          placeholderId: currentPlaceholderId,
          isCompact,
          checkpointHistory: rootController.tracker.historySnapshot(),
          ...turnMeta,
        }
        continueArmed = true
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: currentPlaceholderId,
          reply_markup: buildContinueKeyboard(chatId),
        }).catch(() => {})
      } else {
        botMessageIds.push(...(await sendReply(chatId, '🚫 cancelled', originMessageId, currentPlaceholderId).catch(() => [])))
      }
      saveState(state)
    } else {
      log('handleMessage error', e)
      botMessageIds.push(...(await sendReply(chatId, `⚠️ bridge error: ${e.message}`, originMessageId, currentPlaceholderId).catch(() => [])))
      if (originMessageId != null) await setReaction(chatId, originMessageId, ERROR_REACTION)
    }
  } finally {
    rootController.statusUpdater.stop()
    activeRuns.delete(chatId)
    // avoid wiping the Continue button the catch block may have just attached above
    if (currentPlaceholderId != null && !continueArmed) {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: currentPlaceholderId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    }
    // safety net: normally every subagent's tool_result already deletes its own
    // placeholder as it happens; this only catches leftovers from a crash or a missed
    // event. Registration into subagentControllers happens synchronously (see routeEvent),
    // so any subagent spawned during the run is guaranteed to be in this map by now, even
    // if its sendMessage call is still in flight — hence awaiting messageIdPromise here too.
    await Promise.all(
      Array.from(subagentControllers.values()).map(async entry => {
        entry.controller.statusUpdater.stop()
        const messageId = await entry.messageIdPromise
        if (messageId != null) {
          await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {})
        }
      })
    )
    subagentControllers.clear()
  }

  return { cancelled, botMessageIds, sessionId: normalizeSession(state.sessions[chatId])?.id ?? null }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  const userId = String(msg.from?.id ?? '')
  if (!isAuthorizedMessage(msg)) return
  // every authorized message supersedes whatever interrupted turn a Continue button was still offering, regardless of which branch below handles it
  await clearPendingContinue(chatId)
  const attachment = extractAttachment(msg)
  const content = msg.text ?? msg.caption ?? null
  if (content == null && !attachment) {
    if (isServiceMessage(msg)) {
      log('ignoring service message', chatId, msg.message_id)
      return
    }
    await sendReply(
      chatId,
      '(bridge v1 only handles text messages, photos, documents, voice, audio, and video — this message type is not supported yet)',
      msg.message_id
    ).catch(() => {})
    return
  }

  const voiceToggle = parseVoiceToggleCommand(content, botIdentity.username)
  if (voiceToggle) {
    state.voiceReply = setVoiceReplyPreference(state.voiceReply, chatId, voiceToggle === 'on')
    saveState(state)
    await sendReply(chatId, buildVoiceToggleReply(voiceToggle === 'on'), msg.message_id).catch(() => {})
    return
  }

  const command = classifyCommand(content, botIdentity.username)

  if (command === 'reset') {
    delete state.sessions[chatId]
    delete state.pendingRisky[chatId]
    delete state.turns[chatId]
    cancelCheckin(chatId)
    saveState(state)
    await sendReply(chatId, '🔄 session reset — the next message starts a brand new conversation.', msg.message_id).catch(() => {})
    return
  }

  if (command === 'authSubscription' || command === 'authApiKey') {
    const mode = command === 'authSubscription' ? 'subscription' : 'apikey'
    const unmet = AUTH_MODE_PREREQUISITES[mode]()
    if (unmet) {
      await sendReply(chatId, unmet, msg.message_id).catch(() => {})
      return
    }
    state.authMode[chatId] = mode
    saveState(state)
    await setReaction(chatId, msg.message_id, AUTH_SWITCH_REACTION).catch(() => {})
    return
  }

  const session = normalizeSession(state.sessions[chatId])
  const sessionId = session?.id

  if (command === 'status') {
    await sendReply(chatId, formatStatusText(session, state.authMode[chatId]), msg.message_id).catch(() => {})
    return
  }

  if (command === 'compact' && !sessionId) {
    await sendReply(chatId, 'ℹ️ no active session to compact yet.', msg.message_id).catch(() => {})
    return
  }

  const fallbackMeta = {
    messageId: msg.message_id,
    user: sanitizeAttr(msg.from?.username ?? userId),
    ts: new Date((msg.date ?? 0) * 1000).toISOString(),
    replyToMessageId: extractReplyToMessageId(msg),
  }

  let promptText = content ?? ''
  let meta = fallbackMeta
  if (command === null) {
    const pendingEntry = state.pendingRisky[chatId]
    const decision = evaluateRiskyGuard(content ?? '', pendingEntry)
    if (decision.action === 'needsConfirmation') {
      state.pendingRisky[chatId] = { text: decision.text, ...fallbackMeta }
      saveState(state)
      await sendReply(chatId, buildRiskyCommandWarning(decision.match), msg.message_id).catch(() => {})
      return
    }
    if (pendingEntry) {
      delete state.pendingRisky[chatId]
      saveState(state)
    }
    meta = resolveMessageMeta(decision, pendingEntry, fallbackMeta)
    promptText = decision.text
  }
  if (!promptText && attachment) promptText = buildAttachmentCaption(attachment)

  await setReaction(chatId, msg.message_id, RECEIPT_REACTION)

  const workingStatus = nextWorkingPhrase()
  // every message the bot posts for this turn, so a later rewind past this turn can delete them
  const botMessageIds = []
  const run = {
    cancel() {
      if (run.finished) return
      run.finished = true
    },
    promptText,
    // built from meta, not msg directly, so a CONFIRMed run's Join still threads to the original message, not the CONFIRM reply
    replyToMessage: meta.replyToMessageId != null ? { message_id: meta.replyToMessageId } : undefined,
    placeholderId: null,
    pending: [],
    finished: false,
    setKeyboard: () => {},
  }
  // registered before the placeholder exists so a slow attachment download/transcription doesn't hide the Join button
  activeRuns.set(chatId, run)

  const turnResult = await withTypingIndicator(chatId, async () => {
    try {
      const placeholder = await tg(
        'sendMessage',
        buildWorkingPlaceholderParams(chatId, workingStatus, msg.message_id, buildCancelKeyboard(chatId, run.pending.length))
      )
      run.placeholderId = placeholder.message_id
      botMessageIds.push(run.placeholderId)
    } catch (e) {
      log('failed to send working placeholder', e.message)
    }

    let attachmentResult = null
    if (attachment) attachmentResult = await downloadAttachmentLogged(attachment)

    let transcriptionError = null
    if (attachment?.kind === 'voice' && attachmentResult?.path) {
      const transcription = await transcribeVoiceLogged(attachmentResult.path)
      if (transcription.error) {
        transcriptionError = transcription.error
      } else {
        promptText = buildVoiceTranscriptText(transcription.text)
        run.promptText = promptText
        const quoteHtml = buildTranscriptQuoteHtml(transcription.text)
        if (quoteHtml) {
          const frozen =
            run.placeholderId != null
              ? await freezePlaceholderAsTranscript(chatId, run.placeholderId, quoteHtml, workingStatus, buildCancelKeyboard(chatId, run.pending.length))
              : null
          if (frozen?.frozen) {
            run.placeholderId = frozen.placeholderId
            if (run.placeholderId != null) botMessageIds.push(run.placeholderId)
          } else {
            // no placeholder to freeze, or freezing it failed outright — the transcript still has to show up somewhere
            const quoteMessageId = await sendTranscriptQuote(chatId, quoteHtml, msg.message_id)
            if (quoteMessageId != null) botMessageIds.push(quoteMessageId)
          }
        }
      }
    }

    const attachmentAttrs = attachment
      ? {
          attachment_kind: attachment.kind,
          attachment_name: attachment.name,
          attachment_mime: attachment.mime,
          attachment_path: attachmentResult?.path,
          attachment_error: attachmentResult?.error,
          attachment_transcription_error: transcriptionError,
        }
      : {}

    const channelAttrs = {
      ...attachmentAttrs,
      // meta, not msg directly, so a CONFIRMed risky command keeps the original message's reply target
      reply_to_message_id: meta.replyToMessageId,
    }

    const prompt =
      command === 'compact'
        ? content
        : buildChannelPrompt(chatId, meta.messageId, meta.user, meta.ts, promptText, channelAttrs)

    return runClaudeTurn(chatId, run, {
      prompt,
      sessionId,
      authMode: state.authMode[chatId],
      priorSession: session,
      workingStatus,
      botMessageIds,
      originMessageId: msg.message_id,
      isCompact: command === 'compact',
      turnMeta: { originMessageId: msg.message_id, anchorMessageId: meta.messageId },
    })
  })

  state.turns = appendTurn(state.turns, chatId, {
    userMessageId: msg.message_id,
    anchorMessageId: meta.messageId,
    sessionId: turnResult.sessionId,
    botMessageIds: turnResult.botMessageIds,
  })
  saveState(state)
}

async function handleContinue(chatId, pending) {
  const priorSession = normalizeSession(state.sessions[chatId])
  const workingStatus = nextWorkingPhrase()
  const botMessageIds = [pending.placeholderId]
  const run = {
    cancel() {
      if (run.finished) return
      run.finished = true
    },
    promptText: buildContinuePrompt(),
    // a Continue tap has no originating message of its own to reply-thread from
    replyToMessage: undefined,
    placeholderId: pending.placeholderId,
    pending: [],
    finished: false,
    setKeyboard: () => {},
  }
  activeRuns.set(chatId, run)

  const turnResult = await withTypingIndicator(chatId, () =>
    runClaudeTurn(chatId, run, {
      prompt: buildContinuePrompt(),
      sessionId: pending.sessionId,
      authMode: state.authMode[chatId],
      priorSession,
      workingStatus,
      botMessageIds,
      originMessageId: pending.originMessageId,
      isCompact: pending.isCompact,
      isResume: true,
      checkpointHistory: pending.checkpointHistory ?? [],
      turnMeta: { originMessageId: pending.originMessageId, anchorMessageId: pending.anchorMessageId },
    })
  )

  state.turns = appendTurn(state.turns, chatId, {
    userMessageId: pending.originMessageId,
    anchorMessageId: pending.anchorMessageId,
    sessionId: turnResult.sessionId,
    botMessageIds: turnResult.botMessageIds,
  })
  saveState(state)
}

let botIdentity = { id: null, username: null }

async function addPendingJoinMessage(chatId, run, msg) {
  if (run.finished) return
  run.pending.push(msg)
  if (run.placeholderId == null) return
  const keyboard = buildCancelKeyboard(chatId, run.pending.length)
  run.setKeyboard(keyboard)
  const placeholderId = run.placeholderId
  await joinKeyboardQueue
    .enqueue(chatId, () =>
      tg('editMessageReplyMarkup', { chat_id: chatId, message_id: placeholderId, reply_markup: keyboard }).catch(e =>
        log('failed to update join keyboard', e.message)
      )
    )
    .catch(() => {})
}

async function transcribeJoinFragment(msg) {
  const attachment = extractAttachment(msg)
  if (attachment?.kind !== 'voice') return resolveJoinFragmentText(msg, null)
  const downloaded = await downloadAttachmentLogged(attachment)
  if (downloaded.error) return resolveJoinFragmentText(msg, { error: downloaded.error })
  const transcription = await transcribeVoiceLogged(downloaded.path)
  return resolveJoinFragmentText(msg, transcription)
}

function handleJoinTap(chatId, run) {
  const batch = run.pending.splice(0, run.pending.length)
  if (!batch.length) return
  let consumed = consumedByJoin.get(chatId)
  if (!consumed) {
    consumed = new Set()
    consumedByJoin.set(chatId, consumed)
  }
  for (const m of batch) consumed.add(m.message_id)

  run.cancel()

  // enqueued synchronously, before transcription, so a message sent right after this tap can't jump ahead of the join in the per-chat queue
  chatQueue
    .enqueue(chatId, async () => {
      const attachments = batch.map(extractAttachment)
      const fragments = await Promise.all(batch.map(transcribeJoinFragment))
      const voiceFragments = fragments.filter((f, i) => attachments[i]?.kind === 'voice')
      if (voiceFragments.length) {
        const quoteHtml = buildTranscriptQuoteHtml(voiceFragments.join('\n\n'))
        if (quoteHtml) await sendTranscriptQuote(chatId, quoteHtml, batch[batch.length - 1].message_id)
      }
      const joinedText = buildJoinedPromptText([run.promptText, ...fragments])
      const last = batch[batch.length - 1]
      const replyToMessage = resolveJoinedReplyToMessage(run.replyToMessage, last.reply_to_message)
      // stale entities/caption_entities offsets would misdirect isBotMentioned against joinedText
      const syntheticMsg = {
        ...last,
        text: joinedText,
        entities: undefined,
        caption: undefined,
        caption_entities: undefined,
        voice: undefined,
        reply_to_message: replyToMessage,
        joinedFromActiveRun: true,
      }
      return handleMessage(syntheticMsg)
    })
    .catch(e => log('queued joined handleMessage rejected', e))
}

function runQueuedMessage(chatId, msg) {
  const consumed = consumedByJoin.get(chatId)
  if (consumed?.delete(msg.message_id)) {
    if (consumed.size === 0) consumedByJoin.delete(chatId)
    return Promise.resolve()
  }
  return handleMessage(msg)
}

// cancel/join interrupt the run at chatQueue's head directly; continue starts a new run, so it's queued like any other message
async function handleCallbackQuery(cq) {
  const parsed = parseCallbackData(cq.data)
  if (!parsed) {
    const chatId = String(cq.message?.chat?.id ?? '')
    await handleUnrecognizedCallback(cq, {
      chatId,
      buttonsLoader: loadButtonsModule,
      tg,
      isAuthorized: isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig),
      enqueueMessage: msg => chatQueue.enqueue(chatId, () => handleMessage(msg)).catch(e => log('queued button-tap handleMessage rejected', e)),
      log,
    })
    return
  }

  // derived from the button's own message, not the callback_data payload, so a chat can only cancel/continue/join its own run
  const chatId = String(cq.message?.chat?.id ?? '')
  if (!isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized', show_alert: true }).catch(() => {})
    return
  }

  if (parsed.action === 'cancel' || parsed.action === 'join') {
    const run = activeRuns.get(chatId)
    if (!run || run.finished) {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: parsed.action === 'join' ? 'nothing to join' : 'nothing to cancel',
      }).catch(() => {})
      return
    }
    if (parsed.action === 'join') {
      if (!run.pending.length) {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'nothing to join' }).catch(() => {})
        return
      }
      handleJoinTap(chatId, run)
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'joining…' }).catch(() => {})
      return
    }
    run.cancel()
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'cancelling…' }).catch(() => {})
    return
  }

  // action === 'continue'
  const pending = state.pendingContinue[chatId]
  if (!pending) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'nothing to continue' }).catch(() => {})
    return
  }
  delete state.pendingContinue[chatId]
  saveState(state)
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'continuing…' }).catch(() => {})
  chatQueue.enqueue(chatId, () => handleContinue(chatId, pending)).catch(e => log('queued handleContinue rejected', e))
}

async function poll() {
  try {
    botIdentity = buildBotIdentity(await tg('getMe', {}))
  } catch (e) {
    log('getMe failed, group mention-gating will not resolve @mentions or reply-to-bot', e.message)
  }
  for (const { method, params } of buildBotMenuCalls()) {
    try {
      await tg(method, params)
    } catch (e) {
      log(`${method} failed, the bot menu may be stale`, e.message)
    }
  }
  log('bridge started, cwd=', cwd, 'offset=', state.offset, 'bot=', botIdentity.username)
  for (;;) {
    try {
      const updates = await tg(
        'getUpdates',
        { offset: state.offset, timeout: GET_UPDATES_POLL_TIMEOUT_S, allowed_updates: TELEGRAM_ALLOWED_UPDATES },
        { timeoutMs: GET_UPDATES_FETCH_TIMEOUT_MS }
      )
      for (const u of updates) {
        state.offset = u.update_id + 1
        saveState(state)
        if (u.message) {
          const chatId = String(u.message.chat.id)
          const activeRun = activeRuns.get(chatId)
          if (activeRun && isAuthorizedMessage(u.message) && isJoinableMessage(u.message, botIdentity.username)) {
            addPendingJoinMessage(chatId, activeRun, u.message).catch(e => log('failed to track pending join message', e.message))
          }
          chatQueue.enqueue(chatId, () => runQueuedMessage(chatId, u.message)).catch(e => log('queued handleMessage rejected', e))
        } else if (u.edited_message) {
          const chatId = String(u.edited_message.chat.id)
          if (isAuthorizedMessage(u.edited_message)) {
            // whatever is running now can only be this turn or a later one, and the rewind
            // is about to erase both — so stop it before it burns more tokens
            activeRuns.get(chatId)?.cancel()
            chatQueue
              .enqueue(chatId, () => handleEditedMessage(u.edited_message))
              .catch(e => log('queued handleEditedMessage rejected', e))
          }
        } else if (u.callback_query) {
          handleCallbackQuery(u.callback_query).catch(e => log('callback query handling rejected', e))
        }
      }
    } catch (e) {
      log('poll error', e)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

process.on('unhandledRejection', e => log('unhandled rejection', e))
poll()
