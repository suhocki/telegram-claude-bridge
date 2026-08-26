import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sweepOldFiles } from '../retention.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

function touch(filePath, ageMs, now) {
  writeFileSync(filePath, 'x')
  const mtime = (now - ageMs) / 1000
  utimesSync(filePath, mtime, mtime)
}

test('sweepOldFiles: removes files older than maxAgeMs, keeps newer ones', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-'))
  const now = Date.parse('2026-08-26T00:00:00Z')
  const old = path.join(dir, 'old.txt')
  const fresh = path.join(dir, 'fresh.txt')
  touch(old, 20 * DAY_MS, now)
  touch(fresh, 1 * DAY_MS, now)

  const { removed } = sweepOldFiles(dir, 14 * DAY_MS, now)

  assert.deepEqual(removed, [old])
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  rmSync(dir, { recursive: true, force: true })
})

test('sweepOldFiles: recurses into subdirectories', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-'))
  const now = Date.parse('2026-08-26T00:00:00Z')
  const sub = path.join(dir, 'tldr')
  mkdirSync(sub)
  const old = path.join(sub, 'old.txt')
  touch(old, 20 * DAY_MS, now)

  const { removed } = sweepOldFiles(dir, 14 * DAY_MS, now)

  assert.deepEqual(removed, [old])
  assert.equal(existsSync(old), false)
  rmSync(dir, { recursive: true, force: true })
})

test('sweepOldFiles: with { recurse: false }, only removes top-level files and leaves subdirectories untouched', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-'))
  const now = Date.parse('2026-08-26T00:00:00Z')
  const topLevelOld = path.join(dir, 'legacy.txt')
  touch(topLevelOld, 20 * DAY_MS, now)
  const sub = path.join(dir, 'tldr')
  mkdirSync(sub)
  const subOld = path.join(sub, 'old.txt')
  touch(subOld, 20 * DAY_MS, now)

  const { removed } = sweepOldFiles(dir, 14 * DAY_MS, now, { recurse: false })

  assert.deepEqual(removed, [topLevelOld])
  assert.equal(existsSync(topLevelOld), false)
  assert.equal(existsSync(subOld), true)
  rmSync(dir, { recursive: true, force: true })
})

test('sweepOldFiles: a missing directory is not an error', () => {
  const { removed } = sweepOldFiles('/no/such/directory/at/all', 14 * DAY_MS)
  assert.deepEqual(removed, [])
})

test('sweepOldFiles: an empty directory removes nothing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retention-'))
  const { removed } = sweepOldFiles(dir, 14 * DAY_MS)
  assert.deepEqual(removed, [])
  rmSync(dir, { recursive: true, force: true })
})
