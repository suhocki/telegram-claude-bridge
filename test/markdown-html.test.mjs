import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  markdownToTelegramHtml,
  markdownToTelegramHtmlChunks,
  htmlToPlainFallback,
  renderRichTranscript,
  stripRichOnlyMarkup,
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

test('renderRichTranscript: history (no full text) is wrapped in a collapsed <details>, each line inline-code-wrapped so markdown chars are not interpreted', () => {
  const result = renderRichTranscript(['⏳ Bash: echo **not bold**…', '✅ Read: foo.py…'], '', { limit: 30000 })
  assert.equal(result, '<details><summary>🔧 2 steps</summary>\n\n`⏳ Bash: echo **not bold**…`\n`✅ Read: foo.py…`\n\n</details>')
  assert.ok(!result.includes('<details open'), 'draft history defaults to collapsed, not <details open>')
})

test('renderRichTranscript: singular "step" for exactly one history line', () => {
  const result = renderRichTranscript(['⏳ Bash: npm test…'], '', { limit: 30000 })
  assert.match(result, /<summary>🔧 1 step<\/summary>/)
})

test('renderRichTranscript: live text is appended outside (after) the collapsed details block', () => {
  const result = renderRichTranscript(['⏳ Bash: npm test…'], '**done**', { limit: 30000 })
  assert.equal(result, '<details><summary>🔧 1 step</summary>\n\n`⏳ Bash: npm test…`\n\n</details>\n\n**done**')
})

test('renderRichTranscript: falsy history entries are filtered out', () => {
  const result = renderRichTranscript(['⏳ Bash: npm test…', '', null, undefined], '', { limit: 30000 })
  assert.match(result, /<summary>🔧 1 step<\/summary>/)
})

test('renderRichTranscript: a history line (no full text) with a stray triple-backtick run gets a 4-backtick inline wrap instead of a 1-backtick one', () => {
  const result = renderRichTranscript(['⏳ Bash: grep \'```\' file.js…'], '', { limit: 30000 })
  assert.equal(result.match(/````/g).length, 2, 'exactly the opening and closing span, nothing closed early')
})

test('regression: a history line with 4+ consecutive backticks grows the inline wrap instead of letting it close early', () => {
  const result = renderRichTranscript(['⏳ Bash: grep \'````\' file.js…'], '', { limit: 30000 })
  const fiveBacktickRuns = result.match(/`{5,}/g)
  assert.equal(fiveBacktickRuns?.length, 2, 'the wrap must be longer than the embedded 4-backtick run, and only the real wrap ticks should match')
  assert.ok(result.includes('````'), 'the embedded 4-backtick run itself must still be present, unbroken, inside the wrap')
  assert.equal(result.match(/<\/details>/g).length, 1, 'the closing tag appears exactly once, proving nothing closed early')
})

test('renderRichTranscript: a history line with a full-text counterpart becomes its own expandable <details>, summary inline-wrapped, full body markdown intact', () => {
  const result = renderRichTranscript(['🤔 a short preview…'], '', { limit: 30000, fullTexts: ['the full, unabridged thinking with **markdown** intact'] })
  assert.equal(
    result,
    '<details><summary>🔧 1 step</summary>\n\n<details><summary>`🤔 a short preview…`</summary>\n\nthe full, unabridged thinking with **markdown** intact\n\n</details>\n\n</details>'
  )
})

test('regression: a summary line truncated mid-markdown-token (e.g. an unclosed **) is neutralized by the inline wrap, not left to bleed past </summary>', () => {
  const result = renderRichTranscript(['🤔 an unclosed **bold marker cut off…'], '', { limit: 30000, fullTexts: ['the full text here'] })
  assert.ok(result.includes('<summary>`🤔 an unclosed **bold marker cut off…`</summary>'), 'the lone ** stays literal, inside the safe inline span')
})

test('regression: a summary line with an embedded newline (e.g. a multi-line tool command) is collapsed to one line before being inline-wrapped', () => {
  const result = renderRichTranscript(['⏳ Bash: line one\nline two…'], '', { limit: 30000 })
  assert.ok(!result.includes('\nline two'), 'no literal newline survives inside the inline span')
  assert.ok(result.includes('line one line two'))
})

test('regression: a summary line containing a literal HTML tag (e.g. a grep pattern for "</details>") is escaped, not left able to close the surrounding tag', () => {
  const result = renderRichTranscript(['⏳ Bash: grep "</details><b>x</b>" file.js…'], '', { limit: 30000 })
  assert.equal(result.match(/<\/details>/g).length, 1, 'only the real, outer closing tag — the literal one in the line must not count as a second')
  assert.ok(result.includes('&lt;/details&gt;&lt;b&gt;x&lt;/b&gt;'), 'the literal tag text is escaped, not left as real markup')
})

test('regression: a full-text entry whose short summary line also contains a literal HTML tag is escaped the same way', () => {
  const result = renderRichTranscript(['🤔 discussing </details> tags…'], '', { limit: 30000, fullTexts: ['the full reasoning'] })
  assert.equal(result.match(/<\/details>/g).length, 2, 'exactly the inner and outer real closing tags')
  assert.ok(result.includes('&lt;/details&gt;'), 'the literal sequence in the summary is escaped too, not just in the full body')
})

test('regression: a line ending in a literal backtick gets a padding space, so it cannot fuse with the closing delimiter into a longer, mismatched run', () => {
  const line = '🤔 open the file`'
  const result = renderRichTranscript([line], '', { limit: 30000 })
  assert.equal(result, `<details><summary>🔧 1 step</summary>\n\n\`\` ${line} \`\`\n\n</details>`)
  assert.ok(!result.includes('file````'), 'the trailing backtick must not fuse with the closing delimiter into one longer run')
})

test('regression: a line starting with a literal backtick also gets a padding space on both sides', () => {
  const line = '`ls -la'
  const result = renderRichTranscript([line], '', { limit: 30000 })
  const opening = result.match(/^<details><summary>🔧 1 step<\/summary>\n\n(`+)/)[1]
  assert.ok(result.includes(`${opening} ${line} ${opening}`))
})

test('regression: a literal "</details>" inside the model\'s own full text cannot close the wrapper tag early', () => {
  const result = renderRichTranscript(['🤔 discussing html…'], '', { limit: 30000, fullTexts: ['as in </details><b>injected</b>, see?'] })
  assert.equal(result.match(/<\/details>/g).length, 2, 'exactly the inner and outer closing tags — the literal one in the text must not count as a third')
  assert.ok(result.includes('&lt;/details&gt;'), 'the literal sequence is escaped, not left as real markup')
  assert.ok(!result.includes('<b>injected</b>'), 'content after the literal sequence must not turn into real, unescaped HTML')
})

test('renderRichTranscript: a mix of tool-call lines (no full text) and a thinking line (with full text) renders each appropriately', () => {
  const result = renderRichTranscript(
    ['⏳ Bash: npm test…', '🤔 short…', '✅ Read: foo.py…'],
    '',
    { limit: 30000, fullTexts: [null, 'the full thinking text', undefined] }
  )
  assert.ok(result.includes('`⏳ Bash: npm test…`'), 'tool line stays inline-wrapped, no expansion')
  assert.ok(result.includes('<details><summary>`🤔 short…`</summary>\n\nthe full thinking text\n\n</details>'), 'thinking line becomes its own nested expandable section')
  assert.ok(result.includes('`✅ Read: foo.py…`'), 'tool line stays inline-wrapped, no expansion')
})

test('regression: falsy entries in fullTexts (missing index, null, undefined, empty string) all fall back to the safe inline wrap, not an empty expandable body', () => {
  const result = renderRichTranscript(['💬 said something…'], '', { limit: 30000, fullTexts: [''] })
  assert.ok(!result.includes('<details><summary>💬'), 'an empty full text must not produce a pointless nested expandable section')
  assert.ok(result.includes('`💬 said something…`'))
})

test('regression: oldest whole entries drop first under a tight budget, keeping the most recent ones (with their expansion) intact', () => {
  const history = Array.from({ length: 20 }, (_, i) => `⏳ Bash: step ${i}…`)
  const fullTexts = history.map((_, i) => (i === 19 ? 'the full text of the most recent step' : null))
  const result = renderRichTranscript(history, '', { limit: 300, fullTexts })
  assert.ok(result.length <= 300, `result length ${result.length} exceeds the 300 limit`)
  assert.ok(result.includes('the full text of the most recent step'), 'the most recent entry, and its expansion, survives')
  assert.ok(!result.includes('step 0…'), 'the oldest entries are dropped first, as whole entries')
})

test('regression: the "🔧 N steps" summary reflects how many entries actually survived truncation, not the original pre-drop count', () => {
  const history = Array.from({ length: 20 }, (_, i) => `⏳ Bash: step ${i}…`)
  const result = renderRichTranscript(history, '', { limit: 300 })
  const survivingCount = result.split('\n').filter(line => line.startsWith('`⏳')).length
  assert.ok(survivingCount < 20, 'sanity check: this limit must actually force some entries to drop')
  assert.match(result, new RegExp(`<summary>🔧 ${survivingCount} steps</summary>`), 'the header must count what is actually shown, not the original 20')
})

test('regression: when even the single most recent entry (with its own expandable body) cannot fit, it degrades to its plain short line instead of vanishing', () => {
  const result = renderRichTranscript(['🤔 a short preview…'], '', { limit: 120, fullTexts: ['x'.repeat(500)] })
  assert.notEqual(result, null, 'the entry itself must still show up, just without the expansion')
  assert.ok(result.length <= 120, `result length ${result?.length} exceeds the 120 limit`)
  assert.ok(result.includes('`🤔 a short preview…`'), 'degrades to the safe inline-wrapped short line')
  assert.ok(!result.includes('xxxx'), 'the oversized full text itself must not appear at all')
})

test('regression: when even the degraded plain short line cannot fit at all, history is dropped entirely instead of showing an empty-bodied "N steps" wrapper', () => {
  const result = renderRichTranscript(['⏳ Bash: npm test…'], '', { limit: 55 })
  assert.equal(result, null, 'a misleading "🔧 1 step" header over nothing must not be returned')
})

test('regression: a large in-flight live answer that leaves no room for even one degraded history line drops history, not just live text', () => {
  const live = 'x'.repeat(29950)
  const result = renderRichTranscript(['⏳ Bash: npm test…'], live, { limit: 30000 })
  assert.ok(!result.includes('<details'), 'no misleading empty-bodied wrapper — this is realistic (a long streaming answer), not a contrived tiny limit')
  assert.ok(result.length <= 30000)
  assert.ok(live.endsWith(result))
})

test('regression: renderRichTranscript with limit 0 (or negative) returns null rather than a string that violates the limit', () => {
  const history = ['a very long history line that would normally need truncating down to size']
  for (const limit of [0, -1, -100]) {
    const result = renderRichTranscript(history, 'some live text too', { limit })
    assert.equal(result, null, `limit ${limit}: expected null (the <details> wrapper alone can't fit), got ${JSON.stringify(result)}`)
  }
})

test('regression: renderRichTranscript never returns text longer than a limit that at least fits the empty wrapper', () => {
  const history = Array.from({ length: 50 }, (_, i) => `⏳ Bash: a fairly long step description number ${i}…`)
  for (const limit of [80, 200, 1000, 30000]) {
    const result = renderRichTranscript(history, 'some live text too', { limit })
    assert.ok(result === null || result.length <= limit, `limit ${limit}: got length ${result?.length}`)
  }
})

test('renderRichTranscript: under a tight limit, the live text (shown outside the collapsed block) is always kept in full, and history is tail-truncated by whole lines to make room', () => {
  const history = Array.from({ length: 50 }, (_, i) => `⏳ Bash: a fairly long step description number ${i}…`)
  const result = renderRichTranscript(history, 'this must always appear', { limit: 400 })
  assert.ok(result.length <= 400, `result length ${result.length} exceeds the 400 limit`)
  assert.ok(result.includes('this must always appear'), 'the live tail is the "front line" of activity and is never dropped')
  assert.ok(result.includes('number 49'), 'the history tail should keep the most recent lines, dropping older ones instead')
})

test('regression: renderRichTranscript truncates the live text (not bails to null) when history is non-empty but live alone would overflow the limit', () => {
  const history = ['⏳ Bash: npm test…']
  const live = 'z'.repeat(500)
  const result = renderRichTranscript(history, live, { limit: 200 })
  assert.notEqual(result, null, 'a long live segment must not blank out an otherwise-renderable draft')
  assert.ok(result.length <= 200, `result length ${result?.length} exceeds the 200 limit`)
  assert.ok(result.endsWith('z'), 'the live tail (kept in preference to history) is what survives at the end')
})

test('stripRichOnlyMarkup: removes the <details>/<summary> wrapper tags, keeping the inner content', () => {
  const result = stripRichOnlyMarkup('<details><summary>🔧 1 step</summary>\n\n`⏳ Bash: npm test…`\n\n</details>')
  assert.ok(!result.includes('<details'), 'the opening tag must not survive')
  assert.ok(!result.includes('</details>'), 'the closing tag must not survive')
  assert.ok(!result.includes('<summary>'), 'the summary open tag must not survive')
  assert.ok(result.includes('🔧 1 step'), 'the summary text itself is kept, just unwrapped')
  assert.ok(result.includes('`⏳ Bash: npm test…`'), 'the body content is kept as-is')
})

test('stripRichOnlyMarkup: plain text with no rich-only tags at all is returned unchanged', () => {
  assert.equal(stripRichOnlyMarkup('✅ done'), '✅ done')
  assert.equal(stripRichOnlyMarkup('**bold** and `code`'), '**bold** and `code`')
})

test('stripRichOnlyMarkup: null/undefined input becomes an empty string, not a crash', () => {
  assert.equal(stripRichOnlyMarkup(null), '')
  assert.equal(stripRichOnlyMarkup(undefined), '')
})

test('regression: stripRichOnlyMarkup leaves an HTML-escaped "</details>" (from user content, not this renderer\'s own wrapping) untouched', () => {
  const escaped = '`⏳ Bash: grep &lt;/details&gt; file.js…`'
  assert.equal(stripRichOnlyMarkup(escaped), escaped)
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
