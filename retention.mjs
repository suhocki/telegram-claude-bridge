import { readdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'

// Missing/unreadable dirs are not an error — inbox/tmp/outbox/rewind-backups are created lazily on first use.
export function sweepOldFiles(dir, maxAgeMs, now = Date.now()) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { removed: [] }
  }

  const removed = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      removed.push(...sweepOldFiles(full, maxAgeMs, now).removed)
      continue
    }
    if (!entry.isFile()) continue
    let mtimeMs
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      continue
    }
    if (now - mtimeMs > maxAgeMs) {
      try {
        rmSync(full, { force: true })
        removed.push(full)
      } catch {
        // leave it for the next sweep
      }
    }
  }
  return { removed }
}
