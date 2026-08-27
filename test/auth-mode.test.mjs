import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadGlobalAuthMode, saveGlobalAuthMode } from '../auth-mode.mjs'

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'auth-mode-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('loadGlobalAuthMode: missing file defaults to "apikey"', () => {
  withTmpDir(dir => {
    assert.equal(loadGlobalAuthMode(path.join(dir, 'auth-mode.json')), 'apikey')
  })
})

test('loadGlobalAuthMode: invalid JSON or an unrecognized mode defaults to "apikey"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.json')
    writeFileSync(file, '{not json')
    assert.equal(loadGlobalAuthMode(file), 'apikey')
    writeFileSync(file, JSON.stringify({ mode: 'bogus' }))
    assert.equal(loadGlobalAuthMode(file), 'apikey')
  })
})

test('saveGlobalAuthMode then loadGlobalAuthMode round-trips "subscription"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.json')
    saveGlobalAuthMode(file, 'subscription')
    assert.equal(loadGlobalAuthMode(file), 'subscription')
  })
})

test('saveGlobalAuthMode writes atomically (rename, not a stray .tmp file left behind)', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.json')
    saveGlobalAuthMode(file, 'apikey')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'apikey' })
    assert.throws(() => readFileSync(`${file}.tmp`))
  })
})

test('saveGlobalAuthMode normalizes an unrecognized mode to "apikey"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.json')
    saveGlobalAuthMode(file, 'bogus')
    assert.equal(loadGlobalAuthMode(file), 'apikey')
  })
})

test('one shared file behaves the same regardless of which "bot" reads/writes it (the whole point of the global switch)', () => {
  withTmpDir(dir => {
    const sharedFile = path.join(dir, 'auth-mode.json')
    // simulates two separate bot processes pointed at the same stateDir
    saveGlobalAuthMode(sharedFile, 'subscription')
    assert.equal(loadGlobalAuthMode(sharedFile), 'subscription')
    assert.equal(loadGlobalAuthMode(sharedFile), 'subscription')
  })
})
