#!/usr/bin/env node
// Standalone Telegram <-> Claude Code bridge. Does NOT use `claude --channels`
// (blocked by org policy on the enterprise account) — just polls the Telegram
// Bot API directly and shells out to `claude -p --resume <session>` per message.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  buildSendMessageCalls,
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
} from './lib.mjs'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node bridge.mjs <config.json>')
  process.exit(1)
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const { botToken, cwd, allowedUserIds, appendSystemPrompt, claudeArgs, costWarnUsd } = config
const stateFile = path.resolve(path.dirname(configPath), config.stateFile ?? 'state.json')
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

async function sendReply(chatId, text, replyToMessageId) {
  for (const params of buildSendMessageCalls(chatId, text || '(empty response)', replyToMessageId)) {
    await tg('sendMessage', params)
  }
}

function runClaude(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
    if (sessionId) args.push('--resume', sessionId)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
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

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  const userId = String(msg.from?.id ?? '')
  if (!allowedUserIds.includes(userId)) {
    log('dropped message from non-allowed user', userId)
    return
  }
  const text = msg.text
  if (!text) {
    await sendReply(chatId, '(bridge v1 only handles text messages — attachments not supported yet)', msg.message_id).catch(() => {})
    return
  }

  const command = classifyCommand(text)

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

  let promptText = text
  if (command === null) {
    const decision = evaluateRiskyGuard(text, state.pendingRisky[chatId])
    if (decision.action === 'needsConfirmation') {
      state.pendingRisky[chatId] = { text: decision.text }
      saveState(state)
      await sendReply(chatId, buildRiskyCommandWarning(decision.match), msg.message_id).catch(() => {})
      return
    }
    if (state.pendingRisky[chatId]) {
      delete state.pendingRisky[chatId]
      saveState(state)
    }
    promptText = decision.text
  }

  let typingAlive = true
  const typing = setInterval(() => {
    if (typingAlive) tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }, 4000)
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

  const user = sanitizeAttr(msg.from?.username ?? userId)
  const ts = new Date((msg.date ?? 0) * 1000).toISOString()
  const prompt = command === 'compact' ? text : buildChannelPrompt(chatId, msg.message_id, user, ts, promptText)

  try {
    const result = await runClaude(prompt, sessionId)
    let newSession = session
    if (result.session_id) {
      newSession = accumulateSessionCost(session, result.session_id, result.total_cost_usd)
      state.sessions[chatId] = newSession
      saveState(state)
    }
    let replyText = result.is_error
      ? `⚠️ ${result.result ?? 'error'}`
      : command === 'compact'
        ? `✅ conversation compacted.${result.result ? `\n\n${result.result}` : ''}`
        : (result.result ?? '(empty response)')
    if (newSession && crossedCostThreshold(session?.costUsd ?? 0, newSession.costUsd, costWarnUsd)) {
      replyText = `${buildCostWarning(newSession.costUsd, costWarnUsd)}\n\n${replyText}`
    }
    await sendReply(chatId, replyText, msg.message_id)
  } catch (e) {
    log('handleMessage error', e)
    await sendReply(chatId, `⚠️ bridge error: ${e.message}`, msg.message_id).catch(() => {})
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
