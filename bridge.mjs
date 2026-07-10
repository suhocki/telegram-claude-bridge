#!/usr/bin/env node
// Standalone Telegram <-> Claude Code bridge. Does NOT use `claude --channels`
// (blocked by org policy on the enterprise account) — just polls the Telegram
// Bot API directly and shells out to `claude -p --resume <session>` per message.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
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
} from './lib.mjs'
import { markdownToTelegramHtmlChunks, htmlToPlainFallback } from './markdown-html.mjs'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node bridge.mjs <config.json>')
  process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const { botToken, cwd, allowedUserIds, appendSystemPrompt, claudeArgs, costWarnUsd } = config
const stateFile = path.resolve(path.dirname(configPath), config.stateFile ?? 'state.json')
const stateDir = path.dirname(stateFile)
const inboxDir = path.join(stateDir, 'inbox')
const API = `https://api.telegram.org/bot${botToken}`

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function loadState() {
  if (!existsSync(stateFile)) return { offset: 0, sessions: {}, pendingRisky: {} }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.pendingRisky ??= {}
    return state
  } catch {
    return { offset: 0, sessions: {}, pendingRisky: {} }
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

function runClaude(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
    if (sessionId) args.push('--resume', sessionId)
    args.push(
      '--append-system-prompt',
      combineSystemPrompts(buildOutboundAttachmentInstructions(), buildReactionMarkerInstructions(), appendSystemPrompt)
    )
    if (Array.isArray(claudeArgs)) args.push(...claudeArgs)

    const child = spawn('claude', args, { cwd, env: process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      if (!out.trim()) return reject(new Error(err || `claude exited ${code} with no output`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(new Error(`bad JSON from claude: ${e.message}\n${out}\n${err}`))
      }
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

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  const userId = String(msg.from?.id ?? '')
  if (!allowedUserIds.includes(userId)) {
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

  await setReaction(chatId, msg.message_id, RECEIPT_REACTION)

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

  let typingAlive = true
  const typing = setInterval(() => {
    if (typingAlive) tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }, 4000)
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

  let placeholderId = null
  try {
    const placeholder = await tg('sendMessage', {
      chat_id: chatId,
      text: '⏳ working…',
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    })
    placeholderId = placeholder.message_id
  } catch (e) {
    log('failed to send working placeholder', e.message)
  }

  let attachmentResult = null
  if (attachment) {
    attachmentResult = await downloadAttachment(attachment)
    if (attachmentResult.error) log('attachment download failed', attachment.kind, attachmentResult.error)
  }
  const attachmentAttrs = attachment
    ? {
        attachment_kind: attachment.kind,
        attachment_name: attachment.name,
        attachment_mime: attachment.mime,
        attachment_path: attachmentResult?.path,
        attachment_error: attachmentResult?.error,
      }
    : {}

  const prompt =
    command === 'compact'
      ? content
      : buildChannelPrompt(chatId, meta.messageId, meta.user, meta.ts, promptText, attachmentAttrs)

  try {
    const result = await runClaude(prompt, sessionId)
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
    await sendReply(chatId, replyText, msg.message_id, placeholderId)
    if (!result.is_error) {
      for (const attachPath of attachPaths) {
        await sendAttachment(chatId, attachPath, msg.message_id)
      }
    }
    await setReaction(chatId, msg.message_id, reactionEmoji || (result.is_error ? ERROR_REACTION : SUCCESS_REACTION))
  } catch (e) {
    log('handleMessage error', e)
    await sendReply(chatId, `⚠️ bridge error: ${e.message}`, msg.message_id, placeholderId).catch(() => {})
    await setReaction(chatId, msg.message_id, ERROR_REACTION)
  } finally {
    typingAlive = false
    clearInterval(typing)
  }
}

async function poll() {
  log('bridge started, cwd=', cwd, 'offset=', state.offset)
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
