import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBridgeConfig, resolveBotSlug } from '../lib.mjs'

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

test('validateBridgeConfig: a botSlug already claimed by another config in the repo is an error', () => {
  const err = validateBridgeConfig(VALID, { botSlug: 'tldr', existingBotSlugs: ['tldr', 'ig'] })
  assert.match(err, /tldr/)
})

test('validateBridgeConfig: a botSlug not claimed by any other config passes', () => {
  assert.equal(validateBridgeConfig(VALID, { botSlug: 'tldr', existingBotSlugs: ['ig'] }), null)
})

test('validateBridgeConfig: no existingBotSlugs option means no collision check', () => {
  assert.equal(validateBridgeConfig(VALID, { botSlug: 'tldr' }), null)
})

test('validateBridgeConfig: retentionDays must be a positive number when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: 0 }), /retentionDays/)
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: -1 }), /retentionDays/)
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: 'soon' }), /retentionDays/)
  assert.equal(validateBridgeConfig({ ...VALID, retentionDays: 14 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, retentionDays: undefined }), null)
})

test('resolveBotSlug: derives the basename without extension from a given stateFile', () => {
  assert.equal(resolveBotSlug('/repo', 'state/tldr.json'), 'tldr')
  assert.equal(resolveBotSlug('/repo', 'state/ig.json'), 'ig')
})

test('resolveBotSlug: falls back to "state" (from the default state.json) when stateFile is omitted', () => {
  assert.equal(resolveBotSlug('/repo', undefined), 'state')
  assert.equal(resolveBotSlug('/repo', null), 'state')
})

test('resolveBotSlug: two configs that both omit stateFile collide on the same slug', () => {
  assert.equal(resolveBotSlug('/repo', undefined), resolveBotSlug('/repo', undefined))
})

test('resolveBotSlug: different directories with the same basename still collide (same as the bridge\'s own directory namespacing)', () => {
  assert.equal(resolveBotSlug('/repo', 'state/tldr.json'), resolveBotSlug('/repo', 'archive/tldr.json'))
})
