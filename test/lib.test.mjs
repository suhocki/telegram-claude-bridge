import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk, sanitizeAttr, buildSendMessageCalls } from '../lib.mjs'

test('chunk: text under the limit is returned as a single part', () => {
  assert.deepEqual(chunk('hello', 10), ['hello'])
})

test('chunk: text exactly at the limit is not split', () => {
  const text = 'a'.repeat(10)
  assert.deepEqual(chunk(text, 10), [text])
})

test('chunk: splits on the last newline before the limit when one exists past half the limit', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6)
  const parts = chunk(text, 10)
  assert.deepEqual(parts, ['a'.repeat(6), 'b'.repeat(6)])
})

test('chunk: hard-cuts at the limit when no usable newline exists', () => {
  const text = 'a'.repeat(25)
  const parts = chunk(text, 10)
  assert.deepEqual(parts, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
})

test('chunk: default limit is 4096', () => {
  const text = 'a'.repeat(5000)
  const parts = chunk(text)
  assert.equal(parts[0].length, 4096)
  assert.equal(parts[1].length, 904)
})

test('sanitizeAttr: strips characters that could break out of an XML attribute', () => {
  assert.equal(sanitizeAttr('a<b>c[d]e\r\nf"g'), 'a_b_c_d_e__f_g')
})

test('sanitizeAttr: passes through a plain username untouched', () => {
  assert.equal(sanitizeAttr('suhocki'), 'suhocki')
})

test('sanitizeAttr: null/undefined become an empty string, not "null"/"undefined"', () => {
  assert.equal(sanitizeAttr(undefined), '')
  assert.equal(sanitizeAttr(null), '')
})

test('buildSendMessageCalls: single chunk gets reply_parameters when a message id is given', () => {
  const calls = buildSendMessageCalls('123', 'hello', 42)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'hello', reply_parameters: { message_id: 42, allow_sending_without_reply: true } },
  ])
})

test('buildSendMessageCalls: no reply_parameters when message id is omitted', () => {
  const calls = buildSendMessageCalls('123', 'hello')
  assert.deepEqual(calls, [{ chat_id: '123', text: 'hello' }])
})

test('buildSendMessageCalls: no reply_parameters when message id is null', () => {
  const calls = buildSendMessageCalls('123', 'hello', null)
  assert.deepEqual(calls, [{ chat_id: '123', text: 'hello' }])
})

test('buildSendMessageCalls: only the first chunk threads under the triggering message', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6)
  const calls = buildSendMessageCalls('123', text, 99, 10)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'a'.repeat(6), reply_parameters: { message_id: 99, allow_sending_without_reply: true } },
    { chat_id: '123', text: 'b'.repeat(6) },
  ])
})

test('buildSendMessageCalls: with three or more chunks, only the first threads and the rest do not', () => {
  const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6) + '\n' + 'c'.repeat(6)
  const calls = buildSendMessageCalls('123', text, 99, 10)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'a'.repeat(6), reply_parameters: { message_id: 99, allow_sending_without_reply: true } },
    { chat_id: '123', text: 'b'.repeat(6) },
    { chat_id: '123', text: 'c'.repeat(6) },
  ])
})

test('buildSendMessageCalls: message id 0 is a valid id and still threads', () => {
  const calls = buildSendMessageCalls('123', 'hi', 0)
  assert.deepEqual(calls, [
    { chat_id: '123', text: 'hi', reply_parameters: { message_id: 0, allow_sending_without_reply: true } },
  ])
})
