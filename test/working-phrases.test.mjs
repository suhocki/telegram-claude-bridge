import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadWorkingPhrases, todayDateString, pickWorkingPhrase, DEFAULT_WORKING_PHRASE } from '../working-phrases.mjs'

test('loadWorkingPhrases: reads a JSON array of non-empty strings from disk', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wp-'))
  const file = path.join(dir, 'phrases.json')
  writeFileSync(file, JSON.stringify(['Колдую…', 'Думаю…', '', '  ', 42, null]))
  assert.deepEqual(loadWorkingPhrases(file), ['Колдую…', 'Думаю…'])
  rmSync(dir, { recursive: true, force: true })
})

test('loadWorkingPhrases: missing file, invalid JSON, or a non-array returns []', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wp-'))
  assert.deepEqual(loadWorkingPhrases(path.join(dir, 'missing.json')), [])

  const badJson = path.join(dir, 'bad.json')
  writeFileSync(badJson, '{not json')
  assert.deepEqual(loadWorkingPhrases(badJson), [])

  const notArray = path.join(dir, 'obj.json')
  writeFileSync(notArray, JSON.stringify({ a: 1 }))
  assert.deepEqual(loadWorkingPhrases(notArray), [])

  rmSync(dir, { recursive: true, force: true })
})

test('todayDateString: formats a Date as YYYY-MM-DD in UTC', () => {
  assert.equal(todayDateString(new Date('2026-08-10T23:59:00Z')), '2026-08-10')
  assert.equal(todayDateString(new Date('2026-01-05T00:00:00Z')), '2026-01-05')
})

test('pickWorkingPhrase: with no prior queue, loads the full list and hands out the first phrase', () => {
  const { phrase, nextState } = pickWorkingPhrase(null, ['a…', 'b…', 'c…'], '2026-08-10')
  assert.equal(phrase, 'a…')
  assert.deepEqual(nextState, { date: '2026-08-10', remaining: ['b…', 'c…'] })
})

test('pickWorkingPhrase: same day continues popping from the carried-over queue without repeats', () => {
  const state = { date: '2026-08-10', remaining: ['b…', 'c…'] }
  const first = pickWorkingPhrase(state, ['a…', 'b…', 'c…'], '2026-08-10')
  assert.equal(first.phrase, 'b…')
  assert.deepEqual(first.nextState, { date: '2026-08-10', remaining: ['c…'] })

  const second = pickWorkingPhrase(first.nextState, ['a…', 'b…', 'c…'], '2026-08-10')
  assert.equal(second.phrase, 'c…')
  assert.deepEqual(second.nextState, { date: '2026-08-10', remaining: [] })
})

test('pickWorkingPhrase: once the queue runs dry it reloads the full list again, same day', () => {
  const exhausted = { date: '2026-08-10', remaining: [] }
  const { phrase, nextState } = pickWorkingPhrase(exhausted, ['a…', 'b…'], '2026-08-10')
  assert.equal(phrase, 'a…')
  assert.deepEqual(nextState, { date: '2026-08-10', remaining: ['b…'] })
})

test('pickWorkingPhrase: a date change reloads the full list even if some remained from before', () => {
  const stale = { date: '2026-08-09', remaining: ['c…'] }
  const { phrase, nextState } = pickWorkingPhrase(stale, ['a…', 'b…'], '2026-08-10')
  assert.equal(phrase, 'a…')
  assert.deepEqual(nextState, { date: '2026-08-10', remaining: ['b…'] })
})

test('pickWorkingPhrase: an empty phrase list falls back to the default phrase', () => {
  const { phrase, nextState } = pickWorkingPhrase(null, [], '2026-08-10')
  assert.equal(phrase, DEFAULT_WORKING_PHRASE)
  assert.deepEqual(nextState, { date: '2026-08-10', remaining: [] })
})
