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
