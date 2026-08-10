#!/usr/bin/env node
// On failure, leaves the existing working-phrases.json untouched rather than emptying it.

import { writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outputPath = path.join(repoRoot, 'working-phrases.json')

export const PHRASE_COUNT = 40

export const PROMPT = `Придумай ровно ${PHRASE_COUNT} разных коротких фраз или словосочетаний на русском языке для плейсхолдера "бот сейчас работает над ответом" в Telegram-боте.

Тон — остроумный, живой, разнообразный по конструкции (не только глаголы на "-ю…" в начале). Каждая фраза должна:
- быть на русском языке;
- заканчиваться одним символом "…" (многоточие, не тремя точками);
- быть короче 40 символов;
- не содержать кавычек, эмодзи, номеров или маркеров списка.

Выведи ТОЛЬКО валидный JSON-массив из ${PHRASE_COUNT} строк — без пояснений, без markdown-разметки, без обратных кавычек.`

function dedupeNonEmptyStrings(arr) {
  return [...new Set(arr.map(p => String(p ?? '').trim()).filter(Boolean))]
}

export function extractPhrasesFromClaudeOutput(raw) {
  const text = String(raw ?? '').trim()
  try {
    const direct = JSON.parse(text)
    if (Array.isArray(direct)) return dedupeNonEmptyStrings(direct)
  } catch {
    // fall through to bracket extraction below — claude sometimes wraps the array in prose despite the prompt
  }
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error(`no JSON array found in claude output: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed)) throw new Error('claude output parsed but is not an array')
  return dedupeNonEmptyStrings(parsed)
}

function generatePhrases() {
  const raw = execFileSync('claude', ['-p', PROMPT], { encoding: 'utf8', timeout: 120000 })
  const cleaned = extractPhrasesFromClaudeOutput(raw)
  if (cleaned.length < 10) throw new Error(`too few usable phrases generated (${cleaned.length})`)
  return cleaned
}

function main() {
  let phrases
  try {
    phrases = generatePhrases()
  } catch (e) {
    console.error(`update-working-phrases: generation failed, leaving ${outputPath} untouched:`, e.message)
    process.exitCode = 1
    return
  }
  const tmpPath = `${outputPath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(phrases, null, 2)}\n`)
  renameSync(tmpPath, outputPath)
  console.error(`update-working-phrases: wrote ${phrases.length} phrases to ${outputPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
