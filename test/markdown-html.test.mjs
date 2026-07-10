import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToTelegramHtml, htmlToPlainFallback } from '../markdown-html.mjs'

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
