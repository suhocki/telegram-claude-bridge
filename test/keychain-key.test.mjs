import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAnthropicApiKey, DEFAULT_KEYCHAIN_SERVICE } from '../keychain-key.mjs'

test('resolveAnthropicApiKey: an env var already set wins and the Keychain is not read', () => {
  const read = () => assert.fail('should not read the Keychain')
  assert.equal(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: 'from-env' }, { read }), 'from-env')
})

test('resolveAnthropicApiKey: reads the default Keychain service and trims the newline', () => {
  let asked
  const key = resolveAnthropicApiKey({}, { read: s => ((asked = s), 'sk-test\n') })
  assert.equal(asked, DEFAULT_KEYCHAIN_SERVICE)
  assert.equal(key, 'sk-test')
})

test('resolveAnthropicApiKey: ANTHROPIC_API_KEY_KEYCHAIN_SERVICE overrides the service name', () => {
  let asked
  resolveAnthropicApiKey({ ANTHROPIC_API_KEY_KEYCHAIN_SERVICE: 'other' }, { read: s => ((asked = s), 'k') })
  assert.equal(asked, 'other')
})

test('resolveAnthropicApiKey: missing item or empty value gives null', () => {
  assert.equal(resolveAnthropicApiKey({}, { read: () => { throw new Error('not found') } }), null)
  assert.equal(resolveAnthropicApiKey({}, { read: () => '  \n' }), null)
})
