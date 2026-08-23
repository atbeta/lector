// mdast → HTML 的安全预览渲染。
// 只发已知标签；html / yaml / unknown 一律降级为等宽源码，绝不 dangerouslySetInnerHTML 任意值。

import { resolveImageSrc } from './asset.ts'

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
    case 'link':
      return `<a href="${esc(n.url ?? '')}"${n.title ? ` title="${esc(n.title)}"` : ''}>${inline(n.children)}</a>`
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
    return `<li class="task">${checkbox}${body}</li>`
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
      return `<pre><code class="language-${esc(n.lang ?? '')}">${esc(n.value ?? '')}</code></pre>`
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
      return `<table>${thead}<tbody>${tbody}</tbody></table>`
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

/** 渲染一个块级 mdast 节点为 HTML 字符串（mdast 来自 core，具体结构未知，内部校验）。 */
export function renderBlockHtml(mdast: unknown, rawFallback: string): string {
  const n = mdast as Node | null | undefined
  if (!n || typeof n.type !== 'string') {
    return `<div class="preform unknown">${esc(rawFallback)}</div>`
  }
  return blockToHtml(n)
}
