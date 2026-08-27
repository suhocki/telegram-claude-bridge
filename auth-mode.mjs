import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
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

// 'wx' is an atomic exclusive create, so a concurrent migration from another bot process racing
// against this same call can never clobber a value that already won; it just fails with EEXIST.
export function seedGlobalAuthModeIfMissing(filePath, mode) {
  try {
    writeFileSync(filePath, normalizeAuthMode(mode), { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}

// Missing/unreadable stateDir or per-bot state files just mean "nothing to migrate", not an error.
export function collectLegacyAuthModeValues(stateDir, excludeFileName) {
  let entries
  try {
    entries = readdirSync(stateDir)
  } catch {
    return []
  }
  return entries
    .filter(f => f.endsWith('.json') && f !== excludeFileName)
    .flatMap(f => {
      try {
        const raw = JSON.parse(readFileSync(path.join(stateDir, f), 'utf8'))
        return raw.authMode && typeof raw.authMode === 'object' ? Object.values(raw.authMode) : []
      } catch {
        return []
      }
    })
}
