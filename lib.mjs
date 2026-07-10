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
      params.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true }
    }
    return params
  })
}

export function classifyCommand(text) {
  const t = String(text ?? '').trim()
  if (t === '/new' || t === '/reset') return 'reset'
  if (t === '/compact') return 'compact'
  if (t === '/status') return 'status'
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

export function buildChannelPrompt(chatId, messageId, user, ts, text) {
  return `<channel source="telegram" chat_id="${chatId}" message_id="${messageId}" user="${user}" ts="${ts}">\n${text}\n</channel>`
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
