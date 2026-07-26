import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToTelegramHtml, markdownToTelegramHtmlChunks, htmlToPlainFallback, renderStreamingTail } from '../markdown-html.mjs'

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

test('renderStreamingTail: empty/null/undefined/whitespace-only input yields null', () => {
  assert.equal(renderStreamingTail(''), null)
  assert.equal(renderStreamingTail(null), null)
  assert.equal(renderStreamingTail(undefined), null)
  assert.equal(renderStreamingTail('   \n  '), null)
})

test('renderStreamingTail: text under the limit renders in full with no truncation notice', () => {
  const text = 'Hello **world**, this is *streaming*.'
  assert.equal(renderStreamingTail(text, 4096), markdownToTelegramHtml(text))
})

test('renderStreamingTail: text over the limit is truncated to a tail chunk under the limit, prefixed with a notice', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
  const result = renderStreamingTail(text, 4096)
  assert.ok(result.length <= 4096, `result length ${result.length} exceeds the limit`)
  assert.ok(result.startsWith('⋯'), 'truncated tail should be prefixed with a notice')
  assert.ok(result.includes(`line 199`), 'tail should carry the most recent content')
  assert.ok(!result.includes('line 0 '), 'tail should not carry the earliest content')
})

test('renderStreamingTail: an unclosed fenced code block mid-stream renders as valid, balanced HTML', () => {
  const text = 'intro\n```js\nconst a = 1\nconst b = 2'
  const result = renderStreamingTail(text, 4096)
  assert.ok(result.includes('<pre><code class="language-js">'))
  assert.ok(result.includes('</code></pre>'))
})

test('renderStreamingTail: an unclosed inline bold/italic marker mid-stream stays literal instead of producing an unclosed tag', () => {
  const result = renderStreamingTail('this is **not yet closed', 4096)
  assert.ok(!result.includes('<b>'), 'should not open a <b> tag without its closing marker')
  assert.ok(result.includes('**not yet closed'))
})
