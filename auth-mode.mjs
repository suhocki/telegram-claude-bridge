import { readFileSync } from 'node:fs'
import { normalizeAuthMode, atomicWriteFileSync } from './lib.mjs'

// The path is chosen by the caller (typically the shared state/ dir every bot config resolves to), so this same file is read/written by every bot.
export function loadGlobalAuthMode(filePath) {
  try {
    return normalizeAuthMode(readFileSync(filePath, 'utf8').trim())
  } catch {
    return 'apikey'
  }
}

export function saveGlobalAuthMode(filePath, mode) {
  atomicWriteFileSync(filePath, normalizeAuthMode(mode))
}
