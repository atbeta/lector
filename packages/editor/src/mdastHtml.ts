// mdast → HTML 的安全预览渲染。
// 只发已知标签；白名单外的 html / yaml / unknown 降级为等宽源码，绝不 dangerouslySetInnerHTML 任意值。

import { resolveImageSrc } from './asset.ts'
import { highlightCode } from './highlight.ts'
import { renderMathToHtml, _resetCacheForTests as _resetMathCache } from './katex.ts'
import { t } from './i18n.ts'
import { iconSvg } from './icons.ts'
import { decodeEntities, parseBlockRoots } from '@lector/core'

/** 行内 HTML 白名单：无属性开闭标签，micromark 会拆成三个节点再在这里配对。 */
const INLINE_HTML_TAGS = 'kbd|sub|sup|u|mark'
const INLINE_HTML_OPEN = new RegExp(`^<(${INLINE_HTML_TAGS})>$`, 'i')
const INLINE_HTML_CLOSE = new RegExp(`^<\\/(${INLINE_HTML_TAGS})>$`, 'i')
const INLINE_HTML_SIMPLE = new RegExp(`^<(${INLINE_HTML_TAGS})>([^<]*)<\\/\\1>$`, 'i')

/** HTML `<img>` 只认这四个属性；其余（on* / style / srcset…）整段降级。 */
const HTML_IMG_ATTRS = new Set(['src', 'alt', 'width', 'height'])

type Node =
  | { type: string; value?: string; depth?: number; ordered?: boolean; start?: number; lang?: string; url?: string; title?: string; alt?: string; checked?: boolean | null; identifier?: string; label?: string; align?: Array<'left' | 'right' | 'center' | null> | null; children?: Node[]; position?: unknown }

/**
 * 判断一段行内 $…$ 内容是不是「真的数学公式」。
 *
 * micromark-extension-math 没有 Pandoc 的防误判，会把「$5 - $10 之间」这种
 * 价格/区间也解析成 inlineMath（实测 value=`5 - `、`5-`、`100 到 `）。
 * 它们不是公式，硬塞给 KaTeX 只会渲染成一行错位的数学（还悄无声息地把 `$` 吃掉）。
 * 守卫用「是否会含数学记号/变量名」做粗筛：含反斜杠宏、上/下标、花括号、
 * 或拉丁字母（变量名）才当公式；纯数字/标点/中文本的当普通文本，不渲染成公式。
 */
export function looksLikeMath(tex: string): boolean {
  const t = tex.trim()
  if (t === '') return false
  return /[_^{}\\]/.test(t) || /[a-zA-Z]/.test(t)
}

/**
 * 预渲染缓存：key=`block|inline::tex`,value=已转义 HTML。
 * preRenderMath(allBlocks) 填表,blockToHtml / inlineNode 同步读。
 * 依赖调用顺序: render() 头里先调一次 preRenderMath(blocks),下面再 renderBlockHtml。
 * 缓存 miss（理论不会发生,会在 preRenderMath 阶段全部填好）走原文。
 */
const mathHtmlCache = new Map<string, string>()
function mathKey(display: boolean, tex: string): string {
  return `${display ? 'block' : 'inline'}::${tex}`
}

/**
 * ==高亮== 是否按高亮渲染。
 *
 * 解析层始终认得 `==…==`（core 的 pandoc mark 扩展），这里只管**渲染成什么**：
 * 关掉时把定界符原样补回去——「不支持这个语法」的正确表现是让你看见源文，
 * 而不是把两个等号吃掉、留一段没有颜色的文字。设置项见 settings.markHighlight。
 * 放在模块级而不是逐层传参：渲染是纯函数调用链，加参数只会污染一整条签名。
 */
let markHighlight = true

export function setMarkHighlight(on: boolean): void {
  markHighlight = on
}

/**
 * `$…$` / `$$…$$` 是否渲染成公式。关掉时原样显示美元符号（同 setMarkHighlight）。
 * 与 markHighlight 同属「Markdown 扩展语法」设置。
 */
let mathEnabled = true

export function setMathEnabled(on: boolean): void {
  mathEnabled = on
}

/** 走一块 mdast,找出所有 math / inlineMath,调 katex 渲完后填表。
 *  单条公式出错绝不让整篇崩：renderMathToHtml 的 reject 在这里被吃掉，
 *  把该式的退化原文写进缓存，渲染层读到就按原样显示。 */
export async function preRenderMath(blocks: ReadonlyArray<{ mdast: unknown }>): Promise<void> {
  const pending: Array<Promise<void>> = []
  for (const b of blocks) {
    visitMath(b.mdast, (tex, display) => {
      const k = mathKey(display, tex)
      if (mathHtmlCache.has(k)) return
      // 行内非公式（货币/区间等）不渲染成公式——直接略过，inlineNode 再兜底原文
      if (!display && !looksLikeMath(tex)) return
      pending.push(
        renderMathToHtml(tex, display)
          .then((html) => {
            mathHtmlCache.set(k, html)
          })
          .catch((err) => {
            console.error('[lector] math render failed:', tex, err)
            // 行内/块级分开：.math-error 是 display:block，塞进行内会把整行打断，
            // 行内用 display:inline 的 math-error-inline，勉强可读的退化原文。
            const cls = display ? 'math-error' : 'math-error-inline'
            mathHtmlCache.set(k, `<span class="${cls}">${esc(tex)}</span>`)
          }),
      )
    })
  }
  await Promise.all(pending)
}

function visitMath(
  mdast: unknown,
  cb: (tex: string, display: boolean) => void,
): void {
  const n = mdast as Node | Node[] | null | undefined
  if (!n) return
  if (Array.isArray(n)) {
    for (const c of n) visitMath(c, cb)
    return
  }
  if (n.type === 'math' && typeof n.value === 'string') cb(n.value, true)
  else if (n.type === 'inlineMath' && typeof n.value === 'string') cb(n.value, false)
  else if (n.children) visitMath(n.children, cb)
}

/** 测试钩子:清空预渲染缓存。 */
export function _resetMathHtmlCacheForTests(): void {
  mathHtmlCache.clear()
  _resetMathCache()
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 白名单 HTML `<img>`：只认 src/alt/数字宽高，src 走 resolveImageSrc。
 * 带 on* / style / srcset 等未知属性、危险协议、解析失败 → null（调用方转义降级）。
 * 渲出的节点带 data-html-img，图片菜单据此不把它算进 listImages 下标。
 */
function renderHtmlImg(value: string): string | null {
  const raw = value.trim()
  const wrapped = /^<p>\s*(<img\b[\s\S]*?\/?>)\s*<\/p>$/i.exec(raw)
  const tag = (wrapped?.[1] ?? raw).trim()
  const m = /^<img(\s[\s\S]*)?\/?>$/i.exec(tag)
  if (!m) return null
  const attrs = parseHtmlAttrs(m[1] ?? '')
  if (!attrs) return null
  for (const key of Object.keys(attrs)) {
    if (!HTML_IMG_ATTRS.has(key)) return null
  }
  const srcRaw = (attrs.src ?? '').trim()
  if (!srcRaw) return null
  // javascript: / vbscript: / file: 不能当相对路径漏出去（resolveImageSrc 会把未知 scheme 当文件名）
  if (/^[a-z][a-z0-9+.-]*:/i.test(srcRaw) && !/^(https?:|data:)/i.test(srcRaw)) return null
  const src = resolveImageSrc(srcRaw)
  if (!src) return null
  const alt = attrs.alt ?? ''
  const width = parseImgDimension(attrs.width)
  const height = parseImgDimension(attrs.height)
  if (attrs.width != null && width == null) return null
  if (attrs.height != null && height == null) return null
  const dim = `${width != null ? ` width="${width}"` : ''}${height != null ? ` height="${height}"` : ''}`
  return `<img src="${esc(src)}" alt="${esc(alt)}"${dim} data-html-img="1" />`
}

/** 只认纯数字或数字+px；拒 100% / auto / 表达式。 */
function parseImgDimension(raw: string | undefined): string | null {
  if (raw == null) return null
  const m = /^(\d+)(?:px)?$/i.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n <= 0 || n > 10000) return null
  return String(n)
}

/**
 * 极小属性解析：名=值，值可双引/单引/无引号。布尔属性、重复名、解析失败一律 null。
 * 不做通用 HTML 解析——只够 lone <img> 的白名单属性。
 */
function parseHtmlAttrs(input: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  let i = 0
  const s = input
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break
    if (s[i] === '/') {
      i++
      continue
    }
    if (!/[A-Za-z_]/.test(s[i]!)) return null
    const start = i
    i++
    while (i < s.length && /[\w:-]/.test(s[i]!)) i++
    const name = s.slice(start, i).toLowerCase()
    if (name.startsWith('on')) return null
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (s[i] !== '=') return null
    i++
    while (i < s.length && /\s/.test(s[i]!)) i++
    let value = ''
    const q = s[i]
    if (q === '"' || q === "'") {
      i++
      const end = s.indexOf(q, i)
      if (end < 0) return null
      value = s.slice(i, end)
      i = end + 1
    } else {
      const vStart = i
      while (i < s.length && !/[\s/>]/.test(s[i]!)) i++
      if (i === vStart) return null
      value = s.slice(vStart, i)
    }
    if (Object.hasOwn(out, name)) return null
    out[name] = decodeEntities(value)
  }
  return out
}

/**
 * 纯数字单元格：可带正负号、千分位、小数，可带常见单位/后缀。
 * 长度设上限，是为了别把 "2026-09-14 的会议记录" 这种也判成数字。
 */
const NUMERIC_CELL =
  /^[~≈±]?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|ms|s|min|hours?|h|px|em|rem|kb|mb|gb|tb|k|m|b|次|个|条|张|行|字|天|小时|分钟|秒)?$/i

/** 是否该右对齐（数字列）。导出是为了能被单测直接盯住。 */
export function isNumericCell(text: string): boolean {
  return text.length > 0 && text.length <= 24 && NUMERIC_CELL.test(text)
}

function wrapInlineHtml(tag: string, inner: string): string {
  // mark 跟 ==高亮== 共用开关与样式：关掉时把定界符（这里是标签）原样露出来。
  if (tag === 'mark') {
    return markHighlight
      ? `<mark class="html-mark">${inner}</mark>`
      : `&lt;mark&gt;${inner}&lt;/mark&gt;`
  }
  return `<${tag} class="html-${tag}">${inner}</${tag}>`
}

function inline(children: Node[] | undefined): string {
  if (!children) return ''
  // 白名单行内标签（kbd/sub/sup/u/mark）被 micromark 拆成「开标签/文本/闭标签」
  // 三个节点——这里跨节点配对包裹；br / 白名单 <img> 直接放行；其余转义降级。
  const out: string[] = []
  const pending: { tag: string; outIndex: number; raw: string }[] = []
  for (const c of children) {
    if (c.type === 'html') {
      const v = c.value ?? ''
      const open = v.match(INLINE_HTML_OPEN)
      const close = v.match(INLINE_HTML_CLOSE)
      if (open) {
        pending.push({ tag: open[1]!.toLowerCase(), outIndex: out.length, raw: v })
        out.push('')
        continue
      }
      if (close) {
        const tag = close[1]!.toLowerCase()
        const top = pending[pending.length - 1]
        if (top && top.tag === tag) {
          pending.pop()
          const inner = out.slice(top.outIndex + 1).join('')
          out.length = top.outIndex
          out.push(wrapInlineHtml(tag, inner))
          continue
        }
        out.push(`<code>${esc(v)}</code>`)
        continue
      }
      if (/^<br\s*\/?>$/i.test(v)) {
        out.push('<br />')
        continue
      }
      const img = renderHtmlImg(v)
      if (img) {
        out.push(img)
        continue
      }
      out.push(`<code>${esc(v)}</code>`)
      continue
    }
    out.push(inlineNode(c))
  }
  // 未配对的开标签：占位还原为转义源码
  for (const p of pending) out[p.outIndex] = `<code>${esc(p.raw)}</code>`
  return out.join('')
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
      return `<a href="${esc(href)}"${n.title ? ` data-tip="${esc(n.title)}"` : ''}>${inline(n.children)}</a>`
    }
    case 'image':
      return `<img src="${esc(resolveImageSrc(n.url ?? ''))}" alt="${esc(n.alt ?? '')}" />`
    case 'inlineMath': {
      const tex = n.value ?? ''
      // 关掉「Markdown 扩展语法 → 内联公式」：原样吐回 `$…$`，让用户看见源文。
      if (!mathEnabled) return `$${esc(tex)}$`
      // 行内非公式（货币/区间被 micromark 误判成 inlineMath）：按普通文本显示，
      // 不再进 KaTeX——否则「$5 - $10」会被渲染成一串错位的数学斜体。
      const k = mathKey(false, tex)
      const cached = mathHtmlCache.get(k)
      if (cached !== undefined && cached.startsWith('<span class="math-error')) {
        return cached
      }
      if (!looksLikeMath(tex)) return esc(tex)
      const html = cached ?? esc(tex)
      return `<span class="math math-inline">${html}</span>`
    }
    case 'footnoteReference':
      // 脚注引用：渲染成上标序号并链接到文末定义。锚点统一用 identifier
      // （mdast 保证它在同一篇内唯一；label 只是源码里的原样代号，可能重复）。
      // id="fnref-…" 供定义侧的跳回链接定位。不带方括号（GitHub 同款），
      // 上标本身已足够与正文区分。
      {
        const id = n.identifier ?? n.label ?? ''
        const shown = n.label ?? n.identifier ?? ''
        return `<sup class="footnote-ref" id="fnref-${esc(id)}"><a href="#fn-${esc(id)}">${esc(shown)}</a></sup>`
      }
    case 'break':
      return '<br />'
    case 'mark':
      // ==高亮==（pandoc mark 扩展）。关掉时原样吐回定界符（见 setMarkHighlight）。
      return markHighlight
        ? `<mark class="html-mark">${inline(n.children)}</mark>`
        : `==${inline(n.children)}==`
    case 'html': {
      // 行内 HTML：白名单内「无属性、无嵌套标签」的简单元素原样渲染，
      // 其余转义降级为原文（红线：预览不执行任意 HTML）
      const v = n.value ?? ''
      const simple = v.match(INLINE_HTML_SIMPLE)
      if (simple) {
        const tag = simple[1]!.toLowerCase()
        return wrapInlineHtml(tag, esc(simple[2]!))
      }
      if (/^<br\s*\/?>$/i.test(v)) return '<br />'
      return renderHtmlImg(v) ?? `<code>${esc(v)}</code>`
    }
    default:
      return esc(n.value ?? '')
  }
}

/**
 * details 折叠块白名单：只认裸 `<details>`（可选 open 属性）包裹的内容，
 * summary 与正文里的 markdown 重新走自家渲染器（mdast 的 html 块内不解析
 * markdown，直接透出会是源码）。任何带其他标签/属性的 HTML 返回 null，
 * 调用方降级为等宽源码——红线不动：预览不执行任意 HTML。
 */
function renderDetailsBlock(value: string): string | null {
  const m = value.match(/^\s*<details(\s+open)?\s*>\n?([\s\S]*?)\n?<\/details>\s*$/i)
  if (!m) return null
  const sm = (m[2] ?? '').match(/^\s*<summary>([\s\S]*?)<\/summary>\s*\n?([\s\S]*)$/i)
  const summaryHtml = sm ? renderInlineMarkdown(sm[1] ?? '') : ''
  const body = sm ? (sm[2] ?? '') : (m[2] ?? '')
  const bodyHtml = (parseBlockRoots(body) as Node[]).map((b) => blockToHtml(b)).join('')
  return `<details class="html-details"${m[1] ? ' open' : ''}>${sm ? `<summary>${summaryHtml}</summary>` : ''}${bodyHtml}</details>`
}

/** summary 等短文本按行内 markdown 渲染（粗体/代码等），失败退回转义原文。 */
function renderInlineMarkdown(text: string): string {
  const roots = parseBlockRoots(text) as Node[]
  const p = roots.find((r) => r.type === 'paragraph')
  if (!p) return esc(text.trim())
  return (p.children ?? []).map((c) => inlineNode(c)).join('')
}

function listItems(list: Node): string {
  const items = (list.children ?? []).map((item: Node) => {
    const task = item.checked !== undefined && item.checked !== null
    // 复选框不再是「只读装饰」：预览里点一下直接切换勾选（点击由 main.ts 拦下
    // 并改写源码，原生 toggle 被 preventDefault）。tabindex=-1：它是预览的一部分，
    // 不该进 Tab 序。checked 只反映初始渲染，真实状态永远以源码为准。
    const checkbox = task
      ? `<input type="checkbox" tabindex="-1"${item.checked ? ' checked' : ''} /> `
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
      // 高亮只改显示，不改源码：token 由 highlightCode 转义后包 span。
      // 行号 gutter：多行块才挂（单行标行号没有意义）；显隐由根类
      // code-ln-off 控制（设置面板实时切换，无需重渲染）。
      const lang = n.lang ?? ''
      const value = n.value ?? ''
      const lineCount = value.split('\n').length
      const gutter =
        lineCount > 1
          ? `<span class="ln-gutter" aria-hidden="true">${Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}</span>`
          : ''
      return `<pre${gutter ? ' class="has-ln"' : ''}>${gutter}<code class="language-${esc(lang)}">${highlightCode(value, lang)}</code></pre>`
    }
    case 'thematicBreak':
      return '<hr />'
    case 'math': {
      // 关掉「内联公式」：块级公式同样原样显示 `$$…$$`。
      if (!mathEnabled) return `<div class="math math-block math-raw">$$${esc(n.value ?? '')}$$</div>`
      // 块级 KaTeX：preRenderMath 阶段已把 katex HTML 填到 mathHtmlCache
      const k = mathKey(true, n.value ?? '')
      const html = mathHtmlCache.get(k) ?? esc(n.value ?? '')
      return `<div class="math math-block">${html}</div>`
    }
    case 'table': {
      const rows = n.children ?? []
      const head = rows[0]
      const bodyRows = rows.slice(1)
      const columnIsNumeric = (column: number) => {
        const values = bodyRows
          .map((row: Node) => row.children?.[column])
          .filter((cell): cell is Node => Boolean(cell))
          .map((cell: Node) => inline(cell.children).replace(/<[^>]+>/g, '').trim())
          .filter(Boolean)
        return values.length > 0 && values.every(isNumericCell)
      }
      // GFM 的对齐语法（:--- 左 / :---: 中 / ---: 右）由 mdast 记在 table.align。
      // **显式标注优先**；没写冒号的列才回退到「数字列右对齐」这条排版约定。
      const aligns = n.align ?? []
      const alignFor = (column: number, numeric: boolean): string | null => {
        const a = aligns[column]
        if (a === 'left' || a === 'center' || a === 'right') return a
        return numeric ? 'right' : null
      }
      const attr = (a: string | null) => (a ? ` data-align="${a}"` : '')
      const thead = head
        ? `<thead><tr>${(head.children ?? [])
            .map(
              (c: Node, column: number) =>
                `<th${attr(alignFor(column, columnIsNumeric(column)))}>${inline(c.children)}</th>`,
            )
            .join('')}</tr></thead>`
        : ''
      const tbody = bodyRows
        .map(
          (r: Node) =>
            `<tr>${(r.children ?? [])
              .map((c: Node, column: number) => {
                // 没标对齐时按这一格的内容兜底：数字右对齐（见 alignFor）。
                const html = inline(c.children)
                const plain = html.replace(/<[^>]+>/g, '').trim()
                return `<td${attr(alignFor(column, isNumericCell(plain)))}>${html}</td>`
              })
              .join('')}</tr>`,
        )
        .join('')
      return `<div class="table-wrap"><table>${thead}<tbody>${tbody}</tbody></table></div>`
    }
    case 'yaml':
      return renderFrontmatter(n.value ?? '')
    case 'footnoteDefinition': {
      // 脚注定义：标号 + 内容 + ↩ 跳回，一行流（GitHub 同款）。内容里的段落
      // 直接渲染行内内容不包 <p>——否则块级 <p> 会把 ↩ 挤到下一行，grid
      // 自动布局还会把它排到第二行第一列（0.27.2 截图里的丑态）。
      const fid = esc(n.identifier ?? n.label ?? '')
      const body = (n.children ?? [])
        .map((c) => (c.type === 'paragraph' ? inline(c.children) : blockToHtml(c)))
        .join('')
      return `<div class="footnote-definition" id="fn-${fid}"><span class="footnote-definition-anchor">${esc(n.label ?? n.identifier ?? '')}</span><div class="footnote-definition-body">${body}<a class="footnote-backref" href="#fnref-${fid}" aria-label="${esc(t('footnoteBack'))}">${iconSvg('backref', 12)}</a></div></div>`
    }
    case 'html': {
      // 块级 HTML：lone <img> / details 白名单放行，其余安全降级为等宽源码
      const img = renderHtmlImg(n.value ?? '')
      if (img) return img
      const details = renderDetailsBlock(n.value ?? '')
      return details ?? `<pre class="preform">${esc(n.value ?? '')}</pre>`
    }
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
