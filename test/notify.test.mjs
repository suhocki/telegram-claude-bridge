import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateNotifyConfig, resolveNotifyChatId, pickNotifyText } from '../lib.mjs'

test('validateNotifyConfig: missing config or botToken is an error', () => {
  assert.match(validateNotifyConfig(null), /botToken/)
  assert.match(validateNotifyConfig({}), /botToken/)
  assert.match(validateNotifyConfig({ botToken: '' }), /botToken/)
  assert.match(validateNotifyConfig({ botToken: '   ' }), /botToken/)
})

test('validateNotifyConfig: a non-empty botToken passes', () => {
  assert.equal(validateNotifyConfig({ botToken: '123:abc' }), null)
})

test('resolveNotifyChatId: an explicit chat id wins over everything else', () => {
  const config = { notifyChatId: '111', allowedUserIds: ['222'] }
  assert.equal(resolveNotifyChatId(config, '333'), '333')
})

test('resolveNotifyChatId: falls back to config.notifyChatId when no explicit id is given', () => {
  const config = { notifyChatId: '111', allowedUserIds: ['222'] }
  assert.equal(resolveNotifyChatId(config, undefined), '111')
})

test('resolveNotifyChatId: falls back to the first allowedUserIds entry when notifyChatId is absent', () => {
  const config = { allowedUserIds: ['222', '333'] }
  assert.equal(resolveNotifyChatId(config, undefined), '222')
})

test('resolveNotifyChatId: returns null when nothing resolves', () => {
  assert.equal(resolveNotifyChatId({}, undefined), null)
  assert.equal(resolveNotifyChatId({ allowedUserIds: [] }, null), null)
  assert.equal(resolveNotifyChatId(null, undefined), null)
})

test('resolveNotifyChatId: blank explicit id is ignored in favor of config fallbacks', () => {
  const config = { notifyChatId: '111' }
  assert.equal(resolveNotifyChatId(config, '   '), '111')
})

test('pickNotifyText: prefers the CLI argument when present', () => {
  assert.equal(pickNotifyText('hello', 'from stdin'), 'hello')
})

test('pickNotifyText: falls back to stdin text when the argument is missing or blank', () => {
  assert.equal(pickNotifyText(undefined, 'from stdin'), 'from stdin')
  assert.equal(pickNotifyText('   ', 'from stdin'), 'from stdin')
})

test('pickNotifyText: trims both sources and returns empty string when both are blank', () => {
  assert.equal(pickNotifyText('  hi  ', ''), 'hi')
  assert.equal(pickNotifyText(undefined, '  \n  '), '')
})
