#!/usr/bin/env node
// Regenerates working-phrases.json with a fresh batch of Russian "still working" phrases
// for the bridge's placeholder message. Meant to run once a day via
// com.tgbridge.working-phrases.plist (see scripts/gen-working-phrases-launchagent.mjs) —
// on failure it leaves the existing file untouched so a bad generation never empties it.

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

export function extractPhrasesFromClaudeOutput(raw) {
  const jsonMatch = String(raw ?? '').match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error(`no JSON array found in claude output: ${String(raw ?? '').slice(0, 200)}`)
  const parsed = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed)) throw new Error('claude output parsed but is not an array')
  return [...new Set(parsed.map(p => String(p ?? '').trim()).filter(Boolean))]
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
