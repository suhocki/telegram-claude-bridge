import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPhrasesFromClaudeOutput, PROMPT, PHRASE_COUNT } from '../scripts/update-working-phrases.mjs'

test('extractPhrasesFromClaudeOutput: parses a clean JSON array', () => {
  const raw = JSON.stringify(['Колдую…', 'Думаю…', 'Ищу ответ…'])
  assert.deepEqual(extractPhrasesFromClaudeOutput(raw), ['Колдую…', 'Думаю…', 'Ищу ответ…'])
})

test('extractPhrasesFromClaudeOutput: extracts the array even when wrapped in prose or markdown fences', () => {
  const raw = "Вот твой список:\n```json\n[\"Колдую…\", \"Думаю…\"]\n```\nНадеюсь, подойдёт!"
  assert.deepEqual(extractPhrasesFromClaudeOutput(raw), ['Колдую…', 'Думаю…'])
})

test('extractPhrasesFromClaudeOutput: dedupes and drops blank/whitespace-only entries', () => {
  const raw = JSON.stringify(['Колдую…', '  ', 'Колдую…', '', 'Думаю…'])
  assert.deepEqual(extractPhrasesFromClaudeOutput(raw), ['Колдую…', 'Думаю…'])
})

test('extractPhrasesFromClaudeOutput: throws when there is no JSON array at all', () => {
  assert.throws(() => extractPhrasesFromClaudeOutput('sorry, I cannot help with that'), /no JSON array found/)
})

test('extractPhrasesFromClaudeOutput: a bracket-free JSON object has no array to find', () => {
  assert.throws(() => extractPhrasesFromClaudeOutput('{"phrases": "none"}'), /no JSON array found/)
})

test('PROMPT: mentions the configured phrase count and requires a JSON array', () => {
  assert.match(PROMPT, new RegExp(String(PHRASE_COUNT)))
  assert.match(PROMPT, /JSON/)
})
