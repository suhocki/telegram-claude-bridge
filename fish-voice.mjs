import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './lib.mjs'

// The path is chosen by the caller (typically the shared state/ dir every bot config resolves to), so this same file is read/written by every bot. No entry means "use the hardcoded default" — this is a new optional override, not a forced migration.
export function loadGlobalFishVoice(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    if (raw && typeof raw.id === 'string' && typeof raw.title === 'string') return raw
    return null
  } catch {
    return null
  }
}

export function saveGlobalFishVoice(filePath, { id, title }) {
  atomicWriteFileSync(filePath, JSON.stringify({ id, title }))
}
