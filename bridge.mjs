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
  extractAttachmentMarkers,
  pickOutboundSendMethod,
  assertSendablePath,
  buildOutboundAttachmentInstructions,
  combineSystemPrompts,
  buildReplyCallsFromChunks,
  extractReactionMarker,
  buildReactionMarkerInstructions,
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
  shouldHandleGroupMessage,
  buildBotIdentity,
} from './lib.mjs'
import { markdownToTelegramHtmlChunks, htmlToPlainFallback } from './markdown-html.mjs'
import {
  DEFAULT_WORKING_STATUS,
  createLineSplitter,
  parseJsonlLine,
  isResultEvent,
  createProgressTracker,
  formatRunOutcomeStatus,
  createStatusUpdater,
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
  if (!existsSync(stateFile)) return { offset: 0, sessions: {}, pendingRisky: {}, voiceReply: {} }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.pendingRisky ??= {}
    state.voiceReply ??= {}
    return state
  } catch {
    return { offset: 0, sessions: {}, pendingRisky: {}, voiceReply: {} }
  }
}

function saveState(state) {
  const tmp = stateFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  writeFileSync(stateFile, readFileSync(tmp))
}

const state = loadState()
const chatQueue = createKeyedQueue()

async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`)
  return data.result
}

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
    const res = await fetch(`${API}/${method}`, { method: 'POST', body: form })
    const data = await res.json()
    if (!data.ok) throw new Error(data.description)
  } catch (e) {
    log('sendAttachment failed', filePath, e.message)
    await sendReply(chatId, `⚠️ failed to send attachment ${path.basename(filePath)}: ${e.message}`, replyToMessageId).catch(() => {})
  }
}

function runClaude(prompt, sessionId, onEvent) {
  return new Promise((resolve, reject) => {
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
      combineSystemPrompts(buildOutboundAttachmentInstructions(), buildReactionMarkerInstructions(), appendSystemPrompt)
    )
    if (Array.isArray(claudeArgs)) args.push(...claudeArgs)

    const child = spawn('claude', args, { cwd, env: process.env })
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
          try {
            onEvent(event)
          } catch (e) {
            log('progress onEvent handler failed', e.message)
          }
        }
      }
    })
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      if (result) return resolve(result)
      reject(new Error(err || `claude exited ${code} with no result event\n${stdoutTail}`))
    })
  })
}

async function downloadAttachment(attachment) {
  if (exceedsAttachmentLimit(attachment.size)) {
    return { error: `attachment is ${attachment.size} bytes, over Telegram's ${MAX_ATTACHMENT_BYTES} byte bot-download cap` }
  }
  try {
    const file = await tg('getFile', { file_id: attachment.fileId })
    if (!file.file_path) return { error: 'Telegram returned no file_path for this attachment' }
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`)
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
    const res = await fetch(url, { method: 'POST', headers, body })
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
    const sendRes = await fetch(`${API}/sendVoice`, { method: 'POST', body: form })
    const data = await sendRes.json()
    if (!data.ok) throw new Error(data.description)
  } catch (e) {
    log('sendVoiceReply failed', e.message)
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
    })
    placeholderId = placeholder.message_id
  } catch (e) {
    log('failed to send working placeholder', e.message)
  }

  let transcriptQuoteHtml = null
  const progress = createProgressTracker()
  const statusUpdater = createStatusUpdater({
    getStatus: () => progress.current(),
    onUpdate: latestStatus => {
      if (placeholderId == null) return
      tg('editMessageText', buildPlaceholderEditParams(chatId, placeholderId, latestStatus, transcriptQuoteHtml)).catch(() => {})
    },
  })
  const stopStatusUpdates = async finalStatus => {
    statusUpdater.stop()
    if (placeholderId == null) return
    await tg('editMessageText', buildPlaceholderEditParams(chatId, placeholderId, finalStatus, transcriptQuoteHtml)).catch(() => {})
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
      if (transcriptQuoteHtml && placeholderId != null) {
        await tg(
          'editMessageText',
          buildPlaceholderEditParams(chatId, placeholderId, progress.current(), transcriptQuoteHtml)
        ).catch(e => log('failed to attach transcript quote to placeholder', e.message))
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

  const prompt =
    command === 'compact'
      ? content
      : buildChannelPrompt(chatId, meta.messageId, meta.user, meta.ts, promptText, attachmentAttrs)

  try {
    const result = await runClaude(prompt, sessionId, event => progress.ingest(event))
    await stopStatusUpdates(formatRunOutcomeStatus(result.is_error))
    let newSession = session
    if (result.session_id) {
      newSession = accumulateSessionCost(session, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    const { text: withoutAttach, paths: attachPaths } = extractAttachmentMarkers(result.result)
    const { text: cleanedResult, emoji: reactionEmoji } = extractReactionMarker(withoutAttach)
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
    }
    await setReaction(chatId, msg.message_id, reactionEmoji || (result.is_error ? ERROR_REACTION : SUCCESS_REACTION))
  } catch (e) {
    log('handleMessage error', e)
    statusUpdater.stop()
    await sendReply(chatId, `⚠️ bridge error: ${e.message}`, msg.message_id, placeholderId).catch(() => {})
    await setReaction(chatId, msg.message_id, ERROR_REACTION)
  } finally {
    typingAlive = false
    clearInterval(typing)
    statusUpdater.stop()
  }
}

let botIdentity = { id: null, username: null }

async function poll() {
  try {
    botIdentity = buildBotIdentity(await tg('getMe', {}))
  } catch (e) {
    log('getMe failed, group mention-gating will not resolve @mentions or reply-to-bot', e.message)
  }
  log('bridge started, cwd=', cwd, 'offset=', state.offset, 'bot=', botIdentity.username)
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 30 })
      for (const u of updates) {
        state.offset = u.update_id + 1
        saveState(state)
        if (u.message) {
          const chatId = String(u.message.chat.id)
          chatQueue.enqueue(chatId, () => handleMessage(u.message)).catch(e => log('queued handleMessage rejected', e))
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
