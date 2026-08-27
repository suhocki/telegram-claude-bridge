import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadGlobalAuthMode, saveGlobalAuthMode, seedGlobalAuthModeIfMissing, collectLegacyAuthModeValues } from '../auth-mode.mjs'

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

test('seedGlobalAuthModeIfMissing: creates the file and returns true when it does not exist yet', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    assert.equal(seedGlobalAuthModeIfMissing(file, 'subscription'), true)
    assert.equal(loadGlobalAuthMode(file), 'subscription')
  })
})

test('seedGlobalAuthModeIfMissing: a file that already exists is left untouched, returns false', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    saveGlobalAuthMode(file, 'subscription')
    assert.equal(seedGlobalAuthModeIfMissing(file, 'apikey'), false)
    assert.equal(loadGlobalAuthMode(file), 'subscription')
  })
})

test('seedGlobalAuthModeIfMissing: simulates the exact race this guards against — a live switch wins over a late migration', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'auth-mode.txt')
    saveGlobalAuthMode(file, 'apikey') // a live /apikey command lands first
    assert.equal(seedGlobalAuthModeIfMissing(file, 'subscription'), false) // migration arrives late, does not clobber it
    assert.equal(loadGlobalAuthMode(file), 'apikey')
  })
})

test('collectLegacyAuthModeValues: flattens authMode values across every state/*.json, skipping the target file itself', () => {
  withTmpDir(dir => {
    writeFileSync(path.join(dir, 'tldr.json'), JSON.stringify({ authMode: { '111': 'subscription' } }))
    writeFileSync(path.join(dir, 'ig.json'), JSON.stringify({ authMode: { '222': 'apikey', '333': 'subscription' } }))
    writeFileSync(path.join(dir, 'auth-mode.txt'), 'subscription')
    assert.deepEqual(
      collectLegacyAuthModeValues(dir, 'auth-mode.txt').sort(),
      ['apikey', 'subscription', 'subscription'].sort()
    )
  })
})

test('collectLegacyAuthModeValues: a config with no authMode field, malformed JSON, or a non-.json file contributes nothing', () => {
  withTmpDir(dir => {
    writeFileSync(path.join(dir, 'jobsearch.json'), JSON.stringify({ offset: 1 }))
    writeFileSync(path.join(dir, 'bad.json'), '{not json')
    writeFileSync(path.join(dir, 'notes.txt'), 'subscription')
    assert.deepEqual(collectLegacyAuthModeValues(dir, 'auth-mode.txt'), [])
  })
})

test('collectLegacyAuthModeValues: a missing stateDir is not an error', () => {
  assert.deepEqual(collectLegacyAuthModeValues('/no/such/directory/at/all', 'auth-mode.txt'), [])
})
