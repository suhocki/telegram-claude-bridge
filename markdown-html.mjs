const STASH_MARK = '\x00'

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function wrapBlockquotes(text) {
  const lines = text.split('\n')
  const out = []
  let buffer = []
  const flush = () => {
    if (buffer.length) {
      out.push(`<blockquote>${buffer.join('\n')}</blockquote>`)
      buffer = []
    }
  }
  for (const line of lines) {
    const m = line.match(/^&gt; ?(.*)$/)
    if (m) {
      buffer.push(m[1])
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

// Telegram's HTML mode has no <table> tag, so a GFM pipe table renders as a monospace <pre> grid.
const TABLE_CELL_SEP_RE = /^:?-+:?$/

function fenceLangOf(line) {
  const m = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/)
  return m ? m[1] : null
}

function splitTableRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

// Wide ranges per UAX #11 (CJK/Hangul/Kana/fullwidth forms/emoji) render as 2 monospace cells.
const WIDE_CODE_POINT_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1faff], [0x20000, 0x3fffd],
]
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

function isWideCodePoint(cp) {
  return WIDE_CODE_POINT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

// Segments by grapheme (not code point) so a ZWJ/skin-tone emoji sequence counts as one glyph.
function visualWidth(s) {
  let width = 0
  for (const { segment } of graphemeSegmenter.segment(s)) width += isWideCodePoint(segment.codePointAt(0)) ? 2 : 1
  return width
}

function padCell(s, width) {
  const pad = width - visualWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

function renderTableBlock(headerLine, rowLines) {
  const header = splitTableRow(headerLine)
  const rows = rowLines.map(splitTableRow)
  const colCount = Math.max(header.length, ...rows.map(r => r.length))
  const widths = Array.from({ length: colCount }, (_, i) => visualWidth(header[i] ?? ''))
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) widths[c] = Math.max(widths[c], visualWidth(row[c] ?? ''))
  }
  const padRow = row => Array.from({ length: colCount }, (_, i) => padCell(row[i] ?? '', widths[i])).join(' | ')
  const sep = widths.map(w => '-'.repeat(w)).join('-+-')
  const lines = [padRow(header), sep, ...rows.map(padRow)]
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`
}

function isTableSeparatorRow(sepLine, expectedCols) {
  if (!sepLine.includes('-')) return false
  const cells = splitTableRow(sepLine)
  return cells.length === expectedCols && cells.every(c => TABLE_CELL_SEP_RE.test(c))
}

// Requires a separator matching the header's column count so a stray "|" in prose followed by an unrelated "---" divider isn't misread as a table.
function detectTableAt(lines, i) {
  const headerLine = lines[i]
  const sepLine = lines[i + 1]
  if (!headerLine?.includes('|') || sepLine === undefined) return null
  const headerCells = splitTableRow(headerLine)
  if (!isTableSeparatorRow(sepLine, headerCells.length)) return null
  const rowLines = []
  let j = i + 2
  while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
    rowLines.push(lines[j])
    j++
  }
  return { headerLine, sepLine, rowLines, next: j }
}

function replaceMarkdownTables(text, stashHtml) {
  const lines = text.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const table = detectTableAt(lines, i)
    if (table) {
      out.push(stashHtml(renderTableBlock(table.headerLine, table.rowLines)))
      i = table.next
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

// A markdown table read aloud verbatim (padded pipes/dashes) is noise, so this swaps each table block for a short spoken placeholder.
export function stripMarkdownTablesForSpeech(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const table = detectTableAt(lines, i)
    if (table) {
      out.push('[table]')
      i = table.next
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

export function markdownToTelegramHtml(text) {
  const stash = []
  const stashHtml = html => {
    const token = `${STASH_MARK}${stash.length}${STASH_MARK}`
    stash.push(html)
    return token
  }

  let work = String(text ?? '').replace(/```(?:([a-zA-Z0-9_+-]+)\n|\n)?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const html = lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    return stashHtml(html)
  })

  work = replaceMarkdownTables(work, stashHtml)

  work = work.replace(/`([^`\n]+)`/g, (_, code) => stashHtml(`<code>${escapeHtml(code)}</code>`))

  work = escapeHtml(work)

  const noMark = c => `[^${c}\\n${STASH_MARK}]`
  work = work.replace(new RegExp(`(?<![\\w*])\\*\\*(${noMark('*')}+?)\\*\\*(?![\\w*])`, 'g'), '<b>$1</b>')
  work = work.replace(new RegExp(`(?<![\\w*])\\*(${noMark('*')}+?)\\*(?![\\w*])`, 'g'), '<i>$1</i>')
  work = work.replace(new RegExp(`(?<![\\w_])_(${noMark('_')}+?)_(?![\\w_])`, 'g'), '<i>$1</i>')
  work = work.replace(new RegExp(`(?<!~)~~(${noMark('~')}+?)~~(?!~)`, 'g'), '<s>$1</s>')
  work = work.replace(
    new RegExp(`\\[([^\\]\\n${STASH_MARK}]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)`, 'g'),
    (_, label, url) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  )

  work = wrapBlockquotes(work)

  work = work.replace(new RegExp(`${STASH_MARK}(\\d+)${STASH_MARK}`, 'g'), (_, i) => stash[Number(i)])

  return work
}

// Groups a table's lines into one queue entry so the chunker below doesn't split mid-table.
function toLogicalLines(lines) {
  const out = []
  let insideFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (fenceLangOf(line) !== null) {
      insideFence = !insideFence
      out.push(line)
      i++
      continue
    }
    if (!insideFence) {
      const table = detectTableAt(lines, i)
      if (table) {
        out.push([table.headerLine, table.sepLine, ...table.rowLines].join('\n'))
        i = table.next
        continue
      }
    }
    out.push(line)
    i++
  }
  return out
}

// A raw character split (splitToFit) loses a table's header/separator on every piece after the
// first, so a piece past that point can no longer be re-detected as a table. This regroups by
// whole rows instead, repeating the header/separator on each piece so every piece stays a table.
function splitTableRowsToFit(tableText, limit) {
  const [header, sep, ...rows] = tableText.split('\n')
  const build = rs => [header, sep, ...rs].join('\n')
  const pieces = []
  let acc = []
  for (const row of rows) {
    const candidate = [...acc, row]
    if (acc.length && markdownToTelegramHtml(build(candidate)).length > limit) {
      pieces.push(build(acc))
      acc = [row]
    } else {
      acc = candidate
    }
  }
  pieces.push(build(acc))
  return pieces
}

export function markdownToTelegramHtmlChunks(text, limit = 4096) {
  const src = String(text ?? '')
  if (!src) return []

  const render = (lns, openLang) =>
    markdownToTelegramHtml(openLang !== null ? [...lns, '```'].join('\n') : lns.join('\n'))
  const renderAlone = (piece, lang) => (lang !== null ? render([`\`\`\`${lang}`, piece], lang) : render([piece], null))

  const splitToFit = (line, lang) => {
    if (renderAlone(line, lang).length <= limit) return [line]
    let lo = 1
    let hi = line.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (renderAlone(line.slice(0, mid), lang).length <= limit) lo = mid
      else hi = mid - 1
    }
    const head = line.slice(0, lo)
    const rest = line.slice(lo)
    return rest ? [head, ...splitToFit(rest, lang)] : [head]
  }

  const isEmptyFenceBuffer = lns => lns.length > 0 && lns.every(l => fenceLangOf(l) !== null)

  const queue = toLogicalLines(src.split('\n'))
  const chunks = []
  let bufLines = []
  let fenceLang = null

  const flush = () => {
    if (!isEmptyFenceBuffer(bufLines)) chunks.push(render(bufLines, fenceLang))
    bufLines = fenceLang !== null ? [`\`\`\`${fenceLang}`] : []
  }

  while (queue.length) {
    const line = queue.shift()
    const isFenceMarker = fenceLangOf(line) !== null
    const nextFenceLang = isFenceMarker ? (fenceLang === null ? fenceLangOf(line) : null) : fenceLang

    if (renderAlone(line, nextFenceLang).length > limit) {
      if (bufLines.length) flush()
      fenceLang = nextFenceLang
      const lineRows = line.split('\n')
      const wholeTable = fenceLang === null ? detectTableAt(lineRows, 0) : null
      const rawPieces = wholeTable && wholeTable.next === lineRows.length ? splitTableRowsToFit(line, limit) : [line]
      for (const rawPiece of rawPieces) {
        if (renderAlone(rawPiece, fenceLang).length <= limit) chunks.push(renderAlone(rawPiece, fenceLang))
        else for (const piece of splitToFit(rawPiece, fenceLang)) chunks.push(renderAlone(piece, fenceLang))
      }
      bufLines = fenceLang !== null ? [`\`\`\`${fenceLang}`] : []
      continue
    }

    const candidate = [...bufLines, line]
    if (bufLines.length && render(candidate, nextFenceLang).length > limit) {
      flush()
      queue.unshift(line)
      continue
    }

    bufLines = candidate
    fenceLang = nextFenceLang
  }

  if (bufLines.length) {
    if (!isEmptyFenceBuffer(bufLines)) chunks.push(render(bufLines, fenceLang))
    else if (!chunks.length) chunks.push(render(bufLines, fenceLang))
  }
  return chunks
}

const STREAM_TAIL_NOTICE = '⋯ (showing latest part)\n\n'

export function renderStreamingTail(text, limit = 4096) {
  const src = String(text ?? '')
  if (!src.trim()) return null

  // markdownToTelegramHtmlChunks can't always honor `limit`: a single character can
  // expand past it on its own (e.g. "&" -> "&amp;", or ">" -> a <blockquote> wrapper),
  // and it has no smaller unit left to split into. So every path here re-checks the
  // actual rendered length against `limit` before returning, rather than trusting the
  // chunker's target size — dropping the tail (returning null) is always safe, an
  // over-limit edit is not.
  const chunks = markdownToTelegramHtmlChunks(src, limit)
  if (!chunks.length) return null
  if (chunks.length === 1) return chunks[0].length <= limit ? chunks[0] : null

  const tailLimit = limit - STREAM_TAIL_NOTICE.length
  // if there isn't even enough room for the notice itself, drop the tail rather than
  // returning something longer than the caller's limit
  if (tailLimit <= 0) return null
  const tailChunks = markdownToTelegramHtmlChunks(src, tailLimit)
  const tail = tailChunks[tailChunks.length - 1]
  const combined = `${STREAM_TAIL_NOTICE}${tail}`
  return combined.length <= limit ? combined : null
}

// Drops whole lines from the front until what's left fits — always HTML-safe since the
// input here is already-escaped plain text with no tags that a truncation could break.
function tailPlainTextLines(text, limit) {
  // guard against `limit <= 0` explicitly: `slice(-0)` is `slice(0)` in JS (returns the
  // whole string instead of nothing), so the natural-looking fallback below would
  // silently violate a zero/negative limit rather than truncating to it
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const lines = text.split('\n')
  let acc = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = acc ? `${lines[i]}\n${acc}` : lines[i]
    if (candidate.length > limit) break
    acc = candidate
  }
  return acc || lines[lines.length - 1].slice(-limit)
}

// Renders a progress transcript (frozen history lines + the segment currently streaming
// in) as Telegram-safe HTML. History lines are escaped-but-not-markdown-parsed plain text
// (so an arbitrary tool command/path can never be misread as formatting); only the live
// segment gets full markdown rendering, tail-capped to whatever budget remains after the
// (always-safe-to-truncate) history.
export function renderTranscriptHtml(historyLines, liveText, limit = 4096) {
  const lines = (historyLines ?? []).filter(Boolean)
  const historyText = tailPlainTextLines(lines.map(escapeHtml).join('\n'), limit)

  const reserved = historyText ? historyText.length + 1 : 0
  const liveBudget = limit - reserved
  const liveHtml = liveBudget > 0 && String(liveText ?? '').trim() ? renderStreamingTail(liveText, liveBudget) : null

  if (!historyText) return liveHtml
  return liveHtml ? `${historyText}\n${liveHtml}` : historyText
}

export function htmlToPlainFallback(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}
