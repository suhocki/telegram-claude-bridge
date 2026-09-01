import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadGlobalFishVoice, saveGlobalFishVoice } from '../fish-voice.mjs'

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-voice-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('loadGlobalFishVoice: missing file returns null (use the hardcoded default)', () => {
  withTmpDir(dir => {
    assert.equal(loadGlobalFishVoice(path.join(dir, 'fish-voice.json')), null)
  })
})

test('loadGlobalFishVoice: garbage/malformed JSON returns null instead of throwing', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'fish-voice.json')
    writeFileSync(file, '{not even trying to be valid')
    assert.equal(loadGlobalFishVoice(file), null)
  })
})

test('loadGlobalFishVoice: valid JSON missing id or title is rejected as null', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'fish-voice.json')
    writeFileSync(file, JSON.stringify({ id: 'a'.repeat(32) }))
    assert.equal(loadGlobalFishVoice(file), null)
    writeFileSync(file, JSON.stringify({ title: 'Voice A' }))
    assert.equal(loadGlobalFishVoice(file), null)
  })
})

test('saveGlobalFishVoice then loadGlobalFishVoice round-trips id and title', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'fish-voice.json')
    saveGlobalFishVoice(file, { id: 'a'.repeat(32), title: 'Зеленский' })
    assert.deepEqual(loadGlobalFishVoice(file), { id: 'a'.repeat(32), title: 'Зеленский' })
  })
})

test('saveGlobalFishVoice writes atomically (rename, not a stray tmp file left behind)', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'fish-voice.json')
    saveGlobalFishVoice(file, { id: 'a'.repeat(32), title: 'Voice A' })
    assert.deepEqual(readdirSync(dir), ['fish-voice.json'])
  })
})

test('one shared file behaves the same regardless of which "bot" reads/writes it (global scope, same as auth mode)', () => {
  withTmpDir(dir => {
    const sharedFile = path.join(dir, 'fish-voice.json')
    saveGlobalFishVoice(sharedFile, { id: 'b'.repeat(32), title: 'Voice B' })
    assert.deepEqual(loadGlobalFishVoice(sharedFile), { id: 'b'.repeat(32), title: 'Voice B' })
    assert.deepEqual(loadGlobalFishVoice(sharedFile), { id: 'b'.repeat(32), title: 'Voice B' })
  })
})

test('saveGlobalFishVoice overwrites a previous pick', () => {
  withTmpDir(dir => {
    const file = path.join(dir, 'fish-voice.json')
    saveGlobalFishVoice(file, { id: 'a'.repeat(32), title: 'Voice A' })
    saveGlobalFishVoice(file, { id: 'b'.repeat(32), title: 'Voice B' })
    assert.deepEqual(loadGlobalFishVoice(file), { id: 'b'.repeat(32), title: 'Voice B' })
  })
})
