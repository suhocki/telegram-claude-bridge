import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  markdownToTelegramHtml,
  markdownToTelegramHtmlChunks,
  htmlToPlainFallback,
  renderRichTranscript,
  stripRenderedTableGridsForSpeech,
  richMessageToSpeechText,
} from '../markdown-html.mjs'

test('markdownToTelegramHtml: escapes bare &, <, > outside any markdown construct', () => {
  assert.equal(markdownToTelegramHtml('1 < 2 && 3 > 1'), '1 &lt; 2 &amp;&amp; 3 &gt; 1')
})

test('markdownToTelegramHtml: converts **bold** to <b>', () => {
  assert.equal(markdownToTelegramHtml('hello **world**'), 'hello <b>world</b>')
})

test('markdownToTelegramHtml: converts *italic* and _italic_ to <i>', () => {
  assert.equal(markdownToTelegramHtml('a *b* c _d_ e'), 'a <i>b</i> c <i>d</i> e')
})

test('markdownToTelegramHtml: a lone single asterisk (e.g. multiplication) is left untouched', () => {
  assert.equal(markdownToTelegramHtml('2 * 3 = 6'), '2 * 3 = 6')
})

test('markdownToTelegramHtml: an underscore inside an identifier is not treated as italic', () => {
  assert.equal(markdownToTelegramHtml('snake_case_var stays as is'), 'snake_case_var stays as is')
})

test('markdownToTelegramHtml: converts ~~strike~~ to <s>', () => {
  assert.equal(markdownToTelegramHtml('a ~~gone~~ word'), 'a <s>gone</s> word')
})

test('markdownToTelegramHtml: converts [text](url) to <a href>, escaping quotes in the url', () => {
  assert.equal(
    markdownToTelegramHtml('see [docs](https://example.com/a"b)'),
    'see <a href="https://example.com/a&quot;b">docs</a>',
  )
})

test('markdownToTelegramHtml: ignores non-http(s) link targets (left as literal markdown)', () => {
  assert.equal(markdownToTelegramHtml('[home](javascript:alert(1))'), '[home](javascript:alert(1))')
})

test('markdownToTelegramHtml: converts an inline code span to <code>, escaping its content', () => {
  assert.equal(markdownToTelegramHtml('run `a < b` now'), 'run <code>a &lt; b</code> now')
})

test('markdownToTelegramHtml: converts a fenced code block with a language to <pre><code class="language-x">', () => {
  assert.equal(
    markdownToTelegramHtml('```js\nconst x = 1 < 2;\n```'),
    '<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>',
  )
})

test('markdownToTelegramHtml: converts a fenced code block without a language to plain <pre>', () => {
  assert.equal(markdownToTelegramHtml('```\nplain block\n```'), '<pre>plain block</pre>')
})

test('markdownToTelegramHtml: a single-line fenced block with no trailing newline keeps its content, with no language guessed from the leading text', () => {
  assert.equal(
    markdownToTelegramHtml("run ```printf('%d', x)``` now"),
    "run <pre>printf('%d', x)</pre> now",
  )
  assert.equal(markdownToTelegramHtml('run ```ls -la``` now'), 'run <pre>ls -la</pre> now')
})

test('markdownToTelegramHtml: a real language tag is still recognized when followed by a newline', () => {
  assert.equal(
    markdownToTelegramHtml('```python\nprint(1)\n```'),
    '<pre><code class="language-python">print(1)</code></pre>',
  )
})

test('markdownToTelegramHtml: markdown syntax inside a code span/block is not converted', () => {
  assert.equal(markdownToTelegramHtml('`**not bold**`'), '<code>**not bold**</code>')
  assert.equal(markdownToTelegramHtml('```\n**not bold**\n```'), '<pre>**not bold**</pre>')
})

test('markdownToTelegramHtml: wraps a single "> " line in <blockquote>', () => {
  assert.equal(markdownToTelegramHtml('> quoted'), '<blockquote>quoted</blockquote>')
})

test('markdownToTelegramHtml: groups consecutive quoted lines into one <blockquote>', () => {
  assert.equal(
    markdownToTelegramHtml('> line one\n> line two\nnormal'),
    '<blockquote>line one\nline two</blockquote>\nnormal',
  )
})

test('markdownToTelegramHtml: a code span inside ** is left un-bolded to avoid nesting code under <b>', () => {
  assert.equal(markdownToTelegramHtml('**bold with `code` inside**'), '**bold with <code>code</code> inside**')
})

test('markdownToTelegramHtml: combines multiple constructs in one message', () => {
  assert.equal(
    markdownToTelegramHtml('**Note:** use `npm test`, see [docs](https://example.com) — 1 < 2'),
    '<b>Note:</b> use <code>npm test</code>, see <a href="https://example.com">docs</a> — 1 &lt; 2',
  )
})

test('markdownToTelegramHtml: renders a GFM pipe table as an aligned <pre> grid', () => {
  assert.equal(
    markdownToTelegramHtml('| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 5 |'),
    '<pre>Name  | Age\n------+----\nAlice | 30 \nBob   | 5  </pre>',
  )
})

test('markdownToTelegramHtml: table separator with alignment colons is still recognized', () => {
  assert.equal(
    markdownToTelegramHtml('| A | B |\n|:---|---:|\n| x | y |'),
    '<pre>A | B\n--+--\nx | y</pre>',
  )
})

test('markdownToTelegramHtml: escapes HTML-sensitive characters inside table cells', () => {
  assert.equal(
    markdownToTelegramHtml('| Tag |\n|-----|\n| <b> & 1 < 2 |'),
    '<pre>Tag        \n-----------\n&lt;b&gt; &amp; 1 &lt; 2</pre>',
  )
})

test('markdownToTelegramHtml: a short row of dashes with no preceding pipe line is left as plain text', () => {
  assert.equal(markdownToTelegramHtml('above\n---\nbelow'), 'above\n---\nbelow')
})

test('markdownToTelegramHtml: prose containing a literal "|" followed by an unrelated "---" divider is not misread as a table', () => {
  assert.equal(
    markdownToTelegramHtml('Use a pipe (|) between commands\n---\nThis section explains further.'),
    'Use a pipe (|) between commands\n---\nThis section explains further.',
  )
})

test('markdownToTelegramHtml: a separator whose column count does not match the header is not a table', () => {
  assert.equal(markdownToTelegramHtml('| A | B |\n|---|\nnext'), '| A | B |\n|---|\nnext')
})

test('markdownToTelegramHtml: markdown syntax inside table cells is not converted (rendered as literal text)', () => {
  assert.equal(
    markdownToTelegramHtml('| Col |\n|-----|\n| **bold** `code` |'),
    '<pre>Col            \n---------------\n**bold** `code`</pre>',
  )
})

test('markdownToTelegramHtml: a table followed by more text keeps both', () => {
  assert.equal(
    markdownToTelegramHtml('| A |\n|---|\n| 1 |\nafter'),
    '<pre>A\n-\n1</pre>\nafter',
  )
})

test('markdownToTelegramHtml: an emoji cell is measured as 2 display columns wide, not 1 code point or 2 UTF-16 units', () => {
  assert.equal(
    markdownToTelegramHtml('| Status | Task |\n|--------|------|\n| 😀 | build |\n| ok | deploy |'),
    '<pre>Status | Task  \n-------+-------\n😀     | build \nok     | deploy</pre>',
  )
})

test('markdownToTelegramHtml: a CJK (double-width) cell aligns against ASCII cells in the same column', () => {
  assert.equal(
    markdownToTelegramHtml('| Name | Note |\n|------|------|\n| 张三 | ok |\n| Bob | fine |'),
    '<pre>Name | Note\n-----+-----\n张三 | ok  \nBob  | fine</pre>',
  )
})

test('markdownToTelegramHtml: a row with more cells than the header has the excess dropped, per GFM', () => {
  assert.equal(
    markdownToTelegramHtml('| A | B |\n|---|---|\n| 1 | 2 | 3 |'),
    '<pre>A | B\n--+--\n1 | 2</pre>',
  )
})

test('markdownToTelegramHtml: an emoji from the misc-symbols/dingbats block (e.g. checkmarks) is also measured as 2 columns wide', () => {
  assert.equal(
    markdownToTelegramHtml('| Status | Icon |\n|--------|------|\n| ok | ✅ |\n| bad | ❌ |'),
    '<pre>Status | Icon\n-------+-----\nok     | ✅  \nbad    | ❌  </pre>',
  )
})

test('markdownToTelegramHtml: a header with only an escaped pipe (no real column separator) followed by an unrelated "---" divider is not misread as a table', () => {
  assert.equal(
    markdownToTelegramHtml('To show a literal pipe use `a\\|b`.\n---\nThis section explains further.'),
    'To show a literal pipe use <code>a\\|b</code>.\n---\nThis section explains further.',
  )
})

test('markdownToTelegramHtml: empty/null/undefined input becomes an empty string', () => {
  assert.equal(markdownToTelegramHtml(''), '')
  assert.equal(markdownToTelegramHtml(null), '')
  assert.equal(markdownToTelegramHtml(undefined), '')
})

test('htmlToPlainFallback: strips tags and unescapes entities back to plain text', () => {
  assert.equal(
    htmlToPlainFallback('<b>Note:</b> use <code>npm test</code>, 1 &lt; 2 &amp; 3 &gt; 1'),
    'Note: use npm test, 1 < 2 & 3 > 1',
  )
})

test('htmlToPlainFallback: unescapes &quot;', () => {
  assert.equal(htmlToPlainFallback('<a href="https://example.com/a&quot;b">docs</a>'), 'docs')
})

test('htmlToPlainFallback: round-trips markdownToTelegramHtml output back to readable plain text', () => {
  const html = markdownToTelegramHtml('**bold** and `code` and 1 < 2')
  assert.equal(htmlToPlainFallback(html), 'bold and code and 1 < 2')
})

test('markdownToTelegramHtmlChunks: empty/null/undefined input yields no chunks', () => {
  assert.deepEqual(markdownToTelegramHtmlChunks(''), [])
  assert.deepEqual(markdownToTelegramHtmlChunks(null), [])
  assert.deepEqual(markdownToTelegramHtmlChunks(undefined), [])
})

test('markdownToTelegramHtmlChunks: short text under the limit renders as a single chunk identical to markdownToTelegramHtml', () => {
  const text = 'hello **world**'
  assert.deepEqual(markdownToTelegramHtmlChunks(text, 4096), [markdownToTelegramHtml(text)])
})

test('markdownToTelegramHtmlChunks: every chunk stays within the given limit', () => {
  const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n')
  const md = `intro text\n\n\`\`\`js\n${bigCode}\n\`\`\`\n\nend text`
  const chunks = markdownToTelegramHtmlChunks(md, 500)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 500, `chunk of length ${c.length} exceeds limit`)
})

test('markdownToTelegramHtmlChunks: a fenced code block split across chunks keeps balanced <pre>/<code> tags in every chunk', () => {
  const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n')
  const md = `intro text\n\n\`\`\`js\n${bigCode}\n\`\`\`\n\nend text`
  const chunks = markdownToTelegramHtmlChunks(md, 500)
  for (const c of chunks) {
    const opens = (c.match(/<pre>/g) || []).length
    const closes = (c.match(/<\/pre>/g) || []).length
    assert.equal(opens, closes, `unbalanced <pre> in chunk: ${c}`)
    const codeOpens = (c.match(/<code[ >]/g) || []).length
    const codeCloses = (c.match(/<\/code>/g) || []).length
    assert.equal(codeOpens, codeCloses, `unbalanced <code> in chunk: ${c}`)
  }
})

test('markdownToTelegramHtmlChunks: reassembling the code content across chunks (ignoring the reopened fence markers) preserves every source line', () => {
  const bigCode = Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n')
  const md = `\`\`\`js\n${bigCode}\n\`\`\``
  const chunks = markdownToTelegramHtmlChunks(md, 500)
  const combined = chunks.join('')
  for (let i = 0; i < 300; i++) assert.ok(combined.includes(`const line${i} = ${i};`), `missing line${i}`)
})

test('markdownToTelegramHtmlChunks: a table is kept as one atomic block instead of being split mid-row across chunks', () => {
  const filler = 'x'.repeat(150)
  const rows = Array.from({ length: 5 }, (_, i) => `| Item ${i} | value-${i} |`).join('\n')
  const md = `${filler}\n\n| Name | Value |\n|------|-------|\n${rows}`
  const chunks = markdownToTelegramHtmlChunks(md, 200)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 200)
  const tableChunk = chunks.find(c => c.includes('<pre>'))
  assert.ok(tableChunk, 'no chunk contains the rendered table')
  for (let i = 0; i < 5; i++) assert.ok(tableChunk.includes(`Item ${i}`), `row ${i} missing from the table chunk`)
  const preOpens = (tableChunk.match(/<pre>/g) || []).length
  const preCloses = (tableChunk.match(/<\/pre>/g) || []).length
  assert.equal(preOpens, preCloses, `unbalanced <pre> in table chunk: ${tableChunk}`)
})

test('markdownToTelegramHtmlChunks: a table too big for one chunk is split by whole rows, repeating the header on each piece, instead of leaking raw pipe text', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `| Item ${i} | value-${i} |`).join('\n')
  const md = `| Name | Value |\n|------|-------|\n${rows}`
  const chunks = markdownToTelegramHtmlChunks(md, 300)
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    assert.ok(c.length <= 300)
    assert.ok(c.startsWith('<pre>Name'), `piece lost its table header: ${c}`)
    const withoutPre = c.replace(/<pre>[\s\S]*?<\/pre>/g, '')
    assert.ok(!withoutPre.includes('|'), `raw unrendered pipe text leaked outside <pre>: ${c}`)
  }
  const combined = chunks.join('')
  for (let i = 0; i < 50; i++) assert.ok(combined.includes(`Item ${i}`), `missing row ${i}`)
})

test('markdownToTelegramHtmlChunks: a table inside a fenced code block is left as literal code, not parsed as a real table', () => {
  const md = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
  assert.equal(markdownToTelegramHtmlChunks(md, 4096)[0], markdownToTelegramHtml(md))
})

test('markdownToTelegramHtmlChunks: content split at a plain-text boundary matches chunk-then-render behavior', () => {
  const text = Array.from({ length: 50 }, (_, i) => `paragraph number ${i} of plain text here.`).join('\n')
  const chunks = markdownToTelegramHtmlChunks(text, 200)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 200)
  const combinedText = chunks.join('\n')
  for (let i = 0; i < 50; i++) assert.ok(combinedText.includes(`paragraph number ${i} of plain text here.`))
})

test('markdownToTelegramHtmlChunks: a single line whose rendered form alone exceeds the limit is hard-split without exceeding it', () => {
  const longLine = 'x'.repeat(9000)
  const md = `\`\`\`js\n${longLine}\n\`\`\``
  const chunks = markdownToTelegramHtmlChunks(md, 4096)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 4096)
  assert.equal(chunks.join('').replace(/<[^>]*>/g, '').length, longLine.length)
})

test('markdownToTelegramHtmlChunks: worst-case HTML-escaping content (all "&") never overflows the limit', () => {
  const amp = '&'.repeat(4000)
  const md = `\`\`\`\n${amp}\n\`\`\``
  const chunks = markdownToTelegramHtmlChunks(md, 4096)
  for (const c of chunks) assert.ok(c.length <= 4096)
})

test('markdownToTelegramHtmlChunks: hard-splitting an over-long first line of a fenced block does not emit a spurious empty leading chunk', () => {
  const longLine = 'x'.repeat(9000)
  const md = `\`\`\`js\n${longLine}\n\`\`\``
  const chunks = markdownToTelegramHtmlChunks(md, 4096)
  const isEmptyFence = c => /^<pre>(<code[^>]*>)?<\/code>?<\/pre>$/.test(c)
  for (const c of chunks) assert.ok(!isEmptyFence(c), `chunk is an empty fenced block: ${c}`)
  assert.ok(chunks[0].includes('xxx'), 'first chunk should carry real content, not just an empty fence')
})

test('markdownToTelegramHtmlChunks: hard-splitting an over-long last line of a fenced block does not emit a spurious empty trailing chunk', () => {
  const longLine = 'x'.repeat(9000)
  const md = `intro\n\`\`\`js\nconst a = 1;\n${longLine}\n\`\`\``
  const chunks = markdownToTelegramHtmlChunks(md, 4096)
  const isEmptyFence = c => /^<pre>(<code[^>]*>)?<\/code>?<\/pre>$/.test(c)
  for (const c of chunks) assert.ok(!isEmptyFence(c), `chunk is an empty fenced block: ${c}`)
  assert.ok(chunks[chunks.length - 1].includes('xxx'), 'last chunk should carry real content, not just an empty fence')
})

test('markdownToTelegramHtmlChunks: a message that is only an empty fenced code block still yields one chunk instead of none', () => {
  const chunks = markdownToTelegramHtmlChunks('```\n```', 4096)
  assert.deepEqual(chunks, ['<pre></pre>'])
})

test('renderRichTranscript: no history, just returns the trimmed live text raw (Telegram parses the markdown itself)', () => {
  assert.equal(renderRichTranscript([], '**hi**', { limit: 30000 }), '**hi**')
  assert.equal(renderRichTranscript([], '  hi  ', { limit: 30000 }), 'hi')
})

test('renderRichTranscript: no history and no live text returns null', () => {
  assert.equal(renderRichTranscript([], '', { limit: 30000 }), null)
  assert.equal(renderRichTranscript(undefined, undefined, { limit: 30000 }), null)
})

test('regression: renderRichTranscript truncates live-only text (no history yet) to the limit instead of returning it unbounded', () => {
  const live = 'x'.repeat(500)
  const result = renderRichTranscript([], live, { limit: 100 })
  assert.ok(result.length <= 100, `result length ${result.length} exceeds the 100 limit`)
  assert.ok(live.endsWith(result), 'the kept text is the tail of the live text, not something else')
})

test('renderRichTranscript: history (no full text) is always visible, not collapsed, each line has markdown-reserved characters backslash-escaped so they are not interpreted as formatting, and stays in the normal (non-monospace) font', () => {
  const result = renderRichTranscript(['Bash: echo **not bold**…', 'Read: foo.py…'], '', { limit: 30000 })
  assert.equal(result, 'Bash: echo \\*\\*not bold\\*\\*…\n\nRead: foo\\.py…')
  assert.ok(!result.includes('<details'), 'the progress list itself is never wrapped in a collapsed section')
  assert.ok(!result.includes('`'), 'no inline code span (monospace) wraps the line')
})

test('renderRichTranscript: live text is appended after the (always-visible) history', () => {
  const result = renderRichTranscript(['Bash: npm test…'], '**done**', { limit: 30000 })
  assert.equal(result, 'Bash: npm test…\n\n**done**')
})

test('renderRichTranscript: falsy history entries are filtered out', () => {
  const result = renderRichTranscript(['Bash: npm test…', '', null, undefined], '', { limit: 30000 })
  assert.equal(result, 'Bash: npm test…')
})

test('renderRichTranscript: a history line (no full text) with literal backticks gets each one backslash-escaped instead of being turned into a monospace code span', () => {
  const result = renderRichTranscript(["Bash: grep '```' file.js…"], '', { limit: 30000 })
  assert.equal(result, "Bash: grep '\\`\\`\\`' file\\.js…")
  assert.ok(!result.includes('<details'), 'a line with no full text has no details wrapper at all')
})

test('renderRichTranscript: a tool-call entry ({ prefix, code, suffix }) renders as a fenced code block (monospace, tinted background), not just an inline span', () => {
  const result = renderRichTranscript([{ prefix: 'Bash: ', code: 'npm test', suffix: '…' }], '', { limit: 30000 })
  assert.equal(result, '```\nBash: npm test…\n```')
})

test('renderRichTranscript: a code-block value containing a run of backticks gets a fence one backtick longer than the longest run inside it', () => {
  const result = renderRichTranscript([{ prefix: 'Bash: ', code: 'grep "```" file.js', suffix: '…' }], '', { limit: 30000 })
  assert.equal(result, '````\nBash: grep "```" file.js…\n````')
})

test('renderRichTranscript: a code-block value starting or ending with a literal backtick does not need any padding — the fence sits on its own line, so it cannot fuse with the content', () => {
  const leading = renderRichTranscript([{ prefix: 'Bash: ', code: '`ls -la', suffix: '…' }], '', { limit: 30000 })
  assert.equal(leading, '```\nBash: `ls -la…\n```')
  const trailing = renderRichTranscript([{ prefix: 'Bash: ', code: 'open the file`', suffix: '…' }], '', { limit: 30000 })
  assert.equal(trailing, '```\nBash: open the file`…\n```')
})

test('renderRichTranscript: markdown-reserved characters inside a code-block value are left completely literal (no backslash-escaping), unlike the surrounding prose', () => {
  const result = renderRichTranscript(
    [{ prefix: 'Bash: ', code: 'grep -n "Read:\\|⏳\\|mergePendingCheckin\\|pendingCheckins\\b"', suffix: '…' }],
    '',
    { limit: 30000 }
  )
  assert.equal(result, '```\nBash: grep -n "Read:\\|⏳\\|mergePendingCheckin\\|pendingCheckins\\b"…\n```')
  assert.ok(!result.includes('\\\\|'), 'a literal backslash must not have been injected in front of the pipes')
})

test('renderRichTranscript: HTML-sensitive characters inside a code-block value are still entity-escaped, matching this file\'s existing defensive posture', () => {
  const result = renderRichTranscript([{ prefix: 'Bash: ', code: 'grep "<script>" file', suffix: '…' }], '', { limit: 30000 })
  assert.equal(result, '```\nBash: grep "&lt;script&gt;" file…\n```')
})

test('renderRichTranscript: an embedded newline inside a code-block value (e.g. a multi-line command) is preserved as a real line break inside the block', () => {
  const result = renderRichTranscript([{ prefix: 'Bash: ', code: 'line one\nline two', suffix: '…' }], '', { limit: 30000 })
  assert.equal(result, '```\nBash: line one\nline two…\n```')
})

test('renderRichTranscript: a 💬/🤔 line stays plain prose even when other entries in the same transcript are code-block tool calls', () => {
  const result = renderRichTranscript(
    ['💬 Found it, writing the fix', { prefix: 'Bash: ', code: 'npm test', suffix: '…' }],
    '',
    { limit: 30000 }
  )
  assert.equal(result, '💬 Found it, writing the fix\n\n```\nBash: npm test…\n```')
})

test('renderRichTranscript: the size budget measures a code-block entry by its rendered (fenced + escaped) length, not the raw value length', () => {
  const history = [
    { prefix: 'Bash: ', code: '&'.repeat(50), suffix: '…' }, // escapes to 5x length: &amp; each
    { prefix: 'Bash: ', code: 'y'.repeat(50), suffix: '…' },
  ]
  const result = renderRichTranscript(history, '', { limit: 120 })
  assert.ok(result.length <= 120, `result length ${result.length} exceeds the 120 limit`)
  assert.ok(!result.includes('&amp;'), 'the heavily-escaping entry must have been the one dropped to make room')
  assert.ok(result.includes('y'.repeat(50)), 'the cheaper entry survives')
})

test('regression: markdown-reserved characters in a summary line (asterisk, underscore, brackets, parens, tilde, backtick, hash, plus, hyphen, equals, pipe, braces, period, exclamation, dollar, backslash) are each backslash-escaped', () => {
  const result = renderRichTranscript(['try _this_ [x](y) ~n~ #1 a+b a-b a=b a|b {c} d.e f! g\\h $5…'], '', { limit: 30000 })
  assert.equal(result, 'try \\_this\\_ \\[x\\]\\(y\\) \\~n\\~ \\#1 a\\+b a\\-b a\\=b a\\|b \\{c\\} d\\.e f\\! g\\\\h \\$5…')
})

test('regression: a raw ">" in a summary line is already inert via escapeHtml (turned into "&gt;"), so it need not also be in the markdown-reserved backslash-escape set', () => {
  const result = renderRichTranscript(['a > b'], '', { limit: 30000 })
  assert.equal(result, 'a &gt; b')
})

test('renderRichTranscript: a history line with a full-text counterpart becomes its own expandable <details>, summary escaped (not code-span-wrapped), full body markdown intact', () => {
  const result = renderRichTranscript(['🤔 a short preview…'], '', { limit: 30000, fullTexts: ['the full, unabridged thinking with **markdown** intact'] })
  assert.equal(
    result,
    '<details><summary>🤔 a short preview…</summary>\n\nthe full, unabridged thinking with **markdown** intact\n\n</details>'
  )
})

test('regression: a summary line truncated mid-markdown-token (e.g. an unclosed **) is neutralized by backslash-escaping, not left to bleed past </summary>', () => {
  const result = renderRichTranscript(['🤔 an unclosed **bold marker cut off…'], '', { limit: 30000, fullTexts: ['the full text here'] })
  assert.ok(result.includes('<summary>🤔 an unclosed \\*\\*bold marker cut off…</summary>'), 'the lone ** stays literal, escaped so it cannot toggle bold')
})

test('regression: a summary line with an embedded newline (e.g. a multi-line tool command) is collapsed to one line before being inline-wrapped', () => {
  const result = renderRichTranscript(['Bash: line one\nline two…'], '', { limit: 30000 })
  assert.ok(!result.includes('\nline two'), 'no literal newline survives inside the inline span')
  assert.ok(result.includes('line one line two'))
})

test('regression: a summary line containing a literal HTML tag (e.g. a grep pattern for "</details>") is escaped, not left able to fake a real closing tag', () => {
  const result = renderRichTranscript(['Bash: grep "</details><b>x</b>" file.js…'], '', { limit: 30000 })
  assert.equal(result.match(/<\/details>/g), null, 'no real closing tag exists at all for a line with no full text')
  assert.ok(result.includes('&lt;/details&gt;&lt;b&gt;x&lt;/b&gt;'), 'the literal tag text is escaped, not left as real markup')
})

test('regression: a full-text entry whose short summary line also contains a literal HTML tag is escaped the same way', () => {
  const result = renderRichTranscript(['🤔 discussing </details> tags…'], '', { limit: 30000, fullTexts: ['the full reasoning'] })
  assert.equal(result.match(/<\/details>/g).length, 1, 'exactly the one real closing tag, from the entry\'s own expandable wrapper')
  assert.ok(result.includes('&lt;/details&gt;'), 'the literal sequence in the summary is escaped too, not just in the full body')
})

test('regression: a line ending in a literal backtick is simply backslash-escaped in place — no delimiter-fusion risk since there is no longer a surrounding code-span delimiter', () => {
  const result = renderRichTranscript(['🤔 open the file`'], '', { limit: 30000 })
  assert.equal(result, '🤔 open the file\\`')
})

test('regression: a line starting with a literal backtick is likewise just backslash-escaped in place, no leading delimiter to fuse with', () => {
  const result = renderRichTranscript(['`ls -la'], '', { limit: 30000 })
  assert.equal(result, '\\`ls \\-la')
})

test('regression: a literal "</details>" inside the model\'s own full text cannot close the wrapper tag early', () => {
  const result = renderRichTranscript(['🤔 discussing html…'], '', { limit: 30000, fullTexts: ['as in </details><b>injected</b>, see?'] })
  assert.equal(result.match(/<\/details>/g).length, 1, 'exactly the one real closing tag — the literal one in the text must not count as a second')
  assert.ok(result.includes('&lt;/details&gt;'), 'the literal sequence is escaped, not left as real markup')
  assert.ok(!result.includes('<b>injected</b>'), 'content after the literal sequence must not turn into real, unescaped HTML')
})

test('renderRichTranscript: a mix of tool-call lines (no full text) and a thinking line (with full text) renders each appropriately', () => {
  const result = renderRichTranscript(
    ['Bash: npm test…', '🤔 short…', 'Read: foo.py…'],
    '',
    { limit: 30000, fullTexts: [null, 'the full thinking text', undefined] }
  )
  assert.ok(result.includes('Bash: npm test…'), 'tool line stays unwrapped, no expansion')
  assert.ok(result.includes('<details><summary>🤔 short…</summary>\n\nthe full thinking text\n\n</details>'), 'thinking line becomes its own nested expandable section')
  assert.ok(result.includes('Read: foo\\.py…'), 'tool line stays unwrapped, no expansion')
})

test('renderRichTranscript: a code-block tool-call entry never gets an expandable <details> wrapper, even mixed with a thinking line that does', () => {
  const result = renderRichTranscript(
    [{ prefix: 'Bash: ', code: 'npm test', suffix: '…' }, '🤔 short…'],
    '',
    { limit: 30000, fullTexts: [null, 'the full thinking text'] }
  )
  assert.ok(result.includes('```\nBash: npm test…\n```'), 'the code-block line renders monospace, unwrapped')
  assert.ok(result.includes('<details><summary>🤔 short…</summary>\n\nthe full thinking text\n\n</details>'), 'the thinking line still gets its own expandable section')
  assert.equal(result.match(/<details>/g).length, 1, 'exactly one <details> wrapper — the code-block entry contributes none')
})

test('regression: falsy entries in fullTexts (missing index, null, undefined, empty string) all fall back to the safe escaped line, not an empty expandable body', () => {
  const result = renderRichTranscript(['💬 said something…'], '', { limit: 30000, fullTexts: [''] })
  assert.ok(!result.includes('<details'), 'an empty full text must not produce a pointless nested expandable section')
  assert.equal(result, '💬 said something…')
})

test('regression: when not everything fits, every step degrades to its short form before any step is dropped entirely', () => {
  const history = Array.from({ length: 20 }, (_, i) => `Bash: step ${i}…`)
  const fullTexts = history.map((_, i) => (i === 19 ? 'the full text of the most recent step' : null))
  const result = renderRichTranscript(history, '', { limit: 300, fullTexts })
  assert.ok(result.length <= 300, `result length ${result.length} exceeds the 300 limit`)
  assert.ok(result.includes('step 19'), 'the most recent entry survives, even though its own expansion had to degrade to make room')
  assert.ok(!result.includes('the full text of the most recent step'), 'showing every step in short form outranks any single expansion')
  assert.ok(!result.includes('step 0…'), 'once even the fully degraded set does not fit, the oldest whole entries drop first')
  const survivingCount = result.split('\n').filter(line => line.startsWith('Bash:')).length
  assert.equal(survivingCount, 19, 'pins the exact number kept, so a mutant that over-drops (e.g. down to just the newest) cannot pass unnoticed')
})

test('regression: a huge expansion on one entry does not evict short older entries that would easily fit — the expansion degrades first', () => {
  const history = ['Bash: npm test…', 'Read: foo.py…', '🤔 a long reconsideration…']
  const fullTexts = [null, null, 'x'.repeat(6000)]
  const result = renderRichTranscript(history, '', { limit: 200, fullTexts })
  assert.ok(result.length <= 200, `result length ${result.length} exceeds the 200 limit`)
  assert.ok(result.includes('Bash: npm test…'), 'an older short entry must not be dropped just because a newer one has a huge expansion')
  assert.ok(result.includes('Read: foo\\.py…'), 'same for the second older entry')
  assert.ok(!result.includes('xxxx'), 'the oversized expansion itself must not appear once degraded')
})

test('regression: degrade order is by actual rendered contribution, not raw pre-escape text length, so HTML-heavy content is ranked correctly', () => {
  const history = ['A', 'B']
  const fullTexts = ['&'.repeat(500), 'y'.repeat(600)]
  const result = renderRichTranscript(history, '', { limit: 700, fullTexts })
  assert.ok(result.length <= 700, `result length ${result.length} exceeds the 700 limit`)
  assert.ok(result.includes('y'.repeat(600)), "B's raw text is longer, but A's escaped '&amp;'-expansion is the real (larger) cost and must degrade first")
})

test('regression: a small expansion survives even when a larger, unrelated expansion is what forces degradation', () => {
  const history = ['🤔 an old, longer thought…', '💬 a tiny recent note…']
  const fullTexts = ['x'.repeat(300), 'tiny-full-B']
  const result = renderRichTranscript(history, '', { limit: 250, fullTexts })
  assert.ok(result.length <= 250, `result length ${result.length} exceeds the 250 limit`)
  assert.ok(result.includes('tiny-full-B'), "the small entry's own cheap expansion must not be collateral damage from degrading the larger one")
  assert.ok(!result.includes('xxxx'), 'the oversized expansion is what degrades, not the small one')
})

test('regression: when even the single most recent entry (with its own expandable body) cannot fit, it degrades to its plain short line instead of vanishing', () => {
  const result = renderRichTranscript(['🤔 a short preview…'], '', { limit: 120, fullTexts: ['x'.repeat(500)] })
  assert.notEqual(result, null, 'the entry itself must still show up, just without the expansion')
  assert.ok(result.length <= 120, `result length ${result?.length} exceeds the 120 limit`)
  assert.ok(result.includes('🤔 a short preview…'), 'degrades to the safe escaped short line')
  assert.ok(!result.includes('xxxx'), 'the oversized full text itself must not appear at all')
})

test('regression: when even the degraded plain short line cannot fit at all, history is dropped entirely instead of returning a partial line that violates the limit', () => {
  const result = renderRichTranscript(['Bash: npm test…'], '', { limit: 10 })
  assert.equal(result, null, 'a line that cannot fit within the limit must not be returned partially')
})

test('regression: a large in-flight live answer that leaves no room for even one degraded history line drops history, not just live text', () => {
  const live = 'x'.repeat(35000)
  const result = renderRichTranscript(['Bash: npm test…'], live, { limit: 30000 })
  assert.ok(!result.includes('Bash: npm test'), 'no history rendering survives when there is truly no room left')
  assert.ok(result.length <= 30000)
  assert.ok(live.endsWith(result))
})

test('regression: renderRichTranscript with limit 0 (or negative) returns null rather than a string that violates the limit', () => {
  const history = ['a very long history line that would normally need truncating down to size']
  for (const limit of [0, -1, -100]) {
    const result = renderRichTranscript(history, 'some live text too', { limit })
    assert.equal(result, null, `limit ${limit}: expected null (nothing can fit within a non-positive limit), got ${JSON.stringify(result)}`)
  }
})

test('regression: renderRichTranscript never returns text longer than the given limit', () => {
  const history = Array.from({ length: 50 }, (_, i) => `Bash: a fairly long step description number ${i}…`)
  for (const limit of [80, 200, 1000, 30000]) {
    const result = renderRichTranscript(history, 'some live text too', { limit })
    assert.ok(result === null || result.length <= limit, `limit ${limit}: got length ${result?.length}`)
  }
})

test('renderRichTranscript: under a tight limit, the live text is always kept in full, and history is tail-truncated by whole lines to make room', () => {
  const history = Array.from({ length: 50 }, (_, i) => `Bash: a fairly long step description number ${i}…`)
  const result = renderRichTranscript(history, 'this must always appear', { limit: 400 })
  assert.ok(result.length <= 400, `result length ${result.length} exceeds the 400 limit`)
  assert.ok(result.includes('this must always appear'), 'the live tail is the "front line" of activity and is never dropped')
  assert.ok(result.includes('number 49'), 'the history tail should keep the most recent lines, dropping older ones instead')
})

test('regression: renderRichTranscript truncates the live text (not bails to null) when history is non-empty but live alone would overflow the limit', () => {
  const history = ['Bash: npm test…']
  const live = 'z'.repeat(500)
  const result = renderRichTranscript(history, live, { limit: 200 })
  assert.notEqual(result, null, 'a long live segment must not blank out an otherwise-renderable draft')
  assert.ok(result.length <= 200, `result length ${result?.length} exceeds the 200 limit`)
  assert.ok(result.endsWith('z'), 'the live tail (kept in preference to history) is what survives at the end')
})

test('stripRenderedTableGridsForSpeech: replaces an already-rendered table grid (Telegram\'s own plain message.text, used by the Listen button) with a spoken placeholder', () => {
  const rendered = htmlToPlainFallback(markdownToTelegramHtml('Summary:\n\n| Name | Age |\n|------|-----|\n| Alice | 30 |\n\nDone.'))
  assert.equal(stripRenderedTableGridsForSpeech(rendered), 'Summary:\n\ntable data\n\nDone.')
})

test('stripRenderedTableGridsForSpeech: text with no table grid is left unchanged', () => {
  assert.equal(stripRenderedTableGridsForSpeech('no table here at all'), 'no table here at all')
})

// Shapes below (except heading/expandable_blockquote/custom_emoji) are captured verbatim from a real sendRichMessage response (Bot API 10.1).
test('richMessageToSpeechText: a table block becomes the same short spoken placeholder regardless of cell content', () => {
  const richMessage = {
    blocks: [
      {
        type: 'table',
        cells: [
          [{ text: 'Company', is_header: true, align: 'center', valign: 'middle' }, { text: 'Match', is_header: true, align: 'center', valign: 'middle' }],
          [{ text: 'TradingView', align: 'left', valign: 'middle' }, { text: '90%', align: 'left', valign: 'middle' }],
        ],
        is_bordered: true,
        is_striped: true,
      },
    ],
  }
  assert.equal(richMessageToSpeechText(richMessage), 'table data')
})

test('richMessageToSpeechText: a paragraph with mixed plain-string and typed RichText entries (bold/code) flattens to plain words', () => {
  const richMessage = {
    blocks: [
      {
        type: 'paragraph',
        text: [{ type: 'bold', text: 'Итог:' }, ' протестировал ', { type: 'code', text: 'sendRichMessage' }, ' напрямую.'],
      },
    ],
  }
  assert.equal(richMessageToSpeechText(richMessage), 'Итог: протестировал sendRichMessage напрямую.')
})

test('richMessageToSpeechText: a blockquote unwraps its nested paragraph blocks', () => {
  const richMessage = { blocks: [{ type: 'blockquote', blocks: [{ type: 'paragraph', text: 'цитата для проверки' }] }] }
  assert.equal(richMessageToSpeechText(richMessage), 'цитата для проверки')
})

test('richMessageToSpeechText: a pre (code) block reads its plain text', () => {
  const richMessage = { blocks: [{ type: 'pre', text: 'const x = 1;', language: 'js' }] }
  assert.equal(richMessageToSpeechText(richMessage), 'const x = 1;')
})

test('richMessageToSpeechText: a list joins each item\'s blocks, one per line', () => {
  const richMessage = {
    blocks: [
      {
        type: 'list',
        items: [
          { label: '•', blocks: [{ type: 'paragraph', text: 'пункт 1' }] },
          { label: '•', blocks: [{ type: 'paragraph', text: 'пункт 2' }] },
        ],
      },
    ],
  }
  assert.equal(richMessageToSpeechText(richMessage), 'пункт 1\nпункт 2')
})

test('richMessageToSpeechText: a link RichText (object with url + nested text) reads its label', () => {
  const richMessage = { blocks: [{ type: 'paragraph', text: { type: 'url', text: 'link', url: 'https://example.com/' } }] }
  assert.equal(richMessageToSpeechText(richMessage), 'link')
})

test('richMessageToSpeechText: multiple blocks join with a blank line between them', () => {
  const richMessage = { blocks: [{ type: 'paragraph', text: 'first' }, { type: 'paragraph', text: 'second' }] }
  assert.equal(richMessageToSpeechText(richMessage), 'first\n\nsecond')
})

test('richMessageToSpeechText: a heading block reads its text', () => {
  assert.equal(richMessageToSpeechText({ blocks: [{ type: 'heading', text: 'Section title', size: 2 }] }), 'Section title')
})

test('richMessageToSpeechText: an expandable_blockquote (collapsed-by-default quote) reads its text field, not a nested blocks array', () => {
  assert.equal(richMessageToSpeechText({ blocks: [{ type: 'expandable_blockquote', text: 'collapsed quote' }] }), 'collapsed quote')
})

test('richMessageToSpeechText: a details block reads its always-visible summary plus its nested blocks', () => {
  const richMessage = { blocks: [{ type: 'details', summary: 'Tool output', blocks: [{ type: 'paragraph', text: 'full log line' }] }] }
  assert.equal(richMessageToSpeechText(richMessage), 'Tool output\nfull log line')
})

test('richMessageToSpeechText: a custom_emoji RichText node (no `text` field) falls back to its alternative_text', () => {
  const richMessage = { blocks: [{ type: 'paragraph', text: { type: 'custom_emoji', custom_emoji_id: '123', alternative_text: '🔥' } }] }
  assert.equal(richMessageToSpeechText(richMessage), '🔥')
})

test('richMessageToSpeechText: a mathematical_expression block reads its LaTeX source (stored under expression, not text)', () => {
  assert.equal(richMessageToSpeechText({ blocks: [{ type: 'mathematical_expression', expression: 'E = mc^2' }] }), 'E = mc^2')
})

test('richMessageToSpeechText: no blocks (or no rich_message at all) yields an empty string', () => {
  assert.equal(richMessageToSpeechText({ blocks: [] }), '')
  assert.equal(richMessageToSpeechText(null), '')
  assert.equal(richMessageToSpeechText(undefined), '')
})
