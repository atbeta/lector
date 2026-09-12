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
      return `<div class="preform yaml">${esc(n.value ?? '')}</div>`
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
