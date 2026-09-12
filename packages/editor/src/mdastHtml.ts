// mdast → HTML 的安全预览渲染。
// 只发已知标签；html / yaml / unknown 一律降级为等宽源码，绝不 dangerouslySetInnerHTML 任意值。

import { resolveImageSrc } from './asset.ts'
import { highlightCode } from './highlight.ts'

type Node =
  | { type: string; value?: string; depth?: number; ordered?: boolean; start?: number; lang?: string; url?: string; title?: string; alt?: string; checked?: boolean | null; children?: Node[]; position?: unknown }

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(children: Node[] | undefined): string {
  if (!children) return ''
  return children.map((c) => inlineNode(c)).join('')
}

/** 预览链接只允许安全协议；危险协议降级为纯文本。 */
export function safeHref(url: string): string | null {
  const t = url.trim()
  if (!t) return null
  if (t.startsWith('#')) return t
  if (/^(https?:|mailto:)/i.test(t)) return t
  // 无 scheme 的相对路径：可以展示，点击时由编辑器拦截导航
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return t
  return null
}

function inlineNode(n: Node): string {
  switch (n.type) {
    case 'text':
      return esc(n.value ?? '')
    case 'emphasis':
      return `<em>${inline(n.children)}</em>`
    case 'strong':
      return `<strong>${inline(n.children)}</strong>`
    case 'delete':
      return `<del>${inline(n.children)}</del>`
    case 'inlineCode':
      return `<code>${esc(n.value ?? '')}</code>`
    case 'link': {
      const href = safeHref(n.url ?? '')
      if (!href) return `<span>${inline(n.children)}</span>`
      return `<a href="${esc(href)}"${n.title ? ` title="${esc(n.title)}"` : ''}>${inline(n.children)}</a>`
    }
    case 'image':
      return `<img src="${esc(resolveImageSrc(n.url ?? ''))}" alt="${esc(n.alt ?? '')}" />`
    case 'break':
      return '<br />'
    case 'html':
      // 行内 HTML：转义降级为原文
      return `<code>${esc(n.value ?? '')}</code>`
    default:
      return esc(n.value ?? '')
  }
}

function listItems(list: Node): string {
  const items = (list.children ?? []).map((item: Node) => {
    const task = item.checked !== undefined && item.checked !== null
    const checkbox = task
      ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''} /> `
      : ''
    // listItem 的 children 通常是 paragraph 或嵌套 list
    const body = (item.children ?? []).map((c) => blockToHtml(c)).join('')
    // 任务项正文包一层 .task-label：已完成态给它加删除线即可，不必把整行压暗
    // （压暗会读成「禁用」，而未完成反而最亮，层级就反了）。
    // 这里必须是 div 不能是 span：body 里是 <p>，把块级塞进行内元素属于非法嵌套，
    // 浏览器会把 span 就地闭合，删除线就落在空元素上。
    return task ? `<li class="task">${checkbox}<div class="task-label">${body}</div></li>` : `<li>${body}</li>`
  })
  return items.join('\n')
}

/**
 * Frontmatter 渲染成「属性卡」而不是一坨 YAML。
 *
 * 阅读场景里 frontmatter 是元数据（标题、作者、日期、标签），读者要看的是
 * 「有哪些字段、值是什么」，不是缩进和引号。源码仍然完好在块里，
 * 点击这块仍会切成原始 YAML 编辑——这里只改预览。
 *
 * 支持两种形状，其余退回等宽源码：
 *   1. `key: value`
 *   2. `key:` 后跟一串缩进的 `- item`（标签列表，真实 frontmatter 最常见的形状）
 * 嵌套对象（`key:` 下面是 `子键: 值`）不解析：两列表格表达不了缩进层次，
 * 硬塞会失真，那种情况给源码更诚实。
 */
function renderFrontmatter(raw: string): string {
  const lines = raw.split('\n')
  const rows: Array<{ key: string; value: string | null; list: string[] | null }> = []
  let fallback = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    if (/^\s/.test(line)) continue // 缩进行由所属字段消费，这里跳过

    const m = line.match(/^([^:#][^:]*):\s*(.*)$/)
    if (!m) {
      fallback = true
      break
    }
    const key = m[1]!.trim()
    const rest = m[2]!.trim()

    if (rest !== '') {
      rows.push({ key, value: rest, list: null })
      continue
    }

    // 值为空：往后收集缩进的 `- item`
    const items: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const next = lines[j]!
      if (next.trim() === '') continue
      const item = next.match(/^\s+-\s*(.*)$/)
      if (!item) break
      items.push(item[1]!.trim())
    }
    if (items.length > 0) {
      rows.push({ key, value: null, list: items })
      i = j - 1
      continue
    }
    // 没有列表项：还要看紧跟的缩进块是不是「子键: 值」。
    // 是的话这是嵌套对象——两列表格表达不了缩进层次，整体退回源码；
    // 若直接当空值渲染成「—」，用户会以为这个字段真的没值。
    let k = i + 1
    for (; k < lines.length; k++) {
      const next = lines[k]!
      if (next.trim() === '') continue
      if (/^\s+\S/.test(next)) {
        fallback = true
        break
      }
      break
    }
    if (fallback) break
    rows.push({ key, value: null, list: null })
  }

  if (fallback || rows.length === 0) {
    return `<div class="preform yaml">${esc(raw)}</div>`
  }

  const cells = rows
    .map(({ key, value, list }) => {
      let rendered: string
      if (list) {
        // 标签列表渲染成 chips：一眼看出有几个标签，比一行 `- 甲 - 乙` 好读
        rendered = `<span class="fm-list">${list
          .map((it) => `<span class="fm-tag">${inlineText(it)}</span>`)
          .join('')}</span>`
      } else if (value) {
        rendered = inlineText(value)
      } else {
        rendered = '<span class="fm-empty">—</span>'
      }
      return `<div class="fm-key">${esc(key)}</div><div class="fm-value">${rendered}</div>`
    })
    .join('')
  return `<div class="frontmatter">${cells}</div>`
}

/** 行内元素的最小解析：只处理链接与代码，用于 frontmatter 的短值。 */
function inlineText(v: string): string {
  return esc(v)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
      const safe = safeHref(href)
      // 协议不安全时留纯文本：塞个 href="null" 比不解析更糟
      return safe ? `<a href="${esc(safe)}">${text}</a>` : text
    })
}

function blockToHtml(n: Node): string {
  switch (n.type) {
    case 'paragraph':
      return `<p>${inline(n.children)}</p>`
    case 'heading': {
      const h = Math.min(6, Math.max(1, n.depth ?? 1))
      return `<h${h}>${inline(n.children)}</h${h}>`
    }
    case 'list': {
      const tag = n.ordered ? 'ol' : 'ul'
      return `<${tag}>${listItems(n)}</${tag}>`
    }
    case 'blockquote': {
      const body = (n.children ?? []).map((c) => blockToHtml(c)).join('')
      return `<blockquote>${body}</blockquote>`
    }
    case 'code': {
      // 高亮只改显示，不改源码：token 由 highlightCode 转义后包 span
      const lang = n.lang ?? ''
      return `<pre><code class="language-${esc(lang)}">${highlightCode(n.value ?? '', lang)}</code></pre>`
    }
    case 'thematicBreak':
      return '<hr />'
    case 'table': {
      const rows = n.children ?? []
      const head = rows[0]
      const bodyRows = rows.slice(1)
      const thead = head
        ? `<thead><tr>${(head.children ?? [])
            .map((c: Node) => `<th>${inline(c.children)}</th>`)
            .join('')}</tr></thead>`
        : ''
      const tbody = bodyRows
        .map(
          (r: Node) =>
            `<tr>${(r.children ?? [])
              .map((c: Node) => `<td>${inline(c.children)}</td>`)
              .join('')}</tr>`,
        )
        .join('')
      return `<div class="table-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>`
    }
    case 'yaml':
      return renderFrontmatter(n.value ?? '')
    case 'html':
      // 块级 HTML：安全降级为等宽源码
      return `<pre class="preform">${esc(n.value ?? '')}</pre>`
    default:
      // 未知块：等宽源码
      return `<div class="preform">${esc(n.value ?? '')}</div>`
  }
}

function renderOne(mdast: unknown, rawFallback: string): string {
  const n = mdast as Node | null | undefined
  if (!n || typeof n.type !== 'string') {
    return `<div class="preform unknown">${esc(rawFallback)}</div>`
  }
  return blockToHtml(n)
}

/** 渲染一块（或脏块产生的多个根）为 HTML。 */
export function renderBlockHtml(mdast: unknown, rawFallback: string): string {
  if (Array.isArray(mdast)) {
    if (mdast.length === 0) return renderOne(null, rawFallback)
    return mdast.map((n) => renderOne(n, rawFallback)).join('')
  }
  return renderOne(mdast, rawFallback)
}
