import { readFileSync, existsSync } from 'node:fs'
import { normalizeAuthMode, atomicWriteFileSync } from './lib.mjs'

// The path is chosen by the caller (typically the shared state/ dir every bot config resolves to), so this same file is read/written by every bot.
export function loadGlobalAuthMode(filePath) {
  if (!existsSync(filePath)) return 'apikey'
  try {
    return normalizeAuthMode(JSON.parse(readFileSync(filePath, 'utf8')).mode)
  } catch {
    return 'apikey'
  }
}

export function saveGlobalAuthMode(filePath, mode) {
  atomicWriteFileSync(filePath, JSON.stringify({ mode: normalizeAuthMode(mode) }))
}
