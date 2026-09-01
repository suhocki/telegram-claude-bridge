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
  copyFileSync,
  realpathSync,
  openSync,
  closeSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  sanitizeAttr,
  createKeyedQueue,
  threadKey,
  resolveThreadId,
  parseThreadKey,
  threadIdParam,
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
  buildJobMarkerInstructions,
  buildCheckinFollowupPrompt,
  extractResponseMarkers,
  checkinChainExceeded,
  CHECKIN_MAX_CHAINED_HOPS,
  mergePendingCheckin,
  buildSetMessageReactionParams,
  RECEIPT_REACTION,
  ERROR_REACTION,
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
  buildListenKeyboard,
  parseCallbackData,
  getModelConfig,
  setModelConfigField,
  isValidModelConfigValue,
  buildModelConfigArgs,
  buildConfigPinText,
  buildConfigKeyboard,
  buildConfigPinRenderKey,
  classifyConfigPinSyncError,
  parseConfigCallbackData,
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
  resolveVoiceReplyConfig,
  buildVoiceReplyRequestOptions,
  buildProsodyAnnotationPrompt,
  annotationPreservesText,
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
  findTurnIndexByBotMessageId,
  collectBotMessageIdsFrom,
  buildSessionTranscriptPath,
  findRewindCutIndex,
  hasConversationEntry,
  buildRewindUnavailableNotice,
  createTelegramClient,
  fetchWithTimeout,
  FetchTimeoutError,
  validateBridgeConfig,
  resolveBotSlug,
  resolveBotStateFile,
  appendCapped,
  atomicWriteFileSync,
  deriveLegacyAuthMode,
  MAX_TIMEOUT_MS,
} from './lib.mjs'
import { sweepOldFiles } from './retention.mjs'
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  DEFAULT_JOB_NOTIFY_THREAD_RECENCY_MS,
  JOB_HEARTBEAT_STALE_MS,
  isRecentTimestamp,
  resolveJobsDir,
  buildJobSpecPath,
  buildJobLogPath,
  isJobActive,
  countActiveJobs,
  validateJobSpec,
  createJobRecord,
  markJobRunning,
  markJobFinished,
  reconcileJobsOnBoot,
  renderJobsStatusMessage,
  selectStatusRenderJobs,
  groupJobsByThread,
  buildJobCompletionCheckin,
} from './jobs.mjs'
import { loadGlobalAuthMode, saveGlobalAuthMode, seedGlobalAuthModeIfMissing, collectLegacyAuthModeValues } from './auth-mode.mjs'
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
const configDir = path.dirname(path.resolve(configPath))
// Only scans configDir, matching how every bot in this repo is actually launched (all *.config.json colocated at the repo root).
const siblingStateFilePaths = readdirSync(configDir)
  .filter(f => f.endsWith('.config.json') && path.resolve(configDir, f) !== path.resolve(configPath))
  .flatMap(f => {
    try {
      const siblingStateFile = JSON.parse(readFileSync(path.join(configDir, f), 'utf8')).stateFile
      return typeof siblingStateFile === 'string' || siblingStateFile == null ? [resolveBotStateFile(configDir, siblingStateFile)] : []
    } catch {
      return []
    }
  })
const stateFilePath =
  config.stateFile == null || typeof config.stateFile === 'string' ? resolveBotStateFile(configDir, config.stateFile) : null
const configError = validateBridgeConfig(config, { stateFilePath, existingStateFilePaths: siblingStateFilePaths })
if (configError) {
  console.error(`invalid config ${configPath}: ${configError}`)
  process.exit(1)
}

const { botToken, cwd, allowedUserIds, appendSystemPrompt, claudeArgs, costWarnUsd, groups, buttonsModule } = config
const groupsConfig = groups ?? {}
const stateFile = stateFilePath
const stateDir = path.dirname(stateFile)
const botSlug = resolveBotSlug(configDir, config.stateFile)
// Namespaced by botSlug: every *.config.json in this repo resolves stateDir to the same directory.
const inboxDir = path.join(stateDir, 'inbox', botSlug)
const tmpDir = path.join(stateDir, 'tmp', botSlug)
const outboxDir = path.join(stateDir, 'outbox', botSlug)
const rewindBackupDir = path.join(stateDir, 'rewind-backups', botSlug)
const jobsDir = resolveJobsDir(stateDir, botSlug)
// Created eagerly, unlike inbox/tmp/outbox above: the job sweep needs it from the very first tick.
mkdirSync(jobsDir, { recursive: true })
// Deliberately NOT namespaced by botSlug: switching auth mode anywhere should apply to every bot sharing this stateDir.
const authModeFile = path.join(stateDir, 'auth-mode.txt')
// Resolved against the bridge module's own directory, not cwd/configPath, so every config shares one file.
const workingPhrasesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'working-phrases.json')
// Undocumented as a normal setting: lets the test suite point a scratch bridge at a fake Telegram server.
const TELEGRAM_API_ROOT = config.apiBaseUrl || 'https://api.telegram.org'
const API = `${TELEGRAM_API_ROOT}/bot${botToken}`
const GET_UPDATES_POLL_TIMEOUT_S = 30
const GET_UPDATES_FETCH_TIMEOUT_MS = 50000
const FILE_TRANSFER_TIMEOUT_MS = 60000
// Uploading several full-size photos in one sendMediaGroup call can genuinely take
// longer than a single-file send (Telegram processes/previews every item in the
// album) — a per-file budget on top of the base timeout avoids a false-timeout
// mid-upload, which used to cause a duplicate send (see sendAttachmentGroup).
const MEDIA_GROUP_PER_FILE_TIMEOUT_MS = 15000
const TTS_REQUEST_TIMEOUT_MS = 30000
// Short by design: a preprocessing nicety, not a conversation turn — must never delay a voice reply.
const PROSODY_ANNOTATION_TIMEOUT_MS = 6000
// Telegram rate-limits editMessageText to roughly 1/sec per chat; this stays safely under
// that while still feeling "live" for the growing-text placeholder preview.
const STREAM_EDIT_INTERVAL_MS = 1300
// Idle timeout (no stdout output at all for this long), not a cap on total turn duration — a long but actively streaming turn never trips it.
const CLAUDE_TURN_TIMEOUT_MS = config.claudeTurnTimeoutMs ?? 20 * 60 * 1000
// Backstop for a runaway loop the idle timeout alone wouldn't catch; scales with it (default 20min idle -> 4h), clamped to MAX_TIMEOUT_MS so a very large claudeTurnTimeoutMs can't overflow setTimeout's range and fire almost instantly.
const CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS = config.claudeTurnAbsoluteTimeoutMs ?? Math.min(CLAUDE_TURN_TIMEOUT_MS * 12, MAX_TIMEOUT_MS)
const SUBPROCESS_TIMEOUT_MS = config.subprocessTimeoutMs ?? 5 * 60 * 1000
const RETENTION_SWEEP_MAX_AGE_MS = (config.retentionDays ?? 14) * 24 * 60 * 60 * 1000
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const JOB_SWEEP_INTERVAL_MS = config.jobSweepIntervalMs ?? 15 * 1000
const JOB_MAX_CONCURRENT_PER_BOT = config.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS
const JOB_DEFAULT_TIMEOUT_MINUTES = config.jobDefaultTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES
// Floored to the turn's own max lifetime (disabled via 0 means "no cap", so floor to the largest delay Node allows instead), plus two sweep intervals of slack so the sweep that finally reads the spec isn't racing the same instant the turn's own timeout would have fired.
const JOB_NOTIFY_THREAD_RECENCY_FLOOR_MS = (CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS > 0 ? CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS : MAX_TIMEOUT_MS) + JOB_SWEEP_INTERVAL_MS * 2
const JOB_NOTIFY_THREAD_RECENCY_MS = Math.max(config.jobNotifyThreadRecencyMs ?? DEFAULT_JOB_NOTIFY_THREAD_RECENCY_MS, JOB_NOTIFY_THREAD_RECENCY_FLOOR_MS)
if (config.jobNotifyThreadRecencyMs != null && config.jobNotifyThreadRecencyMs < JOB_NOTIFY_THREAD_RECENCY_MS) {
  log('jobNotifyThreadRecencyMs raised from', config.jobNotifyThreadRecencyMs, 'to', JOB_NOTIFY_THREAD_RECENCY_MS, 'to cover claudeTurnAbsoluteTimeoutMs')
}

const voiceTranscriptionConfig = {
  whisperBin: DEFAULT_WHISPER_BIN,
  modelPath: DEFAULT_WHISPER_MODEL_PATH,
  language: DEFAULT_WHISPER_LANGUAGE,
  ...config.voiceTranscription,
}

const voiceReplyConfig = resolveVoiceReplyConfig(config.voiceReply)

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
    pendingContinue: {},
    modelConfig: {},
    jobs: {},
    jobStatusMessages: {},
    threadActivity: {},
    configPinMessages: {},
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
    state.pendingContinue ??= {}
    state.modelConfig ??= {}
    state.jobs ??= {}
    state.jobStatusMessages ??= {}
    state.threadActivity ??= {}
    state.configPinMessages ??= {}
    return state
  } catch {
    return emptyState()
  }
}

// Read fresh (not cached in `state`) so a switch made anywhere takes effect here on the very next turn.
function currentAuthMode() {
  return loadGlobalAuthMode(authModeFile)
}

function currentModelConfig(key) {
  return getModelConfig(state.modelConfig, key)
}

function saveState(state) {
  atomicWriteFileSync(stateFile, JSON.stringify(state, null, 2))
}

// threadKey -> last text+keyboard rendered onto that thread's pinned config message, purely to skip a no-op editMessageText call.
const lastConfigPinRenderKey = new Map()
// Own queue, not chatQueue: chatQueue is already holding the in-flight handleMessage/handleConfigCallbackQuery task that triggers a sync, so reusing it here would enqueue a key behind itself and deadlock (mirrors jobStatusQueue's separation from chatQueue).
const configPinQueue = createKeyedQueue()

function forgetConfigPin(key) {
  delete state.configPinMessages[key]
  lastConfigPinRenderKey.delete(key)
  saveState(state)
}

async function syncConfigPinNow(key) {
  const { chatId, threadId } = parseThreadKey(key)
  const text = buildConfigPinText(normalizeSession(state.sessions[key]))
  const keyboard = buildConfigKeyboard(chatId, currentModelConfig(key), currentAuthMode())
  const renderKey = buildConfigPinRenderKey(text, keyboard)
  const entry = state.configPinMessages[key]
  let messageId = entry?.id ?? null

  if (lastConfigPinRenderKey.get(key) !== renderKey) {
    try {
      if (messageId != null) {
        await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard })
      } else {
        const sent = await tg('sendMessage', { chat_id: chatId, text, reply_markup: keyboard, ...threadIdParam(threadId) })
        messageId = sent.message_id
        state.configPinMessages[key] = { id: messageId, pinned: false }
        saveState(state)
      }
      lastConfigPinRenderKey.set(key, renderKey)
    } catch (e) {
      const outcome = classifyConfigPinSyncError(e.message)
      if (outcome !== 'unmodified') {
        log('failed to update config status message', key, e.message)
        if (outcome === 'gone' && messageId != null) {
          forgetConfigPin(key)
          await tg('unpinChatMessage', { chat_id: chatId, message_id: messageId }).catch(() => {})
        }
        return
      }
      lastConfigPinRenderKey.set(key, renderKey)
    }
  }

  if (messageId != null && !state.configPinMessages[key]?.pinned) {
    try {
      await tg('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true })
      state.configPinMessages[key].pinned = true
      saveState(state)
    } catch (e) {
      log('failed to pin config status message', key, e.message)
      // gone, not just unpinnable — a static pin text never reaches the editMessageText call that'd normally catch this, so this is the only place it can be
      if (classifyConfigPinSyncError(e.message) === 'gone') forgetConfigPin(key)
    }
  }
}

// Returns the promise so a callback handler can await its own tap's ✅ landing; other callers just don't await it.
function syncConfigPin(key) {
  return configPinQueue.enqueue(key, () => syncConfigPinNow(key)).catch(e => log('config pin sync failed', key, e.message))
}

function syncAllConfigPins() {
  for (const key of Object.keys(state.configPinMessages)) syncConfigPin(key)
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
// thread key -> single in-flight run { cancel(), promptText, placeholderId, pending, finished, setKeyboard() }; chatQueue guarantees only one at a time.
const activeRuns = new Map()
// thread key -> Set<messageId> already folded into a join tap, so runQueuedMessage below no-ops their own already-queued run.
const consumedByJoin = new Map()
// serializes the join-count editMessageReplyMarkup calls per chat so back-to-back joins can't land out of order at Telegram
const joinKeyboardQueue = createKeyedQueue()
// `${chatId}:${messageId}` currently generating a voice note, so a duplicate/retried callback_query for the same tap is a no-op instead of a second TTS call
const listenInFlight = new Set()
// setTimeout handles can't be persisted, so state.pendingCheckins is re-armed into this Map on every boot.
const checkinTimers = new Map()
for (const key of Object.keys(state.pendingCheckins)) armCheckinTimer(key)

const tg = createTelegramClient(API)
const loadButtonsModule = createButtonsModuleLoader(resolveButtonsModulePath(buttonsModule, cwd))

// Returns the ids of the messages it created (empty for an edit of an existing one) so a
// caller can remember them and delete them later on a rewind.
async function sendReply(chatId, text, replyToMessageId, editMessageId, threadId, keyboard) {
  const chunks = markdownToTelegramHtmlChunks(text || '(empty response)')
  const sentIds = []
  for (const { method, params } of buildReplyCallsFromChunks(chatId, chunks, replyToMessageId, 'HTML', editMessageId, threadId, keyboard)) {
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
async function sendTranscriptQuote(chatId, quoteHtml, replyToMessageId, threadId) {
  const params = {
    chat_id: chatId,
    text: quoteHtml,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
    ...threadIdParam(threadId),
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

async function freezePlaceholderAsTranscript(chatId, placeholderId, quoteHtml, workingStatus, cancelKeyboard, threadId) {
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
    const progressPlaceholder = await tg('sendMessage', buildWorkingPlaceholderParams(chatId, workingStatus, placeholderId, cancelKeyboard, threadId))
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

function appendThreadId(form, threadId) {
  if (threadId != null) form.append('message_thread_id', threadId)
}

async function sendAttachment(chatId, filePath, replyToMessageId, threadId) {
  const guard = assertSendablePath(filePath, stateDir)
  if (!guard.ok) {
    log('refusing to send attachment', filePath, guard.error)
    return sendReply(chatId, `⚠️ ${guard.error}`, replyToMessageId, null, threadId).catch(() => [])
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendReply(chatId, `⚠️ attachment not found: ${filePath}`, replyToMessageId, null, threadId).catch(() => [])
  }
  const method = pickOutboundSendMethod(filePath)
  const field = method === 'sendPhoto' ? 'photo' : 'document'
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append(field, new Blob([readFileSync(filePath)]), path.basename(filePath))
  if (replyToMessageId != null) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }))
  }
  appendThreadId(form, threadId)
  try {
    const res = await fetchWithTimeout(fetch, `${API}/${method}`, { method: 'POST', body: form }, FILE_TRANSFER_TIMEOUT_MS)
    const data = await res.json()
    if (!data.ok) throw new Error(data.description)
    return data.result?.message_id != null ? [data.result.message_id] : []
  } catch (e) {
    log('sendAttachment failed', filePath, e.message)
    return sendReply(chatId, `⚠️ failed to send attachment ${path.basename(filePath)}: ${e.message}`, replyToMessageId, null, threadId).catch(() => [])
  }
}

// Telegram albums (sendMediaGroup) only accept 2-10 items and only photo/video mixed
// together — never mixed with documents — so this is only ever called with a
// pre-partitioned, pre-chunked list of 2-10 photo paths from sendAttachments below.
async function sendAttachmentGroup(chatId, filePaths, replyToMessageId, threadId) {
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
  appendThreadId(form, threadId)
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
        replyToMessageId,
        null,
        threadId
      ).catch(() => [])
    }
    log('sendAttachmentGroup failed, falling back to individual sends', filePaths.join(', '), e.message)
    const ids = []
    for (const filePath of filePaths) {
      ids.push(...(await sendAttachment(chatId, filePath, replyToMessageId, threadId)))
    }
    return ids
  }
}

// Entry point for a batch of ATTACH paths from one reply: 2+ photos go out as a single
// Telegram album instead of one message per photo, everything else (single photo,
// documents) goes through the existing one-file-per-message sendAttachment.
async function sendAttachments(chatId, filePaths, replyToMessageId, threadId) {
  const ids = []
  const validPaths = []
  for (const filePath of filePaths) {
    const guard = assertSendablePath(filePath, stateDir)
    if (!guard.ok) {
      log('refusing to send attachment', filePath, guard.error)
      ids.push(...(await sendReply(chatId, `⚠️ ${guard.error}`, replyToMessageId, null, threadId).catch(() => [])))
      continue
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      ids.push(...(await sendReply(chatId, `⚠️ attachment not found: ${filePath}`, replyToMessageId, null, threadId).catch(() => [])))
      continue
    }
    validPaths.push(filePath)
  }

  const { photoPaths, otherPaths } = partitionAttachmentPaths(validPaths)
  for (const chunk of chunkPaths(photoPaths)) {
    if (chunk.length >= 2) {
      ids.push(...(await sendAttachmentGroup(chatId, chunk, replyToMessageId, threadId)))
    } else if (chunk.length === 1) {
      ids.push(...(await sendAttachment(chatId, chunk[0], replyToMessageId, threadId)))
    }
  }
  for (const filePath of otherPaths) {
    ids.push(...(await sendAttachment(chatId, filePath, replyToMessageId, threadId)))
  }
  return ids
}

const CANCEL_SIGKILL_GRACE_MS = 3000

// Returns { promise, cancel } instead of a plain Promise so a caller can kill the run
// early (e.g. a Telegram "Cancel" button) without waiting for it to finish on its own.
function runClaude(prompt, sessionId, onEvent, authMode, modelConfig, notifyThreadKey) {
  // Saved immediately, not deferred to a later completion-path saveState: a restart between this stamp and that later save would otherwise make isThreadRecentlyActive wrongly reject this very turn's own still-fresh job spec.
  if (notifyThreadKey) {
    state.threadActivity[notifyThreadKey] = Date.now()
    saveState(state)
  }
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
      buildJobMarkerInstructions(jobsDir, notifyThreadKey),
      appendSystemPrompt
    )
  )
  if (Array.isArray(claudeArgs)) args.push(...claudeArgs)
  // pushed last so a chat's own /config choice always wins over a --model/--effort baked into claudeArgs (claude CLI takes the last occurrence of a repeated flag)
  args.push(...buildModelConfigArgs(modelConfig))

  // detached so `child.pid` is its own process-group leader: killing -child.pid kills
  // the whole tree (claude itself plus any Bash-spawned OS subprocesses), not just claude
  const child = spawn('claude', args, { cwd, env: buildChildEnv(process.env, authMode), detached: true })
  const pushChunk = createLineSplitter()
  let result = null
  let capturedSessionId = null
  let err = ''
  let stdoutTail = ''

  let sigkillTimer = null
  let timedOut = false
  let timedOutReason = null // 'idle' | 'absolute' — first one to fire wins, kept distinct so a future log/metric can tell a hang apart from a runaway loop
  let turnTimeoutTimer = null
  function markTimedOut(reason) {
    if (timedOut) return // already timed out via the other timer — don't overwrite which one actually caught it
    timedOut = true
    timedOutReason = reason
    cancel()
  }
  // Idle timeout (rearmed below on every stdout chunk) so a busy-but-progressing turn is never killed.
  function armTurnTimeout() {
    if (!CLAUDE_TURN_TIMEOUT_MS) return
    if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer)
    turnTimeoutTimer = setTimeout(() => markTimedOut('idle'), CLAUDE_TURN_TIMEOUT_MS)
  }
  armTurnTimeout()
  // Absolute backstop, never rearmed: catches a runaway loop that keeps emitting small chunks forever (idle timeout alone wouldn't).
  const absoluteTimeoutTimer = CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS
    ? setTimeout(() => markTimedOut('absolute'), CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS)
    : null

  child.stdout.on('data', d => {
    armTurnTimeout()
    const text = d.toString()
    stdoutTail = appendCapped(stdoutTail, text, 2000)
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
  child.stderr.on('data', d => (err = appendCapped(err, d, 2000)))

  const promise = new Promise((resolve, reject) => {
    child.on('error', e => {
      if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer)
      if (absoluteTimeoutTimer) clearTimeout(absoluteTimeoutTimer)
      reject(e)
    })
    child.on('close', code => {
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer)
      if (absoluteTimeoutTimer) clearTimeout(absoluteTimeoutTimer)
      // a result that arrived just as the timeout killed the process is still a real result, same as for a manual cancel.
      if (result) return resolve(result)
      if (timedOut) {
        const detail =
          timedOutReason === 'idle'
            ? `no output for ${CLAUDE_TURN_TIMEOUT_MS}ms`
            : `still running after ${CLAUDE_TURN_ABSOLUTE_TIMEOUT_MS}ms`
        return reject(Object.assign(new Error(`claude turn timed out (${timedOutReason}: ${detail})`), { timedOut: true, timedOutReason }))
      }
      reject(new Error(err || `claude exited ${code} with no result event\n${stdoutTail}`))
    })
  })

  function cancel() {
    if (child.exitCode != null || child.signalCode != null) return
    if (sigkillTimer) return // already cancelling (e.g. a manual Cancel racing the turn timeout) — don't orphan the first SIGKILL timer
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

// Only checks the switching bot's own process env, even though the switch itself is global — accepted because every com.tgbridge.* launchd plist is generated from the same ANTHROPIC_API_KEY, so they can't actually diverge in this deployment.
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
  atomicWriteFileSync(file, kept.length ? `${kept.join('\n')}\n` : '')
  return { ok: true, removed: lines.length - kept.length, sessionUsable: hasConversationEntry(kept) }
}

// clears a stale Continue button/state left over from a turn a newer message/reset/rewind has since superseded
async function clearPendingContinue(chatId, key) {
  const pending = state.pendingContinue[key]
  if (!pending) return
  delete state.pendingContinue[key]
  if (pending.placeholderId != null) {
    // an abandoned Continue offer needs a terminal marker, not just a stripped keyboard, or the last progress line looks like a stuck bot
    const text = [...(pending.checkpointHistory ?? []), '🚫 cancelled'].join('\n')
    await tg('editMessageText', buildPlaceholderEditParams(chatId, pending.placeholderId, text, false, { inline_keyboard: [] })).catch(() => {})
  }
}

// anchorBotMessageId pins the append to the turn owning that bot message, instead of always the latest turn (which may since belong to an unrelated later message)
function trackBotMessages(key, ids, anchorBotMessageId) {
  const turnList = state.turns[String(key)]
  if (!turnList?.length || !ids?.length) return
  const turnIndex = anchorBotMessageId != null ? findTurnIndexByBotMessageId(turnList, anchorBotMessageId) : turnList.length - 1
  if (turnIndex < 0) return
  const turn = turnList[turnIndex]
  turn.botMessageIds = [...(turn.botMessageIds ?? []), ...ids]
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
  const key = threadKey(chatId, msg)
  const turnList = state.turns[key] ?? []
  const turnIndex = findTurnIndexByMessageId(turnList, msg.message_id)
  const turn = turnIndex >= 0 ? turnList[turnIndex] : null
  const session = normalizeSession(state.sessions[key])

  if (!turn || !session || turn.sessionId !== session.id) {
    log('rewind unavailable', key, msg.message_id, 'turn=', Boolean(turn), 'session=', session?.id)
    await sendReply(chatId, buildRewindUnavailableNotice(), msg.message_id, null, resolveThreadId(msg)).catch(() => {})
    return
  }

  const rewind = rewindTranscript(session.id, turn.anchorMessageId ?? turn.userMessageId)
  if (!rewind.ok) {
    log('rewind failed', key, rewind.error)
    await sendReply(chatId, buildRewindUnavailableNotice(), msg.message_id, null, resolveThreadId(msg)).catch(() => {})
    return
  }
  log('rewound session', session.id, 'dropped', rewind.removed, 'transcript lines from turn', turnIndex)

  await deleteBotMessages(chatId, collectBotMessageIdsFrom(turnList, turnIndex))
  state.turns[key] = turnList.slice(0, turnIndex)
  if (!rewind.sessionUsable) {
    delete state.sessions[key]
    clearJobOnDoneCheckinsForThread(key)
  }
  delete state.pendingRisky[key]
  cancelCheckin(key)
  await clearPendingContinue(chatId, key)
  saveState(state)

  await handleMessage(msg)
}

function clearCheckinTimer(key) {
  const handle = checkinTimers.get(key)
  if (handle) {
    clearTimeout(handle)
    checkinTimers.delete(key)
  }
}

function armCheckinTimer(key) {
  clearCheckinTimer(key)
  const pending = state.pendingCheckins[key]
  if (!pending) return
  const delayMs = Math.max(0, pending.dueAt - Date.now())
  const handle = setTimeout(() => {
    checkinTimers.delete(key)
    chatQueue.enqueue(key, () => runCheckin(key)).catch(e => log('queued runCheckin rejected', e))
  }, delayMs)
  checkinTimers.set(key, handle)
}

// Folds into an already-pending check-in for this thread (earliest dueAt wins, instructions concatenate) instead of silently clobbering it — a job finishing must never erase a model's own still-pending CHECKIN: marker, or vice versa.
function scheduleCheckin(key, sessionId, checkin, hopCount = 1) {
  state.pendingCheckins[key] = mergePendingCheckin(state.pendingCheckins[key], { sessionId, checkin, hopCount, now: Date.now() })
  saveState(state)
  armCheckinTimer(key)
}

function cancelCheckin(key) {
  clearCheckinTimer(key)
  delete state.pendingCheckins[key]
}

async function runCheckin(key) {
  const pending = state.pendingCheckins[key]
  if (!pending) return
  delete state.pendingCheckins[key]
  saveState(state)

  const { chatId, threadId } = parseThreadKey(key)
  const sessionId = normalizeSession(state.sessions[key])?.id ?? pending.sessionId
  if (!sessionId) {
    log('skipping check-in, no session to resume', key)
    return
  }

  try {
    const { promise: checkinPromise } = runClaude(
      buildCheckinFollowupPrompt(pending.instruction),
      sessionId,
      undefined,
      currentAuthMode(),
      currentModelConfig(key),
      key
    )
    const result = await checkinPromise
    const priorSession = normalizeSession(state.sessions[key])
    let newSession = priorSession
    if (result.session_id) {
      newSession = accumulateSessionCost(newSession, result.session_id, result.total_cost_usd)
      state.sessions[key] = newSession
      saveState(state)
      syncConfigPin(key)
    }
    const { text: cleanedResult, attachPaths, checkin: nextCheckin, noReply } = extractResponseMarkers(result.result)
    const costWarningCrossed = newSession && crossedCostThreshold(priorSession?.costUsd ?? 0, newSession.costUsd, costWarnUsd)
    const suppressReply = noReply && !cleanedResult && !result.is_error && !costWarningCrossed
    let replyText = result.is_error ? `⚠️ ${cleanedResult || 'check-in error'}` : cleanedResult || '(empty check-in response)'
    if (costWarningCrossed) {
      replyText = `${buildCostWarning(newSession.costUsd, costWarnUsd)}\n\n${replyText}`
    }
    if (!suppressReply) {
      trackBotMessages(key, await sendReply(chatId, replyText, null, null, threadId))
    }
    if (!result.is_error) {
      trackBotMessages(key, await sendAttachments(chatId, attachPaths, null, threadId))
      if (nextCheckin) {
        const hopCount = (pending.hopCount ?? 1) + 1
        if (checkinChainExceeded(hopCount)) {
          await sendReply(
            chatId,
            `⚠️ automated check-in chain hit its ${CHECKIN_MAX_CHAINED_HOPS}-hop safety cap — stopping here, please check on it yourself.`,
            null,
            null,
            threadId
          )
        } else {
          scheduleCheckin(key, newSession?.id ?? sessionId, nextCheckin, hopCount)
        }
      }
    }
  } catch (e) {
    log('runCheckin failed', key, e.message)
    const text = e.timedOut ? '⏱️ automated check-in timed out' : `⚠️ automated check-in failed: ${e.message}`
    await sendReply(chatId, text, null, null, threadId).catch(() => {})
  }
}

// jobId -> live child handle; only present for jobs this exact process instance spawned.
const jobChildren = new Map()
// threadKey -> last status text sent/edited, purely to skip a no-op editMessageText call.
const lastRenderedJobsText = new Map()
// Serializes updateJobStatusMessages' per-thread work against concurrent callers (a job's own exit event, the sweep timer, boot reconciliation).
const jobStatusQueue = createKeyedQueue()

// Object.hasOwn, not `!= null`: a plain lookup resolves an inherited name like "__proto__" to a truthy value even when unconfigured.
function isThreadKeyAuthorized(key) {
  const { chatId } = parseThreadKey(key)
  return allowedUserIds.includes(chatId) || Object.hasOwn(groupsConfig, chatId)
}

function isThreadRecentlyActive(key) {
  return isRecentTimestamp(state.threadActivity[key], Date.now(), JOB_NOTIFY_THREAD_RECENCY_MS)
}

function isPidAlive(pid) {
  if (pid == null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // exists but owned by someone else — still alive
  }
}

// Mirrors runClaude's own cancel(): SIGTERM the job's whole process group, SIGKILL after a grace period if it ignored that.
function killJobProcessGroup(pid, child) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (e) {
    log('job timeout SIGTERM failed', pid, e.message)
  }
  setTimeout(() => {
    // The child handle (when we have one) is immune to pid reuse, unlike isPidAlive's process.kill(pid, 0) probe.
    const alive = child ? child.exitCode == null && child.signalCode == null : isPidAlive(pid)
    if (alive) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (e) {
        log('job timeout SIGKILL failed', pid, e.message)
      }
    }
  }, CANCEL_SIGKILL_GRACE_MS)
}

// Called whenever a thread's session gets invalidated (a /new, or a rewind that drops the session) so a job finishing later doesn't talk its result into whatever unrelated session occupies that thread next.
function clearJobOnDoneCheckinsForThread(key) {
  for (const record of Object.values(state.jobs)) {
    if (record.notifyThreadKey === key && record.onDoneCheckin) record.onDoneCheckin = null
  }
}

// Shared terminal-transition path for a job (own exit, liveness-poll miss, or boot reconciliation): persists the record, fires onDoneCheckin, refreshes the status message.
function finalizeJob(jobId, record) {
  jobChildren.delete(jobId)
  state.jobs[jobId] = record
  saveState(state)
  if (record.onDoneCheckin) {
    const sessionId = normalizeSession(state.sessions[record.notifyThreadKey])?.id
    if (!sessionId) {
      log('skipping job completion check-in, no session for thread', record.notifyThreadKey)
    } else {
      // Single source of truth for the hop count: whatever's already pending for this thread, not a separate counter that could fall out of sync with it.
      const hopCount = (state.pendingCheckins[record.notifyThreadKey]?.hopCount ?? 0) + 1
      if (checkinChainExceeded(hopCount)) {
        log('job completion check-in chain hit its safety cap', record.notifyThreadKey)
      } else {
        scheduleCheckin(record.notifyThreadKey, sessionId, buildJobCompletionCheckin(record), hopCount)
      }
    }
  }
  updateJobStatusMessages().catch(e => log('updateJobStatusMessages failed', e.message))
}

function handleJobExit(jobId, { code, signal, spawnFailed = false }) {
  const record = state.jobs[jobId]
  if (!record || !isJobActive(record)) return
  const status = spawnFailed ? 'failed' : record.killedForTimeout ? 'timed-out' : code === 0 ? 'done' : 'failed'
  finalizeJob(jobId, markJobFinished(record, { status, exitCode: code, signal, now: Date.now() }))
}

function startJob(jobId, spec, specPath) {
  const now = Date.now()
  const logPath = buildJobLogPath(jobsDir, jobId)
  const record = createJobRecord({ id: jobId, spec, now, logPath, defaultTimeoutMinutes: JOB_DEFAULT_TIMEOUT_MINUTES })
  let child
  let fd
  try {
    fd = openSync(logPath, 'a')
    // detached so child.pid is its own process-group leader, immune to the claude turn's own process-group kill on cancel/timeout.
    child = spawn('/bin/sh', ['-c', spec.command], {
      cwd: spec.cwd ? expandHome(spec.cwd, homedir()) : cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
  } catch (e) {
    log('failed to start background job', jobId, e.message)
    rmSync(specPath, { force: true })
    finalizeJob(jobId, markJobFinished(record, { status: 'failed', now: Date.now() }))
    return
  } finally {
    // Closed here (not just on the success path) so a spawn() that throws after openSync succeeded doesn't leak the fd.
    if (fd != null) closeSync(fd)
  }
  // Everything below only runs once spawn has actually succeeded, so a failure here (e.g. rmSync/saveState) can never mis-report an actually-running job as failed.
  child.unref()
  const running = markJobRunning(record, child.pid, now)
  jobChildren.set(jobId, child)
  // A command that fails to spawn at all never gets an 'exit' event, only 'error' — handled the same way so it can't be reported as a false "done".
  child.on('exit', (code, signal) => handleJobExit(jobId, { code, signal }))
  child.on('error', e => {
    log('background job process error', jobId, e.message)
    handleJobExit(jobId, { code: null, signal: null, spawnFailed: true })
  })
  log('started background job', jobId, spec.description, 'pid=', child.pid)
  state.jobs[jobId] = running
  rmSync(specPath, { force: true })
  saveState(state)
}

async function notifyJobRejected(spec, error) {
  const key = typeof spec?.notifyThreadKey === 'string' && spec.notifyThreadKey.trim() ? spec.notifyThreadKey : null
  if (!key || !isThreadKeyAuthorized(key)) return
  const { chatId, threadId } = parseThreadKey(key)
  await tg('sendMessage', {
    chat_id: chatId,
    text: `⚠️ background job spec rejected: ${error}`,
    ...threadIdParam(threadId),
  }).catch(e => log('failed to notify job spec rejection', e.message))
}

const NOTIFY_THREAD_KEY_RE = /"notifyThreadKey"\s*:\s*"([^"]+)"/

// Polls jobsDir like the retention sweep polls inbox/tmp/outbox; a new spec is consumed (deleted) exactly once, accepted or rejected.
async function pickUpNewJobSpecs() {
  let files
  try {
    files = readdirSync(jobsDir)
  } catch (e) {
    log('failed to read jobs dir', jobsDir, e.message)
    return
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const jobId = path.basename(file, '.json')
    const specPath = buildJobSpecPath(jobsDir, jobId)
    let rawText
    let spec
    try {
      rawText = readFileSync(specPath, 'utf8')
      spec = JSON.parse(rawText)
    } catch (e) {
      // Could just be a partial write this same sweep tick caught mid-flight — give it one more sweep before giving up.
      let mtimeMs = 0
      try {
        mtimeMs = statSync(specPath).mtimeMs
      } catch {}
      if (Date.now() - mtimeMs < JOB_SWEEP_INTERVAL_MS * 2) continue
      log('failed to parse job spec, discarding', specPath, e.message)
      await notifyJobRejected({ notifyThreadKey: rawText?.match(NOTIFY_THREAD_KEY_RE)?.[1] }, `spec file could not be parsed as JSON: ${e.message}`)
      rmSync(specPath, { force: true })
      continue
    }
    if (Object.hasOwn(state.jobs, jobId)) {
      log('rejected job spec, job id already used', specPath)
      await notifyJobRejected(spec, `job id "${jobId}" was already used by an earlier job — pick a new, unused id`)
      rmSync(specPath, { force: true })
      continue
    }
    const validation = validateJobSpec(spec, {
      jobId,
      jobsDir,
      filePath: specPath,
      activeCount: countActiveJobs(state.jobs),
      maxConcurrentJobs: JOB_MAX_CONCURRENT_PER_BOT,
      isThreadKeyAuthorized,
      isThreadRecentlyActive,
    })
    if (!validation.ok) {
      log('rejected job spec', specPath, validation.error)
      await notifyJobRejected(spec, validation.error)
      rmSync(specPath, { force: true })
      continue
    }
    startJob(jobId, spec, specPath)
  }
}

// A job with a live child handle (spawned by this process) is checked via that handle; a restart-adopted one has its pid polled instead.
function checkRunningJobs() {
  const now = Date.now()
  for (const [jobId, record] of Object.entries(state.jobs)) {
    if (!isJobActive(record)) continue
    const child = jobChildren.get(jobId)
    const alive = child ? child.exitCode == null && child.signalCode == null : isPidAlive(record.pid)
    if (!alive) {
      // No live child handle means this is a restart-adopted job whose real exit code was never observed — "unknown", not a guessed "done", so a real failure is never silently reported as a success. A live handle that's already dead (defensive: handleJobExit's own 'exit' listener normally beats this poll to it) still has its real exit code/signal available.
      const status = record.killedForTimeout ? 'timed-out' : child ? (child.exitCode === 0 ? 'done' : 'failed') : 'unknown'
      finalizeJob(jobId, markJobFinished(record, { status, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, now }))
      continue
    }
    try {
      record.lastHeartbeatAt = statSync(record.logPath).mtimeMs
    } catch {
      // log file not created yet (or briefly missing) — leave the previous heartbeat timestamp
    }
    if (!record.killedForTimeout && now >= record.startedAt + record.timeoutMinutes * 60_000) {
      log('background job timed out, killing its process group', jobId, record.description)
      record.killedForTimeout = true
      killJobProcessGroup(record.pid, child)
    }
  }
}

async function updateThreadJobStatusMessage(key, jobsForThread, now) {
  const toShow = selectStatusRenderJobs(jobsForThread)
  if (!toShow.length) return
  const text = renderJobsStatusMessage(toShow, now, { staleMs: JOB_HEARTBEAT_STALE_MS })
  let delivered = lastRenderedJobsText.get(key) === text
  if (!delivered) {
    const { chatId, threadId } = parseThreadKey(key)
    const messageId = state.jobStatusMessages[key]
    try {
      if (messageId != null) {
        await tg('editMessageText', { chat_id: chatId, message_id: messageId, text })
      } else {
        const sent = await tg('sendMessage', { chat_id: chatId, text, ...threadIdParam(threadId) })
        state.jobStatusMessages[key] = sent.message_id
      }
      lastRenderedJobsText.set(key, text)
      delivered = true
    } catch (e) {
      if (/message is not modified/i.test(e.message)) {
        delivered = true
      } else {
        log('failed to update job status message', key, e.message)
        // Stop retrying a message id that may no longer be editable (deleted, expired edit window, ...) — fall back to a fresh sendMessage next sweep instead of retrying the same dead id forever.
        if (messageId != null) delete state.jobStatusMessages[key]
      }
    }
  }
  // Only stop tracking a fully-finished thread once its final summary was actually delivered — a failed edit/send must keep retrying on the next sweep instead of being silently lost.
  if (delivered && !toShow.some(isJobActive)) {
    for (const job of toShow) job.reported = true
    delete state.jobStatusMessages[key]
    lastRenderedJobsText.delete(key)
  }
}

// One bot message per thread with jobs to report on, live-edited in place.
async function updateJobStatusMessages() {
  const now = Date.now()
  const entries = Object.entries(groupJobsByThread(state.jobs))
  if (!entries.length) return
  await Promise.all(entries.map(([key, jobsForThread]) => jobStatusQueue.enqueue(key, () => updateThreadJobStatusMessage(key, jobsForThread, now))))
  saveState(state)
}

let sweepJobsInFlight = false

// Guards against an overlapping setInterval tick re-reading a spec file a slow await (e.g. a rejection notice) hasn't gotten around to deleting yet.
async function sweepJobs() {
  if (sweepJobsInFlight) return
  sweepJobsInFlight = true
  try {
    await pickUpNewJobSpecs()
    checkRunningJobs()
    await updateJobStatusMessages()
  } finally {
    sweepJobsInFlight = false
  }
}

// A job left "running" in state.json on boot might still be alive (its process group outlives the bridge) or might not.
function reconcileJobsOnBootAndReport() {
  const { jobs, deadJobIds } = reconcileJobsOnBoot(state.jobs, isPidAlive, Date.now())
  state.jobs = jobs
  saveState(state)
  for (const jobId of deadJobIds) finalizeJob(jobId, state.jobs[jobId])
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
      `${TELEGRAM_API_ROOT}/file/bot${botToken}/${file.file_path}`,
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

function runSpawn(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // detached so a timeout SIGKILLs the whole process group, not just this direct child (mirrors runClaude's cancel()).
    const child = spawn(cmd, args, { detached: true })
    let err = ''
    child.stderr.on('data', d => (err = appendCapped(err, d, 2000)))
    let timedOut = false
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (e) {
            log(`runSpawn: SIGKILL failed for ${cmd}`, e.message)
          }
        }, timeoutMs)
      : null
    child.on('error', e => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (timedOut) return reject(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { timedOut: true }))
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
    await runSpawn('ffmpeg', buildFfmpegConvertArgs(filePath, wavPath), SUBPROCESS_TIMEOUT_MS)
    const modelPath = expandHome(voiceTranscriptionConfig.modelPath, homedir())
    await runSpawn(
      voiceTranscriptionConfig.whisperBin,
      buildWhisperArgs(wavPath, modelPath, voiceTranscriptionConfig.language, base),
      SUBPROCESS_TIMEOUT_MS
    )
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

// Single short-lived `claude -p` call, deliberately not runClaude — no session/streaming machinery needed for a one-shot tagging pass. Never rejects; resolves to null on any failure/timeout/bad-output.
async function annotateProsody(text, authMode) {
  const prompt = buildProsodyAnnotationPrompt(text)
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // detached, same as runClaude/runSpawn, so a timeout SIGKILLs the whole process group rather than leaving a reparented tool-call subprocess running
    const child = spawn(
      'claude',
      ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
      { cwd, env: buildChildEnv(process.env, authMode), detached: true }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      log('prosody annotation timed out')
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (e) {
        log('prosody annotation: kill failed', e.message)
      }
      finish(null)
    }, PROSODY_ANNOTATION_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      log('prosody annotation spawn failed', e.message)
      finish(null)
    })
    child.on('close', code => {
      if (code !== 0) {
        log('prosody annotation exited', code, err.slice(0, 500))
        return finish(null)
      }
      try {
        const parsed = JSON.parse(out)
        finish(typeof parsed.result === 'string' ? parsed.result.trim() : null)
      } catch (e) {
        log('prosody annotation: failed to parse result', e.message)
        finish(null)
      }
    })
  })
}

// Fish's S2-family models (incl. the s2.1-pro-free default) read [bracket] tags as markup; older/other model ids may just speak them literally.
function supportsFishProsodyTags(voiceReplyConfig) {
  return voiceReplyConfig.provider === 'fish' && String(voiceReplyConfig.modelId ?? '').startsWith('s2')
}

async function sendVoiceReply(chatId, text, replyToMessageId, threadId, { alreadyPlain = false } = {}) {
  // alreadyPlain: the Listen button passes Telegram's own already-rendered message.text, which must skip the markdown pass buildSpeechText applies for raw model output
  // Annotated after truncateForSpeech (below), not before: truncating an already-tagged string risks slicing a tag in half and reading a stray literal "[" aloud.
  let speechText = truncateForSpeech(alreadyPlain ? String(text ?? '').trim() : buildSpeechText(text), voiceReplyConfig.maxTtsChars)
  if (!speechText) return { ok: false, messageIds: [], error: 'nothing to say' }
  if (supportsFishProsodyTags(voiceReplyConfig)) {
    const annotated = await annotateProsody(speechText, currentAuthMode())
    if (annotated && annotationPreservesText(speechText, annotated)) {
      speechText = annotated
    } else if (annotated) {
      log('prosody annotation discarded: text changed after stripping tags')
    }
  }
  let apiKey
  try {
    apiKey = readFileSync(expandHome(voiceReplyConfig.apiKeyPath, homedir()), 'utf8').trim()
  } catch {
    log('voice reply skipped: no TTS api key at', voiceReplyConfig.apiKeyPath)
    return { ok: false, messageIds: [], error: 'no TTS api key configured' }
  }
  try {
    const { url, headers, body } = buildVoiceReplyRequestOptions(speechText, voiceReplyConfig, apiKey)
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
    appendThreadId(form, threadId)
    const sendRes = await fetchWithTimeout(fetch, `${API}/sendVoice`, { method: 'POST', body: form }, FILE_TRANSFER_TIMEOUT_MS)
    const data = await sendRes.json()
    if (!data.ok) throw new Error(data.description)
    const messageIds = data.result?.message_id != null ? [data.result.message_id] : []
    return { ok: true, messageIds }
  } catch (e) {
    log('sendVoiceReply failed', e.message)
    return { ok: false, messageIds: [], error: e.message }
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

async function withTypingIndicator(chatId, threadId, fn) {
  const chatActionParams = { chat_id: chatId, action: 'typing', ...threadIdParam(threadId) }
  let typingAlive = true
  const typing = setInterval(() => {
    if (typingAlive) tg('sendChatAction', chatActionParams).catch(() => {})
  }, 4000)
  await tg('sendChatAction', chatActionParams).catch(() => {})
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
  key,
  threadId,
  run,
  {
    prompt,
    sessionId,
    authMode,
    modelConfig,
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
        disable_notification: true,
        ...(currentPlaceholderId != null ? { reply_parameters: { message_id: currentPlaceholderId, allow_sending_without_reply: true } } : {}),
        ...threadIdParam(threadId),
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
    const claude = runClaude(prompt, sessionId, event => routeEvent(event), authMode, modelConfig, key)
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
      state.sessions[key] = newSession
      saveState(state)
      syncConfigPin(key)
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
      // only the plain successful reply gets the button — not errors/compact/cost-warnings/empty replies, and never when audio is already sent automatically
      const showListenButton =
        !result.is_error && !isCompact && !costWarningCrossed && cleanedResult && !isVoiceReplyEnabled(state.voiceReply, key)
      const keyboard = showListenButton ? buildListenKeyboard(chatId) : null
      // new message, not an edit of the placeholder, so Telegram pushes a notification
      botMessageIds.push(...(await sendReply(chatId, replyText, originMessageId, null, threadId, keyboard)))
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
      botMessageIds.push(...(await sendAttachments(chatId, attachPaths, originMessageId, threadId)))
      if (isVoiceReplyEnabled(state.voiceReply, key)) {
        botMessageIds.push(...(await sendVoiceReply(chatId, cleanedResult, originMessageId, threadId)).messageIds)
      }
      if (checkin) scheduleCheckin(key, newSession?.id ?? sessionId, checkin)
    }
    if (originMessageId != null) {
      // on success, clear the 👀 receipt reaction instead of swapping in a 👍 — the reply itself is the signal now
      await setReaction(chatId, originMessageId, reactionEmoji || (result.is_error ? ERROR_REACTION : null))
    }
  } catch (e) {
    run.finished = true
    rootController.statusUpdater.stop()
    if (cancelled || e.timedOut) {
      // a hard kill often beats runClaude's own capturedSessionId to any stream line, so fall back to the resume id this turn was already given
      const resumableSessionId = e.cancelledResult?.session_id ?? getSessionId() ?? sessionId
      if (resumableSessionId) {
        state.sessions[key] = accumulateSessionCost(
          normalizeSession(state.sessions[key]),
          resumableSessionId,
          e.cancelledResult?.total_cost_usd ?? 0
        )
      }
      if (currentPlaceholderId != null && resumableSessionId) {
        // leave the placeholder's progress log as-is — only the button changes, so Continue can pick up on the same visible history
        state.pendingContinue[key] = {
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
        // cancelled wins if both raced (a manual cancel right as the turn timeout also fired) — it reflects user intent.
        const text = !cancelled && e.timedOut ? '⏱️ timed out' : '🚫 cancelled'
        botMessageIds.push(...(await sendReply(chatId, text, originMessageId, currentPlaceholderId, threadId).catch(() => [])))
      }
      saveState(state)
      if (resumableSessionId) syncConfigPin(key)
    } else {
      log('handleMessage error', e)
      botMessageIds.push(...(await sendReply(chatId, `⚠️ bridge error: ${e.message}`, originMessageId, currentPlaceholderId, threadId).catch(() => [])))
      if (originMessageId != null) await setReaction(chatId, originMessageId, ERROR_REACTION)
    }
  } finally {
    rootController.statusUpdater.stop()
    activeRuns.delete(key)
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

  return { cancelled, botMessageIds, sessionId: normalizeSession(state.sessions[key])?.id ?? null }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  const key = threadKey(chatId, msg)
  const threadId = resolveThreadId(msg)
  const userId = String(msg.from?.id ?? '')
  if (!isAuthorizedMessage(msg)) return
  // every authorized message supersedes whatever interrupted turn a Continue button was still offering, regardless of which branch below handles it
  await clearPendingContinue(chatId, key)
  const attachment = extractAttachment(msg)
  const content = msg.text ?? msg.caption ?? null
  if (content == null && !attachment && isServiceMessage(msg)) {
    log('ignoring service message', key, msg.message_id)
    return
  }
  syncConfigPin(key)
  if (content == null && !attachment) {
    await sendReply(
      chatId,
      '(bridge v1 only handles text messages, photos, documents, voice, audio, and video — this message type is not supported yet)',
      msg.message_id,
      null,
      threadId
    ).catch(() => {})
    return
  }

  const voiceToggle = parseVoiceToggleCommand(content, botIdentity.username)
  if (voiceToggle) {
    state.voiceReply = setVoiceReplyPreference(state.voiceReply, key, voiceToggle === 'on')
    saveState(state)
    await sendReply(chatId, buildVoiceToggleReply(voiceToggle === 'on'), msg.message_id, null, threadId).catch(() => {})
    return
  }

  const command = classifyCommand(content, botIdentity.username)

  if (command === 'reset') {
    delete state.sessions[key]
    delete state.pendingRisky[key]
    delete state.turns[key]
    cancelCheckin(key)
    clearJobOnDoneCheckinsForThread(key)
    saveState(state)
    syncConfigPin(key)
    await sendReply(chatId, '🔄 session reset — the next message starts a brand new conversation.', msg.message_id, null, threadId).catch(() => {})
    return
  }

  const session = normalizeSession(state.sessions[key])
  const sessionId = session?.id

  if (command === 'status') {
    await sendReply(chatId, formatStatusText(session, currentAuthMode()), msg.message_id, null, threadId).catch(() => {})
    return
  }

  if (command === 'compact' && !sessionId) {
    await sendReply(chatId, 'ℹ️ no active session to compact yet.', msg.message_id, null, threadId).catch(() => {})
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
    const pendingEntry = state.pendingRisky[key]
    const decision = evaluateRiskyGuard(content ?? '', pendingEntry)
    if (decision.action === 'needsConfirmation') {
      state.pendingRisky[key] = { text: decision.text, ...fallbackMeta }
      saveState(state)
      await sendReply(chatId, buildRiskyCommandWarning(decision.match), msg.message_id, null, threadId).catch(() => {})
      return
    }
    if (pendingEntry) {
      delete state.pendingRisky[key]
      saveState(state)
    }
    meta = resolveMessageMeta(decision, pendingEntry, fallbackMeta)
    promptText = decision.text
  }
  if (!promptText && attachment) promptText = buildAttachmentCaption(attachment)

  await setReaction(chatId, msg.message_id, RECEIPT_REACTION)

  const workingStatus = nextWorkingPhrase()
  // every message the bot posts for this turn, so a later rewind past this turn can delete them
  const botMessageIds = [...(msg.extraBotMessageIds ?? [])]
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
  activeRuns.set(key, run)

  const turnResult = await withTypingIndicator(chatId, threadId, async () => {
    try {
      const placeholder = await tg(
        'sendMessage',
        buildWorkingPlaceholderParams(chatId, workingStatus, msg.message_id, buildCancelKeyboard(chatId, run.pending.length), threadId)
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
              ? await freezePlaceholderAsTranscript(
                  chatId,
                  run.placeholderId,
                  quoteHtml,
                  workingStatus,
                  buildCancelKeyboard(chatId, run.pending.length),
                  threadId
                )
              : null
          if (frozen?.frozen) {
            run.placeholderId = frozen.placeholderId
            if (run.placeholderId != null) botMessageIds.push(run.placeholderId)
          } else {
            // no placeholder to freeze, or freezing it failed outright — the transcript still has to show up somewhere
            const quoteMessageId = await sendTranscriptQuote(chatId, quoteHtml, msg.message_id, threadId)
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

    return runClaudeTurn(chatId, key, threadId, run, {
      prompt,
      sessionId,
      authMode: currentAuthMode(),
      modelConfig: currentModelConfig(key),
      priorSession: session,
      workingStatus,
      botMessageIds,
      originMessageId: msg.message_id,
      isCompact: command === 'compact',
      turnMeta: { originMessageId: msg.message_id, anchorMessageId: meta.messageId },
    })
  })

  state.turns = appendTurn(state.turns, key, {
    userMessageId: msg.message_id,
    anchorMessageId: meta.messageId,
    sessionId: turnResult.sessionId,
    botMessageIds: turnResult.botMessageIds,
  })
  saveState(state)
}

async function handleContinue(chatId, key, threadId, pending) {
  const priorSession = normalizeSession(state.sessions[key])
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
  activeRuns.set(key, run)

  const turnResult = await withTypingIndicator(chatId, threadId, () =>
    runClaudeTurn(chatId, key, threadId, run, {
      prompt: buildContinuePrompt(),
      sessionId: pending.sessionId,
      authMode: currentAuthMode(),
      modelConfig: currentModelConfig(key),
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

  state.turns = appendTurn(state.turns, key, {
    userMessageId: pending.originMessageId,
    anchorMessageId: pending.anchorMessageId,
    sessionId: turnResult.sessionId,
    botMessageIds: turnResult.botMessageIds,
  })
  saveState(state)
}

let botIdentity = { id: null, username: null }

async function addPendingJoinMessage(chatId, key, run, msg) {
  if (run.finished) return
  run.pending.push(msg)
  if (run.placeholderId == null) return
  const keyboard = buildCancelKeyboard(chatId, run.pending.length)
  run.setKeyboard(keyboard)
  const placeholderId = run.placeholderId
  await joinKeyboardQueue
    .enqueue(key, () =>
      tg('editMessageReplyMarkup', { chat_id: chatId, message_id: placeholderId, reply_markup: keyboard }).catch(e =>
        log('failed to update join keyboard', e.message)
      )
    )
    .catch(() => {})
}

async function transcribeJoinFragment(msg) {
  const attachment = extractAttachment(msg)
  if (attachment?.kind !== 'voice') return { promptText: resolveJoinFragmentText(msg, null), transcript: null }
  const downloaded = await downloadAttachmentLogged(attachment)
  if (downloaded.error) return { promptText: resolveJoinFragmentText(msg, { error: downloaded.error }), transcript: null }
  const transcription = await transcribeVoiceLogged(downloaded.path)
  return {
    promptText: resolveJoinFragmentText(msg, transcription),
    transcript: transcription.error ? null : transcription.text,
  }
}

function handleJoinTap(chatId, key, run) {
  const batch = run.pending.splice(0, run.pending.length)
  if (!batch.length) return
  let consumed = consumedByJoin.get(key)
  if (!consumed) {
    consumed = new Set()
    consumedByJoin.set(key, consumed)
  }
  for (const m of batch) consumed.add(m.message_id)

  run.cancel()

  // enqueued synchronously, before transcription, so a message sent right after this tap can't jump ahead of the join in the per-chat queue
  chatQueue
    .enqueue(key, async () => {
      const results = await Promise.all(batch.map(transcribeJoinFragment))
      const fragments = results.map(r => r.promptText)
      const transcripts = results.map(r => r.transcript).filter(t => t != null && t.trim())
      const last = batch[batch.length - 1]
      let quoteMessageId = null
      if (transcripts.length) {
        const quoteHtml = buildTranscriptQuoteHtml(transcripts.join('\n\n'))
        if (quoteHtml) quoteMessageId = await sendTranscriptQuote(chatId, quoteHtml, last.message_id, resolveThreadId(last))
      }
      const joinedText = buildJoinedPromptText([run.promptText, ...fragments])
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
        extraBotMessageIds: quoteMessageId != null ? [quoteMessageId] : [],
      }
      return handleMessage(syntheticMsg)
    })
    .catch(e => log('queued joined handleMessage rejected', e))
}

function runQueuedMessage(key, msg) {
  const consumed = consumedByJoin.get(key)
  if (consumed?.delete(msg.message_id)) {
    if (consumed.size === 0) consumedByJoin.delete(key)
    return Promise.resolve()
  }
  return handleMessage(msg)
}

// mirrors cancel/continue/join: chatId is re-derived from the button's own message, not trusted from callback_data
async function handleConfigCallbackQuery(cq, { field, value }) {
  const chatId = String(cq.message?.chat?.id ?? '')
  const key = threadKey(chatId, cq.message)
  if (!isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized', show_alert: true }).catch(() => {})
    return
  }
  if (!isValidModelConfigValue(field, value)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'unknown option' }).catch(() => {})
    return
  }
  if (field === 'auth') {
    const unmet = AUTH_MODE_PREREQUISITES[value]()
    if (unmet) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: unmet, show_alert: true }).catch(() => {})
      return
    }
    if (currentAuthMode() === value) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'already active' }).catch(() => {})
      return
    }
    saveGlobalAuthMode(authModeFile, value)
    // every other thread's pin refreshes fire-and-forget, but this chat's own tapped keyboard is awaited so its ✅ moves before the toast does
    for (const otherKey of Object.keys(state.configPinMessages)) {
      if (otherKey !== key) syncConfigPin(otherKey)
    }
    await syncConfigPin(key)
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'connection switched' }).catch(() => {})
    return
  }
  state.modelConfig = setModelConfigField(state.modelConfig, key, field, value)
  saveState(state)
  await syncConfigPin(key)
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'updated' }).catch(() => {})
}

// cancel/join interrupt the run at chatQueue's head directly; continue starts a new run, so it's queued like any other message
async function handleCallbackQuery(cq) {
  const configParsed = parseConfigCallbackData(cq.data)
  if (configParsed) {
    await handleConfigCallbackQuery(cq, configParsed)
    return
  }

  const parsed = parseCallbackData(cq.data)
  if (!parsed) {
    const chatId = String(cq.message?.chat?.id ?? '')
    const key = threadKey(chatId, cq.message)
    await handleUnrecognizedCallback(cq, {
      chatId,
      buttonsLoader: loadButtonsModule,
      tg,
      isAuthorized: isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig),
      enqueueMessage: msg => chatQueue.enqueue(key, () => handleMessage(msg)).catch(e => log('queued button-tap handleMessage rejected', e)),
      log,
    })
    return
  }

  // derived from the button's own message, not the callback_data payload, so a chat can only cancel/continue/join/listen its own run
  const chatId = String(cq.message?.chat?.id ?? '')
  const key = threadKey(chatId, cq.message)
  const threadId = resolveThreadId(cq.message)
  if (!isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized', show_alert: true }).catch(() => {})
    return
  }

  if (parsed.action === 'listen') {
    const messageId = cq.message?.message_id
    const listenGuardKey = `${chatId}:${messageId}`
    if (listenInFlight.has(listenGuardKey)) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'already generating…' }).catch(() => {})
      return
    }
    listenInFlight.add(listenGuardKey)
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '🎵 генерация…' }).catch(() => {})
    // queued behind this key's own in-flight turn, so trackBotMessages below always finds that turn's appendTurn record already in place
    chatQueue
      .enqueue(key, async () => {
        try {
          await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
          let statusId = null
          try {
            const sent = await tg('sendMessage', {
              chat_id: chatId,
              text: '🎵 Генерация…',
              reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
              ...threadIdParam(threadId),
            })
            statusId = sent.message_id
            trackBotMessages(key, [statusId], messageId)
          } catch (e) {
            log('listen status message failed', e.message)
            await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: buildListenKeyboard(chatId) }).catch(() => {})
            await tg('sendMessage', {
              chat_id: chatId,
              text: `⚠️ не получилось озвучить: ${e.message}`,
              reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
              ...threadIdParam(threadId),
            }).catch(() => {})
            return
          }
          // vocalizes only the bubble the button is on, not the full turn — a multi-chunk reply's button only ever lives on its last chunk
          const { ok, messageIds, error } = await sendVoiceReply(chatId, cq.message?.text ?? '', messageId, threadId, { alreadyPlain: true })
          if (ok) {
            trackBotMessages(key, messageIds, messageId)
            await tg('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {})
          } else {
            await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: buildListenKeyboard(chatId) }).catch(() => {})
            await tg('editMessageText', { chat_id: chatId, message_id: statusId, text: `⚠️ не получилось озвучить: ${error || 'unknown error'}` }).catch(() => {})
          }
        } finally {
          listenInFlight.delete(listenGuardKey)
        }
      })
      .catch(e => log('queued listen handling rejected', e))
    return
  }

  if (parsed.action === 'cancel' || parsed.action === 'join') {
    const run = activeRuns.get(key)
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
      handleJoinTap(chatId, key, run)
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'joining…' }).catch(() => {})
      return
    }
    run.cancel()
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'cancelling…' }).catch(() => {})
    return
  }

  // action === 'continue'
  const pending = state.pendingContinue[key]
  if (!pending) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'nothing to continue' }).catch(() => {})
    return
  }
  delete state.pendingContinue[key]
  saveState(state)
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'continuing…' }).catch(() => {})
  chatQueue.enqueue(key, () => handleContinue(chatId, key, threadId, pending)).catch(e => log('queued handleContinue rejected', e))
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
          const key = threadKey(chatId, u.message)
          const activeRun = activeRuns.get(key)
          if (activeRun && isAuthorizedMessage(u.message) && isJoinableMessage(u.message, botIdentity.username)) {
            addPendingJoinMessage(chatId, key, activeRun, u.message).catch(e => log('failed to track pending join message', e.message))
          }
          chatQueue.enqueue(key, () => runQueuedMessage(key, u.message)).catch(e => log('queued handleMessage rejected', e))
        } else if (u.edited_message) {
          const chatId = String(u.edited_message.chat.id)
          const key = threadKey(chatId, u.edited_message)
          if (isAuthorizedMessage(u.edited_message)) {
            // whatever is running now can only be this turn or a later one, and the rewind
            // is about to erase both — so stop it before it burns more tokens
            activeRuns.get(key)?.cancel()
            chatQueue
              .enqueue(key, () => handleEditedMessage(u.edited_message))
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

// Job logs are deliberately pruned only here (tied to their own finished record aging out), never by the generic mtime-based sweep below, since a quiet-but-still-running job's log would otherwise get deleted out from under it.
function pruneOldJobRecords() {
  const cutoff = Date.now() - RETENTION_SWEEP_MAX_AGE_MS
  let changed = false
  for (const [jobId, record] of Object.entries(state.jobs)) {
    if (!isJobActive(record) && record.reported && record.finishedAt != null && record.finishedAt < cutoff) {
      delete state.jobs[jobId]
      rmSync(record.logPath, { force: true })
      changed = true
    }
  }
  if (changed) saveState(state)
}

function sweepStateDirectories() {
  const retentionDays = config.retentionDays ?? 14
  const namespacedDirs = [inboxDir, tmpDir, outboxDir, rewindBackupDir]
  for (const dir of namespacedDirs) {
    const { removed } = sweepOldFiles(dir, RETENTION_SWEEP_MAX_AGE_MS)
    if (removed.length) log('retention sweep removed', removed.length, `file(s) older than ${retentionDays}d from`, dir)
  }
  // Shallow only: cleans up pre-migration flat files at the shared parent without touching a sibling bot's own subtree.
  for (const dir of namespacedDirs.map(d => path.dirname(d))) {
    const { removed } = sweepOldFiles(dir, RETENTION_SWEEP_MAX_AGE_MS, undefined, { recurse: false })
    if (removed.length) log('retention sweep removed', removed.length, `legacy flat file(s) older than ${retentionDays}d from`, dir)
  }
  pruneOldJobRecords()
}

// One-time: seeds the new global file from old per-chat state.authMode data (existsSync is just a fast-path skip, not the race guard).
function migrateLegacyAuthModeIfNeeded() {
  if (existsSync(authModeFile)) return
  const mode = deriveLegacyAuthMode(collectLegacyAuthModeValues(stateDir))
  if (seedGlobalAuthModeIfMissing(authModeFile, mode)) log('migrated legacy per-chat auth mode to global:', mode)
}

process.on('unhandledRejection', e => log('unhandled rejection', e))
migrateLegacyAuthModeIfNeeded()
sweepStateDirectories()
setInterval(sweepStateDirectories, RETENTION_SWEEP_INTERVAL_MS)
reconcileJobsOnBootAndReport()
sweepJobs().catch(e => log('sweepJobs failed', e.message))
setInterval(() => sweepJobs().catch(e => log('sweepJobs failed', e.message)), JOB_SWEEP_INTERVAL_MS)
poll()
