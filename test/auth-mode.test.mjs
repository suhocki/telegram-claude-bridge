import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
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
    assert.equal(loadGlobalAuthMode(path.join(dir, 'auth-mode.txt')), 'apikey')
  })
})

test('loadGlobalAuthMode: garbage content or an unrecognized mode defaults to "apikey"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    writeFileSync(file, '{not even trying to be valid')
    assert.equal(loadGlobalAuthMode(file), 'apikey')
    writeFileSync(file, 'bogus')
    assert.equal(loadGlobalAuthMode(file), 'apikey')
  })
})

test('loadGlobalAuthMode: tolerates trailing whitespace/newline', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    writeFileSync(file, 'subscription\n')
    assert.equal(loadGlobalAuthMode(file), 'subscription')
  })
})

test('saveGlobalAuthMode then loadGlobalAuthMode round-trips "subscription"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    saveGlobalAuthMode(file, 'subscription')
    assert.equal(loadGlobalAuthMode(file), 'subscription')
  })
})

test('saveGlobalAuthMode writes atomically (rename, not a stray tmp file left behind)', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    saveGlobalAuthMode(file, 'apikey')
    assert.equal(readFileSync(file, 'utf8'), 'apikey')
    assert.deepEqual(readdirSync(dir), ['auth-mode.txt'])
  })
})

test('saveGlobalAuthMode normalizes an unrecognized mode to "apikey"', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    saveGlobalAuthMode(file, 'bogus')
    assert.equal(loadGlobalAuthMode(file), 'apikey')
  })
})

test('one shared file behaves the same regardless of which "bot" reads/writes it (the whole point of the global switch)', () => {
  withTmpDir(dir => {
    const sharedFile = path.join(dir, 'auth-mode.txt')
    // simulates two separate bot processes pointed at the same stateDir
    saveGlobalAuthMode(sharedFile, 'subscription')
    assert.equal(loadGlobalAuthMode(sharedFile), 'subscription')
    assert.equal(loadGlobalAuthMode(sharedFile), 'subscription')
  })
})
