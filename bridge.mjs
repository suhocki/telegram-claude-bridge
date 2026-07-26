#!/usr/bin/env node
// Standalone Telegram <-> Claude Code bridge. Does NOT use `claude --channels`
// (blocked by org policy on the enterprise account) — just polls the Telegram
// Bot API directly and shells out to `claude -p --resume <session>` per message.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
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
  buildAttachmentCaption,
  exceedsAttachmentLimit,
  buildInboxFilename,
  MAX_ATTACHMENT_BYTES,
  pickOutboundSendMethod,
  assertSendablePath,
  buildOutboundAttachmentInstructions,
  combineSystemPrompts,
  buildReplyCallsFromChunks,
  buildReactionMarkerInstructions,
  buildCheckinMarkerInstructions,
  buildCheckinFollowupPrompt,
  extractResponseMarkers,
  checkinChainExceeded,
  CHECKIN_MAX_CHAINED_HOPS,
  buildSetMessageReactionParams,
  RECEIPT_REACTION,
  SUCCESS_REACTION,
  ERROR_REACTION,
  expandHome,
  DEFAULT_WHISPER_BIN,
  DEFAULT_WHISPER_MODEL_PATH,
  DEFAULT_WHISPER_LANGUAGE,
  buildFfmpegConvertArgs,
  buildWhisperArgs,
  parseWhisperTranscript,
  buildVoiceTranscriptText,
  buildTranscriptQuoteHtml,
  buildPlaceholderEditParams,
  computeStreamingTextLimit,
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
  shouldHandleGroupMessage,
  buildBotIdentity,
  createTelegramClient,
  fetchWithTimeout,
} from './lib.mjs'
import { markdownToTelegramHtmlChunks, htmlToPlainFallback, renderTranscriptHtml } from './markdown-html.mjs'
import {
  DEFAULT_WORKING_STATUS,
  createLineSplitter,
  parseJsonlLine,
  isResultEvent,
  createProgressTracker,
  formatRunOutcomeStatus,
  createStatusUpdater,
  createChatRateGate,
  extractNewSubagentBlocks,
  extractFinishedSubagentIds,
} from './stream-progress.mjs'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node bridge.mjs <config.json>')
  process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const { botToken, cwd, allowedUserIds, appendSystemPrompt, claudeArgs, costWarnUsd, groups } = config
const groupsConfig = groups ?? {}
const stateFile = path.resolve(path.dirname(configPath), config.stateFile ?? 'state.json')
const stateDir = path.dirname(stateFile)
const inboxDir = path.join(stateDir, 'inbox')
const tmpDir = path.join(stateDir, 'tmp')
const outboxDir = path.join(stateDir, 'outbox')
const API = `https://api.telegram.org/bot${botToken}`
const GET_UPDATES_POLL_TIMEOUT_S = 30
const GET_UPDATES_FETCH_TIMEOUT_MS = 50000
const FILE_TRANSFER_TIMEOUT_MS = 60000
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

function loadState() {
  if (!existsSync(stateFile)) return { offset: 0, sessions: {}, pendingRisky: {}, voiceReply: {}, pendingCheckins: {} }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.pendingRisky ??= {}
    state.voiceReply ??= {}
    state.pendingCheckins ??= {}
    return state
  } catch {
    return { offset: 0, sessions: {}, pendingRisky: {}, voiceReply: {}, pendingCheckins: {} }
  }
}

function saveState(state) {
  const tmp = stateFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  writeFileSync(stateFile, readFileSync(tmp))
}

const state = loadState()
const chatQueue = createKeyedQueue()
// chatId -> { cancel() }; only ever one entry per chat since handleMessage runs one at
// a time per chat via chatQueue, populated for the duration of that run's runClaude call
const activeRuns = new Map()
// setTimeout handles can't be persisted, so state.pendingCheckins is re-armed into this Map on every boot.
const checkinTimers = new Map()
for (const chatId of Object.keys(state.pendingCheckins)) armCheckinTimer(chatId)

const tg = createTelegramClient(API)

async function sendReply(chatId, text, replyToMessageId, editMessageId) {
  const chunks = markdownToTelegramHtmlChunks(text || '(empty response)')
  for (const { method, params } of buildReplyCallsFromChunks(chatId, chunks, replyToMessageId, 'HTML', editMessageId)) {
    try {
      await tg(method, params)
    } catch (e) {
      log(`${method} failed, retrying as plain text`, e.message)
      const { parse_mode, ...plainParams } = params
      await tg(method, { ...plainParams, text: htmlToPlainFallback(params.text) })
    }
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
    await sendReply(chatId, `⚠️ ${guard.error}`, replyToMessageId).catch(() => {})
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    await sendReply(chatId, `⚠️ attachment not found: ${filePath}`, replyToMessageId).catch(() => {})
    return
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
  } catch (e) {
    log('sendAttachment failed', filePath, e.message)
    await sendReply(chatId, `⚠️ failed to send attachment ${path.basename(filePath)}: ${e.message}`, replyToMessageId).catch(() => {})
  }
}

const CANCEL_SIGKILL_GRACE_MS = 3000

// Returns { promise, cancel } instead of a plain Promise so a caller can kill the run
// early (e.g. a Telegram "Cancel" button) without waiting for it to finish on its own.
function runClaude(prompt, sessionId, onEvent) {
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
      appendSystemPrompt
    )
  )
  if (Array.isArray(claudeArgs)) args.push(...claudeArgs)

  // detached so `child.pid` is its own process-group leader: killing -child.pid kills
  // the whole tree (claude itself plus any Bash-spawned OS subprocesses), not just claude
  const child = spawn('claude', args, { cwd, env: process.env, detached: true })
  const pushChunk = createLineSplitter()
  let result = null
  let err = ''
  let stdoutTail = ''
  child.stdout.on('data', d => {
    const text = d.toString()
    stdoutTail = (stdoutTail + text).slice(-2000)
    for (const line of pushChunk(text)) {
      const event = parseJsonlLine(line)
      if (!event) continue
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

  return { promise, cancel }
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
    const { promise: checkinPromise } = runClaude(buildCheckinFollowupPrompt(pending.instruction), sessionId)
    const result = await checkinPromise
    let newSession = normalizeSession(state.sessions[chatId])
    if (result.session_id) {
      newSession = accumulateSessionCost(newSession, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    const { text: cleanedResult, attachPaths, checkin: nextCheckin } = extractResponseMarkers(result.result)
    const replyText = result.is_error ? `⚠️ ${cleanedResult || 'check-in error'}` : cleanedResult || '(empty check-in response)'
    await sendReply(chatId, replyText)
    if (!result.is_error) {
      for (const attachPath of attachPaths) {
        await sendAttachment(chatId, attachPath)
      }
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

async function sendVoiceReply(chatId, text, replyToMessageId) {
  const speechText = truncateForSpeech(buildSpeechText(text), voiceReplyConfig.maxTtsChars)
  if (!speechText) return
  let apiKey
  try {
    apiKey = readFileSync(expandHome(voiceReplyConfig.apiKeyPath, homedir()), 'utf8').trim()
  } catch {
    log('voice reply skipped: no TTS api key at', voiceReplyConfig.apiKeyPath)
    return
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
  } catch (e) {
    log('sendVoiceReply failed', e.message)
  }
}

// Drives one Telegram message's live "⏳ working…" placeholder: a progress tracker plus
// the periodic editMessageText loop that renders it. Used both for the root placeholder
// of a run and for each parallel subagent (Agent tool) placeholder spawned during it.
function createPlaceholderController(chatId, initialMessageId, getQuoteHtml = () => null, sharedGate = null) {
  let messageId = initialMessageId
  const tracker = createProgressTracker(DEFAULT_WORKING_STATUS, {
    renderTranscript: (historyLines, liveText) =>
      renderTranscriptHtml(historyLines, liveText, computeStreamingTextLimit(getQuoteHtml())),
  })

  async function editPlaceholder({ text, html }) {
    if (messageId == null) return
    const params = buildPlaceholderEditParams(chatId, messageId, text, getQuoteHtml(), html)
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
      await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: htmlToPlainFallback(params.text) }).catch(e2 =>
        log('editMessageText fallback failed', e2.message)
      )
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
    async stop(finalStatus) {
      statusUpdater.stop()
      if (finalStatus !== undefined) await editPlaceholder({ text: finalStatus, html: false })
    },
  }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  const userId = String(msg.from?.id ?? '')
  if (isGroupChatType(msg.chat.type)) {
    const policy = resolveGroupPolicy(groupsConfig, chatId)
    if (!shouldHandleGroupMessage(msg, policy, botIdentity.username, botIdentity.id)) {
      log('dropped group message', chatId, 'policy not satisfied for user', userId)
      return
    }
  } else if (!allowedUserIds.includes(userId)) {
    log('dropped message from non-allowed user', userId)
    return
  }
  const attachment = extractAttachment(msg)
  const content = msg.text ?? msg.caption ?? null
  if (content == null && !attachment) {
    await sendReply(
      chatId,
      '(bridge v1 only handles text messages, photos, documents, voice, audio, and video — this message type is not supported yet)',
      msg.message_id
    ).catch(() => {})
    return
  }

  const voiceToggle = parseVoiceToggleCommand(content)
  if (voiceToggle) {
    state.voiceReply = setVoiceReplyPreference(state.voiceReply, chatId, voiceToggle === 'on')
    saveState(state)
    await sendReply(chatId, buildVoiceToggleReply(voiceToggle === 'on'), msg.message_id).catch(() => {})
    return
  }

  const command = classifyCommand(content)

  if (command === 'reset') {
    delete state.sessions[chatId]
    delete state.pendingRisky[chatId]
    cancelCheckin(chatId)
    saveState(state)
    await sendReply(chatId, '🔄 session reset — the next message starts a brand new conversation.', msg.message_id).catch(() => {})
    return
  }

  const session = normalizeSession(state.sessions[chatId])
  const sessionId = session?.id

  if (command === 'status') {
    await sendReply(chatId, formatStatusText(session), msg.message_id).catch(() => {})
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

  let typingAlive = true
  const typing = setInterval(() => {
    if (typingAlive) tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }, 4000)
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

  let placeholderId = null
  try {
    const placeholder = await tg('sendMessage', {
      chat_id: chatId,
      text: DEFAULT_WORKING_STATUS,
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: '🚫 Cancel', callback_data: `cancel:${chatId}` }]] },
    })
    placeholderId = placeholder.message_id
  } catch (e) {
    log('failed to send working placeholder', e.message)
  }

  let transcriptQuoteHtml = null
  // shared by root + every subagent placeholder below, so a 429 on any one of them
  // backs off every concurrent edit loop writing to this same chat
  const chatRateGate = createChatRateGate()
  const rootController = createPlaceholderController(chatId, placeholderId, () => transcriptQuoteHtml, chatRateGate)

  // one placeholder message per parallel subagent (Agent tool call), keyed by that
  // tool_use's id; created when it starts, deleted once its tool_result comes back
  const subagentControllers = new Map()

  async function routeEvent(event) {
    const parentId = event?.parent_tool_use_id ?? null
    const parentEntry = parentId ? subagentControllers.get(parentId) : null
    ;(parentEntry ? parentEntry.controller : rootController).ingest(event)

    for (const block of extractNewSubagentBlocks(event, subagentControllers)) {
      const controller = createPlaceholderController(chatId, null, undefined, chatRateGate)
      const messageIdPromise = tg('sendMessage', {
        chat_id: chatId,
        text: DEFAULT_WORKING_STATUS,
        ...(placeholderId != null ? { reply_parameters: { message_id: placeholderId, allow_sending_without_reply: true } } : {}),
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

  let attachmentResult = null
  if (attachment) {
    attachmentResult = await downloadAttachment(attachment)
    if (attachmentResult.error) log('attachment download failed', attachment.kind, attachmentResult.error)
  }

  let transcriptionError = null
  if (attachment?.kind === 'voice' && attachmentResult?.path) {
    const transcription = await transcribeVoice(attachmentResult.path)
    if (transcription.error) {
      transcriptionError = transcription.error
      log('voice transcription failed', transcriptionError)
    } else {
      promptText = buildVoiceTranscriptText(transcription.text)
      transcriptQuoteHtml = buildTranscriptQuoteHtml(transcription.text)
      if (transcriptQuoteHtml) rootController.editPlaceholder(rootController.tracker.snapshot())
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

  const prompt =
    command === 'compact'
      ? content
      : buildChannelPrompt(chatId, meta.messageId, meta.user, meta.ts, promptText, attachmentAttrs)

  let cancelled = false
  try {
    const { promise: claudePromise, cancel: cancelClaude } = runClaude(prompt, sessionId, event => routeEvent(event))
    activeRuns.set(chatId, {
      cancel() {
        if (cancelled) return
        cancelled = true
        cancelClaude()
      },
    })
    const result = await claudePromise
    await rootController.stop(formatRunOutcomeStatus(result.is_error))
    let newSession = session
    if (result.session_id) {
      newSession = accumulateSessionCost(session, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    const { text: cleanedResult, attachPaths, reactionEmoji, checkin } = extractResponseMarkers(result.result)
    let replyText = result.is_error
      ? `⚠️ ${cleanedResult || 'error'}`
      : command === 'compact'
        ? `✅ conversation compacted.${cleanedResult ? `\n\n${cleanedResult}` : ''}`
        : (cleanedResult || '(empty response)')
    if (newSession && crossedCostThreshold(session?.costUsd ?? 0, newSession.costUsd, costWarnUsd)) {
      replyText = `${buildCostWarning(newSession.costUsd, costWarnUsd)}\n\n${replyText}`
    }
    // new message, not an edit of the placeholder, so Telegram pushes a notification
    await sendReply(chatId, replyText, msg.message_id)
    if (!result.is_error) {
      for (const attachPath of attachPaths) {
        await sendAttachment(chatId, attachPath, msg.message_id)
      }
      if (isVoiceReplyEnabled(state.voiceReply, chatId)) {
        await sendVoiceReply(chatId, cleanedResult, msg.message_id)
      }
      if (checkin) scheduleCheckin(chatId, newSession?.id ?? sessionId, checkin)
    }
    await setReaction(chatId, msg.message_id, reactionEmoji || (result.is_error ? ERROR_REACTION : SUCCESS_REACTION))
  } catch (e) {
    rootController.statusUpdater.stop()
    if (cancelled) {
      await sendReply(chatId, '🚫 cancelled', msg.message_id, placeholderId).catch(() => {})
    } else {
      log('handleMessage error', e)
      await sendReply(chatId, `⚠️ bridge error: ${e.message}`, msg.message_id, placeholderId).catch(() => {})
      await setReaction(chatId, msg.message_id, ERROR_REACTION)
    }
  } finally {
    typingAlive = false
    clearInterval(typing)
    rootController.statusUpdater.stop()
    activeRuns.delete(chatId)
    if (placeholderId != null) {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: placeholderId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
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
}

let botIdentity = { id: null, username: null }

// Handled directly, not via chatQueue: a cancel needs to interrupt the run that's
// already sitting at the head of that same chat's queue, not wait behind it.
async function handleCallbackQuery(cq) {
  const data = cq.data ?? ''
  if (!data.startsWith('cancel:')) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})
    return
  }

  const chatId = String(cq.message?.chat?.id ?? '')
  if (!isCallbackQueryAuthorized(cq, allowedUserIds, groupsConfig)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized', show_alert: true }).catch(() => {})
    return
  }

  const run = activeRuns.get(chatId)
  if (!run) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'nothing to cancel' }).catch(() => {})
    return
  }

  run.cancel()
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'cancelling…' }).catch(() => {})
}

async function poll() {
  try {
    botIdentity = buildBotIdentity(await tg('getMe', {}))
  } catch (e) {
    log('getMe failed, group mention-gating will not resolve @mentions or reply-to-bot', e.message)
  }
  log('bridge started, cwd=', cwd, 'offset=', state.offset, 'bot=', botIdentity.username)
  for (;;) {
    try {
      const updates = await tg(
        'getUpdates',
        { offset: state.offset, timeout: GET_UPDATES_POLL_TIMEOUT_S },
        { timeoutMs: GET_UPDATES_FETCH_TIMEOUT_MS }
      )
      for (const u of updates) {
        state.offset = u.update_id + 1
        saveState(state)
        if (u.message) {
          const chatId = String(u.message.chat.id)
          chatQueue.enqueue(chatId, () => handleMessage(u.message)).catch(e => log('queued handleMessage rejected', e))
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
