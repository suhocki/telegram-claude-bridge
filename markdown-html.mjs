// Converts Claude's markdown-ish replies into the small HTML subset Telegram's
// Bot API accepts with parse_mode: 'HTML' (https://core.telegram.org/bots/api#formatting-options).

const STASH_MARK = '\x00'

function escapeHtml(s) {
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

export function markdownToTelegramHtml(text) {
  const stash = []
  const stashHtml = html => {
    const token = `${STASH_MARK}${stash.length}${STASH_MARK}`
    stash.push(html)
    return token
  }

  let work = String(text ?? '').replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const html = lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    return stashHtml(html)
  })

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

export function htmlToPlainFallback(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}
