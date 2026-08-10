import { readFileSync } from 'node:fs'

// Shown instead of a fancy phrase when working-phrases.json is missing, empty, or unreadable.
export const DEFAULT_WORKING_PHRASE = '⏳ работаю…'

export function loadWorkingPhrases(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(raw) ? raw.filter(p => typeof p === 'string' && p.trim() !== '') : []
  } catch {
    return []
  }
}

export function todayDateString(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

// queueState shape: { date: 'YYYY-MM-DD', remaining: string[] } | null | undefined.
// Reloads the full phrase list into `remaining` whenever the date has rolled over or the
// queue has run dry (last phrase of the day already handed out) — otherwise just pops the
// next phrase off the front so nothing repeats until the whole list has been used once.
export function pickWorkingPhrase(queueState, allPhrases, todayStr) {
  const carriedOver = queueState?.date === todayStr && Array.isArray(queueState.remaining) ? queueState.remaining : []
  const remaining = carriedOver.length > 0 ? carriedOver : [...allPhrases]
  if (remaining.length === 0) {
    return { phrase: DEFAULT_WORKING_PHRASE, nextState: { date: todayStr, remaining: [] } }
  }
  const [phrase, ...rest] = remaining
  return { phrase, nextState: { date: todayStr, remaining: rest } }
}
