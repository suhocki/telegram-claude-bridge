#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { validateNotifyConfig, resolveNotifyChatId, pickNotifyText, buildSendMessageCallsFromChunks, createTelegramClient } from './lib.mjs'
import { markdownToTelegramHtmlChunks, htmlToPlainFallback } from './markdown-html.mjs'

const [configPath, textArg, chatIdArg] = process.argv.slice(2)
if (!configPath) {
  console.error(
    'usage: node notify.mjs <config.json> [text] [chatId]\n' +
      '  reuses the botToken from <config.json> (same file bridge.mjs runs with).\n' +
      '  target chat defaults to config.notifyChatId, then config.allowedUserIds[0].\n' +
      '  if [text] is omitted, it is read from stdin.'
  )
  process.exit(1)
}

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (e) {
  console.error(`failed to read config ${configPath}: ${e.message}`)
  process.exit(1)
}

const configError = validateNotifyConfig(config)
if (configError) {
  console.error(configError)
  process.exit(1)
}

function readStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const text = pickNotifyText(textArg, textArg && textArg.trim() ? '' : readStdin())
if (!text) {
  console.error('no text to send: pass it as an argument or pipe it on stdin')
  process.exit(1)
}

const chatId = resolveNotifyChatId(config, chatIdArg)
if (!chatId) {
  console.error('no chat id: pass it as the 3rd argument, or set "notifyChatId" (or "allowedUserIds") in the config')
  process.exit(1)
}

const API = `https://api.telegram.org/bot${config.botToken}`

const tg = createTelegramClient(API)

async function main() {
  const chunks = markdownToTelegramHtmlChunks(text)
  for (const params of buildSendMessageCallsFromChunks(chatId, chunks, null, 'HTML')) {
    try {
      await tg('sendMessage', params)
    } catch (e) {
      console.error('sendMessage failed, retrying as plain text', e.message)
      const { parse_mode, ...plainParams } = params
      await tg('sendMessage', { ...plainParams, text: htmlToPlainFallback(params.text) })
    }
  }
}

main().catch(e => {
  console.error('notify failed', e.message)
  process.exit(1)
})
