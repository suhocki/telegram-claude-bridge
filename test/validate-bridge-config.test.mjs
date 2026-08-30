import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBridgeConfig, resolveBotSlug, resolveBotStateFile } from '../lib.mjs'

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

test('validateBridgeConfig: a non-string stateFile is an error instead of crashing downstream path resolution', () => {
  assert.match(validateBridgeConfig({ ...VALID, stateFile: 123 }), /stateFile/)
  assert.match(validateBridgeConfig({ ...VALID, stateFile: {} }), /stateFile/)
  assert.equal(validateBridgeConfig({ ...VALID, stateFile: 'state/tldr.json' }), null)
  assert.equal(validateBridgeConfig({ ...VALID, stateFile: undefined }), null)
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

test('validateBridgeConfig: a stateFilePath already claimed by another config in the repo is an error', () => {
  const err = validateBridgeConfig(VALID, {
    stateFilePath: '/repo/state/tldr.json',
    existingStateFilePaths: ['/repo/state/tldr.json', '/repo/state/ig.json'],
  })
  assert.match(err, /tldr\.json/)
})

test('validateBridgeConfig: the stateFilePath collision check is case-insensitive (matching macOS\'s default filesystem)', () => {
  const err = validateBridgeConfig(VALID, {
    stateFilePath: '/repo/state/Tldr.json',
    existingStateFilePaths: ['/repo/state/tldr.json'],
  })
  assert.match(err, /Tldr\.json/)
})

test('validateBridgeConfig: a stateFilePath not claimed by any other config passes', () => {
  assert.equal(
    validateBridgeConfig(VALID, { stateFilePath: '/repo/state/tldr.json', existingStateFilePaths: ['/repo/state/ig.json'] }),
    null
  )
})

test('validateBridgeConfig: two different directories that merely share a basename do not collide', () => {
  assert.equal(
    validateBridgeConfig(VALID, {
      stateFilePath: '/repo/stateA/bot.json',
      existingStateFilePaths: ['/repo/stateB/bot.json'],
    }),
    null
  )
})

test('validateBridgeConfig: no existingStateFilePaths option means no collision check', () => {
  assert.equal(validateBridgeConfig(VALID, { stateFilePath: '/repo/state/tldr.json' }), null)
})

test('validateBridgeConfig: retentionDays must be a positive number when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: 0 }), /retentionDays/)
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: -1 }), /retentionDays/)
  assert.match(validateBridgeConfig({ ...VALID, retentionDays: 'soon' }), /retentionDays/)
  assert.equal(validateBridgeConfig({ ...VALID, retentionDays: 14 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, retentionDays: undefined }), null)
})

test('validateBridgeConfig: claudeTurnTimeoutMs/claudeTurnAbsoluteTimeoutMs/subprocessTimeoutMs must be non-negative numbers within setTimeout range, but 0 (disabled) is fine', () => {
  for (const field of ['claudeTurnTimeoutMs', 'claudeTurnAbsoluteTimeoutMs', 'subprocessTimeoutMs']) {
    assert.match(validateBridgeConfig({ ...VALID, [field]: '20m' }), new RegExp(field))
    assert.match(validateBridgeConfig({ ...VALID, [field]: -1 }), new RegExp(field))
    assert.match(validateBridgeConfig({ ...VALID, [field]: NaN }), new RegExp(field))
    assert.match(validateBridgeConfig({ ...VALID, [field]: 2 ** 31 }), new RegExp(field))
    assert.equal(validateBridgeConfig({ ...VALID, [field]: 0 }), null)
    assert.equal(validateBridgeConfig({ ...VALID, [field]: 60000 }), null)
    assert.equal(validateBridgeConfig({ ...VALID, [field]: undefined }), null)
  }
})

test('validateBridgeConfig: claudeTurnAbsoluteTimeoutMs must be at least claudeTurnTimeoutMs when both are given', () => {
  const err = validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 1200000, claudeTurnAbsoluteTimeoutMs: 300000 })
  assert.match(err, /claudeTurnAbsoluteTimeoutMs/)
  assert.equal(validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 1200000, claudeTurnAbsoluteTimeoutMs: 1200000 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 1200000, claudeTurnAbsoluteTimeoutMs: 14400000 }), null)
})

test('validateBridgeConfig: the ordering check does not apply when either side is 0 (disabled) or unset', () => {
  assert.equal(validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 0, claudeTurnAbsoluteTimeoutMs: 300000 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 1200000, claudeTurnAbsoluteTimeoutMs: 0 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, claudeTurnTimeoutMs: 1200000 }), null)
})

test('validateBridgeConfig: maxConcurrentJobs must be a positive number when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, maxConcurrentJobs: 0 }), /maxConcurrentJobs/)
  assert.match(validateBridgeConfig({ ...VALID, maxConcurrentJobs: -1 }), /maxConcurrentJobs/)
  assert.match(validateBridgeConfig({ ...VALID, maxConcurrentJobs: 'five' }), /maxConcurrentJobs/)
  assert.equal(validateBridgeConfig({ ...VALID, maxConcurrentJobs: 5 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, maxConcurrentJobs: undefined }), null)
})

test('validateBridgeConfig: jobDefaultTimeoutMinutes must be a positive number when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, jobDefaultTimeoutMinutes: 0 }), /jobDefaultTimeoutMinutes/)
  assert.match(validateBridgeConfig({ ...VALID, jobDefaultTimeoutMinutes: -1 }), /jobDefaultTimeoutMinutes/)
  assert.match(validateBridgeConfig({ ...VALID, jobDefaultTimeoutMinutes: 'an hour' }), /jobDefaultTimeoutMinutes/)
  assert.equal(validateBridgeConfig({ ...VALID, jobDefaultTimeoutMinutes: 60 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, jobDefaultTimeoutMinutes: undefined }), null)
})

test('validateBridgeConfig: jobSweepIntervalMs must be a positive number within setTimeout range when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: 0 }), /jobSweepIntervalMs/)
  assert.match(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: -1 }), /jobSweepIntervalMs/)
  assert.match(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: 2 ** 31 }), /jobSweepIntervalMs/)
  assert.match(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: 'often' }), /jobSweepIntervalMs/)
  assert.equal(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: 15000 }), null)
  assert.equal(validateBridgeConfig({ ...VALID, jobSweepIntervalMs: undefined }), null)
})

test('validateBridgeConfig: apiBaseUrl must be a non-empty string when given', () => {
  assert.match(validateBridgeConfig({ ...VALID, apiBaseUrl: '' }), /apiBaseUrl/)
  assert.match(validateBridgeConfig({ ...VALID, apiBaseUrl: '   ' }), /apiBaseUrl/)
  assert.match(validateBridgeConfig({ ...VALID, apiBaseUrl: 123 }), /apiBaseUrl/)
  assert.equal(validateBridgeConfig({ ...VALID, apiBaseUrl: 'http://127.0.0.1:5000' }), null)
  assert.equal(validateBridgeConfig({ ...VALID, apiBaseUrl: undefined }), null)
})

test('resolveBotStateFile: resolves a relative stateFile against configDir, defaulting to state.json', () => {
  assert.equal(resolveBotStateFile('/repo', 'state/tldr.json'), '/repo/state/tldr.json')
  assert.equal(resolveBotStateFile('/repo', undefined), '/repo/state.json')
})

test('resolveBotSlug: derives the basename without extension from a given stateFile', () => {
  assert.equal(resolveBotSlug('/repo', 'state/tldr.json'), 'tldr')
  assert.equal(resolveBotSlug('/repo', 'state/ig.json'), 'ig')
})

test('resolveBotSlug: falls back to "state" (from the default state.json) when stateFile is omitted', () => {
  assert.equal(resolveBotSlug('/repo', undefined), 'state')
  assert.equal(resolveBotSlug('/repo', null), 'state')
})
