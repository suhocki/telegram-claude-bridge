import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBridgeConfig } from '../lib.mjs'

const VALID = { botToken: '123:abc', cwd: '/repo', allowedUserIds: [1] }

test('validateBridgeConfig: a fully populated config passes', () => {
  assert.equal(validateBridgeConfig(VALID), null)
})

test('validateBridgeConfig: missing config or botToken is an error', () => {
  assert.match(validateBridgeConfig(null), /botToken/)
  assert.match(validateBridgeConfig({ ...VALID, botToken: undefined }), /botToken/)
  assert.match(validateBridgeConfig({ ...VALID, botToken: '' }), /botToken/)
  assert.match(validateBridgeConfig({ ...VALID, botToken: '   ' }), /botToken/)
})

test('validateBridgeConfig: missing cwd is an error', () => {
  assert.match(validateBridgeConfig({ ...VALID, cwd: undefined }), /cwd/)
  assert.match(validateBridgeConfig({ ...VALID, cwd: '' }), /cwd/)
})

test('validateBridgeConfig: allowedUserIds missing/empty with no groups either is an error', () => {
  assert.match(validateBridgeConfig({ ...VALID, allowedUserIds: undefined }), /allowedUserIds/)
  assert.match(validateBridgeConfig({ ...VALID, allowedUserIds: [] }), /allowedUserIds/)
  assert.match(validateBridgeConfig({ ...VALID, allowedUserIds: 'not-an-array' }), /allowedUserIds/)
})

test('validateBridgeConfig: an empty allowedUserIds is fine for a group-only bot (allowFrom under "groups")', () => {
  const groupOnly = {
    botToken: '123:abc',
    cwd: '/repo',
    allowedUserIds: [],
    groups: { '-100123': { requireMention: false, allowFrom: [1, 2] } },
  }
  assert.equal(validateBridgeConfig(groupOnly), null)
})

test('validateBridgeConfig: a stateFile already claimed by another config in the repo is an error', () => {
  const err = validateBridgeConfig({ ...VALID, stateFile: 'state/tldr.json' }, { existingStateFiles: ['state/tldr.json'] })
  assert.match(err, /stateFile/)
  assert.match(err, /state\/tldr\.json/)
})

test('validateBridgeConfig: a stateFile not claimed by any other config passes', () => {
  assert.equal(
    validateBridgeConfig({ ...VALID, stateFile: 'state/tldr.json' }, { existingStateFiles: ['state/ig.json'] }),
    null
  )
})

test('validateBridgeConfig: no existingStateFiles option means no collision check', () => {
  assert.equal(validateBridgeConfig({ ...VALID, stateFile: 'state/tldr.json' }), null)
})
