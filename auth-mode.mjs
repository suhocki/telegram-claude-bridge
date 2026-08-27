import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { normalizeAuthMode } from './lib.mjs'

// One file per repo checkout (path chosen by the caller, typically the shared state/ dir every
// bot config resolves to), so switching mode in any chat of any bot flips it for all of them.
export function loadGlobalAuthMode(filePath) {
  if (!existsSync(filePath)) return 'apikey'
  try {
    return normalizeAuthMode(JSON.parse(readFileSync(filePath, 'utf8')).mode)
  } catch {
    return 'apikey'
  }
}

export function saveGlobalAuthMode(filePath, mode) {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify({ mode: normalizeAuthMode(mode) }))
  renameSync(tmp, filePath)
}
