// Pure, testable helpers extracted out of bridge.mjs's imperative poll loop.

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

export function buildSendMessageCalls(chatId, text, replyToMessageId, limit = 4096) {
  return chunk(text, limit).map((part, i) => {
    const params = { chat_id: chatId, text: part }
    if (i === 0 && replyToMessageId != null) {
      params.reply_parameters = { message_id: replyToMessageId }
    }
    return params
  })
}
