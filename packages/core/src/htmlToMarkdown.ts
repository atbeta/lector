/**
 * HTML → Markdown。无 DOM：自带一个容错解析器，所以能在 bun test 里跑。
 *
 * 场景只有一个：从浏览器/Word/邮件里复制一段带格式的内容，粘进 Lector。
 * 浏览器的剪贴板里 `text/plain` 只有光秃秃的文字——加粗、链接、列表、表格全没了。
 * 而 Lector 的文件就是 Markdown，粘贴时把它转回来是「顺手能改」的一部分。
 *
 * 三条原则：
 * 1. **不丢内容**。认不出的标签一律「脱壳留子」（unwrap），不整段丢掉；
 *    真正要丢的只有 script/style 这类本来就不是文档内容的东西。
 * 2. **不造坏 Markdown**。转出来的文本再解析回去应该是同一棵树——
 *    所以正文里的 `*`、`[` 和行首的 `-` 都要转义。
 * 3. **保守**。宁可不转，不要转错；拿不准的标签脱壳，拿不准的属性忽略。
 */

// ───────────── 标签分类 ─────────────

/** 空元素：没有闭合标签，也就没有子节点。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * 整棵子树都不要的标签：它们的内容本来就不是「文档的文字」。
 * 注意 form/button/select 之类不在其中——里面的文字是内容，只该脱壳。
 */
const DROP_TAGS = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'base', 'noscript',
  'template', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio',
  'source', 'track', 'map', 'area', 'param', 'svg', 'math', 'col', 'colgroup',
])

/** 内容按原文读、内部不再当标签看的元素（里面的 `<` 不当标签）。 */
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

/** 块级元素：它们会打断行内缓冲，自成一段。 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd',
  'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'ul',
])

/** 开这些标签时，顺手关掉还开着的同类标签（HTML 的隐式闭合规则）。 */
const IMPLIED_CLOSE: Record<string, string[]> = {
  li: ['li'],
  p: ['p'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['tr', 'td', 'th'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
}

/** 这些标签一开，外面开着的 `<p>` 就该结束了。 */
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'table', 'ul',
])

// ───────────── 实体 ─────────────

/** 常用命名实体。不做全表：2000+ 条对一个粘贴功能太重，认不出的原样保留。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0',
  plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', minus: '\u2212',
  middot: '\u00b7', bull: '\u2022', hellip: '\u2026', prime: '\u2032',
  Prime: '\u2033', permil: '\u2030', dagger: '\u2020', Dagger: '\u2021',
  mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', harr: '\u2194',
  infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265', asymp: '\u2248',
  sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  cent: '\u00a2', pound: '\u00a3', yen: '\u00a5', euro: '\u20ac', curren: '\u00a4',
  sect: '\u00a7', para: '\u00b6', micro: '\u00b5', shy: '\u00ad',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '\u200c', zwj: '\u200d',
}

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

/** 把 `&amp;` `&#65;` `&#x4e2d;` 解回字符；认不出的一律原样保留。 */
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      // 0 和代理区不是合法字符，造出来只会是坏字符，宁可原样显示
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole
      if (cp >= 0xd800 && cp <= 0xdfff) return whole
      return String.fromCodePoint(cp)
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

// ───────────── 解析 ─────────────

export interface HtmlElement {
  kind: 'element'
  name: string
  attrs: Record<string, string>
  children: HtmlNode[]
}

export interface HtmlText {
  kind: 'text'
  value: string
}

export type HtmlNode = HtmlElement | HtmlText

/** 从 `<` 后面一路找到标签结束的 `>`，跳过属性值引号里的 `>`。 */
function findTagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from; i < html.length; i++) {
    const c = html[i]!
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const name = m[1]!.toLowerCase()
    let value = m[2] ?? ''
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
    // 同名属性只取第一个，和浏览器一致
    if (!(name in attrs)) attrs[name] = decodeEntities(value)
  }
  return attrs
}

/**
 * 容错解析：一次线性扫描，直接建树。
 *
 * 坏标签当文本、多余的结束标签忽略、`<li>` 自动闭 `<li>`——
 * 剪贴板里的 HTML 来自各家编辑器，指望它规范是不现实的。
 */
function buildTree(html: string): HtmlElement {
  const root: HtmlElement = { kind: 'element', name: '#root', attrs: {}, children: [] }
  const stack: HtmlElement[] = [root]
  const top = () => stack[stack.length - 1]!
  const pushText = (text: string) => {
    const value = decodeEntities(text)
    if (value) top().children.push({ kind: 'text', value })
  }

  let i = 0
  let raw: string | null = null
  while (i < html.length) {
    if (raw) {
      // script/style 的正文不当标签解析（里面出现 `<` 太正常了），整段跳过
      const close = new RegExp(`</${raw}(?=[\\s/>])`, 'i').exec(html.slice(i))
      if (!close) break
      i += close.index
      raw = null
      continue
    }

    const lt = html.indexOf('<', i)
    if (lt < 0) {
      pushText(html.slice(i))
      break
    }
    if (lt > i) pushText(html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }

    const head = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80))
    if (!head) {
      // `<` 后面不是标签名：把它当普通文本，继续找下一个 `<`
      const next = html.indexOf('<', lt + 1)
      const stop = next < 0 ? html.length : next
      pushText(html.slice(lt, stop))
      i = stop
      continue
    }

    const closing = html[lt + 1] === '/'
    const name = head[1]!.toLowerCase()
    const end = findTagEnd(html, lt + head[0].length)
    if (end < 0) {
      // 标签没闭合：剩下的都当文本，别把它吞掉
      pushText(html.slice(lt))
      break
    }
    const attrSource = html.slice(lt + head[0].length, end)

    if (closing) {
      // 找最近的同名开标签；找不到（凭空多出的 </div>）就忽略
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d]!.name === name) {
          stack.length = d
          break
        }
      }
      i = end + 1
      continue
    }

    const selfClosing = /\/\s*$/.test(attrSource)
    if (VOID_TAGS.has(name)) {
      top().children.push({ kind: 'element', name, attrs: parseAttrs(attrSource), children: [] })
      i = end + 1
      continue
    }

    while (stack.length > 1) {
      const cur = top().name
      if (cur === 'p' && P_CLOSERS.has(name)) {
        stack.pop()
        continue
      }
      if ((IMPLIED_CLOSE[name] ?? []).includes(cur)) {
        stack.pop()
        continue
      }
      break
    }
    const el: HtmlElement = { kind: 'element', name, attrs: parseAttrs(attrSource), children: [] }
    top().children.push(el)
    if (!selfClosing) stack.push(el)
    i = end + 1
    if (!selfClosing && RAWTEXT_TAGS.has(name)) raw = name
  }
  return root
}

// ───────────── 转义 ─────────────

/** 正文字符转义：这些字符在 Markdown 里都有语法含义。 */
function escapeInlineText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`)
}

/**
 * 行首的块级记号要转义，否则正文里的「- 清单」会被解析成真的清单。
 *
 * 只对「内容」调用，不对已经拼好的结构调用——否则我们自己的 `- ` 标记也会被转掉。
 */
function escapeLineStarts(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      if (/^#{1,6}(\s|$)/.test(line)) return `\\${line}`
      if (line.startsWith('>')) return `\\${line}`
      if (/^\s*[-+]\s/.test(line)) return line.replace(/^(\s*)([-+])/, '$1\\$2')
      // `\1.` 不是合法转义（数字不是 ASCII 标点），要转的是那个分隔符
      if (/^\s*\d+[.)]\s/.test(line)) return line.replace(/^(\s*\d+)([.)])/, '$1\\$2')
      if (/^-{3,}$/.test(line) || /^={2,}$/.test(line)) return `\\${line}`
      return line
    })
    .join('\n')
}

/** 交给块级渲染的正文都过这道关。 */
function finishInline(text: string): string {
  return escapeLineStarts(text)
}

/** HTML 空白语义：连续空白（含换行）算一个空格。nbsp 不算空白，要留着。 */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f\v]+/g, ' ')
}

/** 取子树里的纯文本（代码、代码块用；不做 Markdown 转义）。 */
function rawText(node: HtmlNode): string {
  if (node.kind === 'text') return node.value
  if (DROP_TAGS.has(node.name)) return ''
  let out = ''
  for (const child of node.children) out += rawText(child)
  return out
}

// ───────────── 行内 ─────────────

/** 只有这些协议能进 Markdown 链接/图片，其余（javascript: 之流）一律不转。 */
function safeDestination(url: string, kind: 'link' | 'image'): string | null {
  const raw = url.trim()
  if (!raw) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)
  if (!scheme) return raw // 相对路径 / 锚点
  const name = scheme[1]!.toLowerCase()
  if (name === 'http' || name === 'https' || name === 'mailto') return raw
  if (kind === 'image' && name === 'data' && /^data:image\//i.test(raw)) return raw
  return null
}

/** 目标里出现空格或括号时要包尖括号，否则链接会断在半路。 */
function wrapDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, '')}>` : url
}

/**
 * 包一对强调标记。
 *
 * 标记内侧贴着空白是无效的（`** a **` 不是加粗），所以把空白挪到标记外面。
 */
function wrap(marker: string, inner: string): string {
  if (!inner) return ''
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)
  const lead = m?.[1] ?? ''
  const core = m?.[2] ?? ''
  const trail = m?.[3] ?? ''
  if (!core) return inner
  return `${lead}${marker}${core}${marker}${trail}`
}

/** 行内代码：外侧反引号要比内容里最长的一串还长，两侧贴引号时补空格。 */
function codeSpan(raw: string): string {
  const text = raw.replace(/[\r\n]+\s*/g, ' ').trim()
  if (!text) return ''
  const runs = text.match(/`+/g) ?? []
  const width = Math.max(1, ...runs.map((r) => r.length + 1))
  const fence = '`'.repeat(width)
  const pad = /^`|`$|^\s|\s$/.test(text) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function imageMarkdown(el: HtmlElement): string {
  const src = safeDestination(el.attrs.src ?? '', 'image')
  if (!src) return ''
  const alt = (el.attrs.alt ?? '').replace(/[[\]\\]/g, (c) => `\\${c}`)
  const title = el.attrs.title ? ` "${el.attrs.title.replace(/"/g, '\\"')}"` : ''
  return `![${alt}](${wrapDestination(src)}${title})`
}

/** 富文本里的复选框：转成 GFM 任务项记号，正好接上列表的 `- `。 */
function checkboxMarkdown(el: HtmlElement): string {
  if ((el.attrs.type ?? '').toLowerCase() !== 'checkbox') return ''
  return el.attrs.checked != null ? '[x] ' : '[ ] '
}

function linkMarkdown(el: HtmlElement, inner: string): string {
  const href = safeDestination(el.attrs.href ?? '', 'link')
  if (!href) return inner
  // 图片链接、空文字链接：至少把地址留下，别变成一对空方括号
  const text = inner.trim() ? inner : escapeInlineText(href)
  const title = el.attrs.title ? ` "${el.attrs.title.replace(/"/g, '\\"')}"` : ''
  return `[${text}](${wrapDestination(href)}${title})`
}

function inlineMarkdown(nodes: HtmlNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') {
      let text = escapeInlineText(collapseWhitespace(node.value))
      // 复选框标记自带一个空格，紧跟的正文前导空格要去掉，免得出现两个
      if (out.endsWith('[x] ') || out.endsWith('[ ] ')) text = text.replace(/^ /, '')
      out += text
      continue
    }
    const name = node.name
    if (DROP_TAGS.has(name)) continue
    if (name === 'br') {
      out += '\\\n' // 硬换行
      continue
    }
    if (name === 'img') {
      out += imageMarkdown(node)
      continue
    }
    if (name === 'input') {
      out += checkboxMarkdown(node)
      continue
    }
    if (name === 'hr' || name === 'wbr' || VOID_TAGS.has(name)) continue
    if (name === 'code') {
      // 代码内容不能转义，否则 `*` 会变成 `\*`
      out += codeSpan(collapseWhitespace(rawText(node)))
      continue
    }
    const inner = inlineMarkdown(node.children)
    switch (name) {
      case 'strong':
      case 'b':
        out += wrap('**', inner)
        break
      case 'em':
      case 'i':
        out += wrap('*', inner)
        break
      case 'del':
      case 's':
      case 'strike':
        out += wrap('~~', inner)
        break
      case 'a':
        out += linkMarkdown(node, inner)
        break
      default:
        // u / ins / span / font / sup / 未知标签：脱壳，文字全留着
        out += inner
    }
  }
  return out
}

// ───────────── 块级 ─────────────

function pushBlock(out: string[], text: string): void {
  const trimmed = text.replace(/[ \t]+$/gm, '').replace(/^\s+|\s+$/g, '')
  if (trimmed) out.push(trimmed)
}

function childrenNamed(el: HtmlElement, name: string): HtmlElement[] {
  return el.children.filter((c): c is HtmlElement => c.kind === 'element' && c.name === name)
}

/** `<pre>` 的语言：`language-js` / `lang-js` / `brush: js` 都认。 */
function languageOf(el: HtmlElement): string | null {
  const cls = el.attrs.class ?? ''
  const m = /(?:language|lang)-([\w+#.-]+)/i.exec(cls) ?? /brush:\s*([\w+#.-]+)/i.exec(cls)
  if (m) return m[1]!.toLowerCase()
  return el.attrs['data-lang'] ?? el.attrs['data-language'] ?? null
}

function fencedCode(code: string, lang: string | null): string {
  // 内容里本来就有 ``` 时要加长围栏，否则代码块会被自己的内容截断
  const runs = code.match(/^`{3,}/gm) ?? []
  const width = Math.max(3, ...runs.map((r) => r.length + 1))
  const fence = '`'.repeat(width)
  return `${fence}${lang ?? ''}\n${code}\n${fence}`
}

function preMarkdown(el: HtmlElement): string {
  const codeEl = childrenNamed(el, 'code')[0]
  const source = codeEl ?? el
  // <pre> 后紧跟的第一个换行是排版换行，浏览器也不显示
  const code = rawText(source).replace(/\r\n?/g, '\n').replace(/^\n/, '').replace(/\n+$/, '')
  if (!code.trim()) return ''
  return fencedCode(code, languageOf(source) ?? languageOf(el))
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

/** 列表项内容：正文跟在标记后面，续行按标记宽度对齐（Markdown 的嵌套规则）。 */
function listItemMarkdown(li: HtmlElement, marker: string): string {
  const parts: Array<{ text: string; list: boolean }> = []
  let buffer: HtmlNode[] = []
  const flush = () => {
    if (!buffer.length) return
    const text = finishInline(inlineMarkdown(buffer))
    buffer = []
    const trimmed = text.replace(/[ \t]+$/gm, '').trim()
    if (trimmed) parts.push({ text: trimmed, list: false })
  }
  for (const node of li.children) {
    if (node.kind === 'text') {
      buffer.push(node)
      continue
    }
    if (DROP_TAGS.has(node.name)) continue
    if (node.name === 'ul' || node.name === 'ol') {
      flush()
      const list = listMarkdown(node, node.name === 'ol')
      if (list) parts.push({ text: list, list: true })
      continue
    }
    if (BLOCK_TAGS.has(node.name)) {
      flush()
      const inner: string[] = []
      blockElement(node, inner)
      for (const text of inner) parts.push({ text, list: false })
      continue
    }
    buffer.push(node)
  }
  flush()
  if (!parts.length) return marker.trimEnd()

  // 紧跟在正文后面的子列表是「紧凑」的——HTML 里它也是贴着上一行显示的，
  // 转成空行会让一条紧凑清单在 Markdown 里变成松散清单（渲染出来的行距都变了）。
  let body = ''
  parts.forEach((part, i) => {
    if (i === 0) {
      body = part.text
      return
    }
    const tight = part.list && !parts[i - 1]!.list
    body += (tight ? '\n' : '\n\n') + part.text
  })

  const pad = ' '.repeat(marker.length)
  const lines = body.split('\n')
  const first = lines[0]!
  const rest = lines.slice(1).map((line) => (line.trim() ? pad + line : ''))
  // 项里第一件事就是子列表时，把子列表挪到下一行缩进，比 `- - 子项` 好读
  if (/^(?:[-+*]|\d+[.)])\s/.test(first)) {
    return [marker.trimEnd(), pad + first, ...rest].join('\n')
  }
  return [marker + first, ...rest].join('\n')
}

function findListItems(list: HtmlElement): HtmlElement[] {
  const direct = childrenNamed(list, 'li')
  if (direct.length) return direct
  // <ul><div><li> 这种不合规但真实存在的结构：往下找一层
  for (const child of list.children) {
    if (child.kind !== 'element') continue
    const nested = childrenNamed(child, 'li')
    if (nested.length) return nested
  }
  return []
}

function listMarkdown(list: HtmlElement, ordered: boolean): string {
  const items = findListItems(list)
  if (!items.length) return ''
  const rawStart = Number.parseInt(list.attrs.start ?? '', 10)
  const start = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 1
  return items.map((li, i) => listItemMarkdown(li, ordered ? `${start + i}. ` : '- ')).join('\n')
}

interface TableRow {
  header: boolean
  cells: string[]
}

function collectRows(el: HtmlElement, rows: TableRow[]): void {
  if (el.name === 'tr') {
    const cells = el.children.filter(
      (c): c is HtmlElement => c.kind === 'element' && (c.name === 'td' || c.name === 'th'),
    )
    rows.push({
      header: cells.some((c) => c.name === 'th'),
      cells: cells.map((c) =>
        finishInline(inlineMarkdown(c.children)).replace(/\n/g, ' ').replace(/\|/g, '\\|'),
      ),
    })
    return
  }
  for (const child of el.children) {
    if (child.kind === 'element' && !DROP_TAGS.has(child.name)) collectRows(child, rows)
  }
}

function tableMarkdown(el: HtmlElement): string {
  const rows: TableRow[] = []
  collectRows(el, rows)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.cells.length))
  if (width === 0) return ''
  const padCells = (cells: string[]) => {
    const filled = cells.slice(0, width)
    while (filled.length < width) filled.push('')
    return `| ${filled.join(' | ')} |`
  }
  // GFM 表必须有表头行；原表没有就补一行空的，别把第一条数据当表头吃掉
  const headIndex = rows.findIndex((r) => r.header)
  const head = headIndex >= 0 ? rows[headIndex]!.cells : new Array<string>(width).fill('')
  const body = rows.filter((_, i) => i !== headIndex)
  const lines = [padCells(head), `| ${new Array<string>(width).fill('---').join(' | ')} |`]
  for (const row of body) lines.push(padCells(row.cells))
  const caption = childrenNamed(el, 'caption')[0]
  const captionText = caption
    ? finishInline(inlineMarkdown(caption.children)).replace(/\n/g, ' ')
    : ''
  return captionText ? `${captionText}\n\n${lines.join('\n')}` : lines.join('\n')
}

function blockElement(el: HtmlElement, out: string[]): void {
  const name = el.name
  switch (name) {
    case 'p':
      pushBlock(out, finishInline(inlineMarkdown(el.children)))
      return
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      // 标题只能是一行：里面的换行按空格处理
      const text = finishInline(inlineMarkdown(el.children)).replace(/\n/g, ' ').trim()
      if (text) pushBlock(out, `${'#'.repeat(Number(name[1]))} ${text}`)
      return
    }
    case 'hr':
      out.push('---')
      return
    case 'pre': {
      const code = preMarkdown(el)
      if (code) out.push(code)
      return
    }
    case 'blockquote': {
      const inner: string[] = []
      blockMarkdown(el.children, inner)
      if (inner.length) out.push(quoteBlock(inner.join('\n\n')))
      return
    }
    case 'ul':
    case 'ol': {
      const list = listMarkdown(el, name === 'ol')
      if (list) out.push(list)
      return
    }
    case 'table': {
      const table = tableMarkdown(el)
      if (table) out.push(table)
      return
    }
    case 'dt': {
      // Markdown 没有定义列表，术语加粗是最接近的读法
      pushBlock(out, wrap('**', finishInline(inlineMarkdown(el.children)).trim()))
      return
    }
    case 'dd':
      blockMarkdown(el.children, out)
      return
    case 'br':
      return
    case 'img':
    case 'input': {
      const solo = finishInline(inlineMarkdown([el]))
      if (solo.trim()) pushBlock(out, solo)
      return
    }
    default:
      // div/section/body/html/figure/未知块级：脱壳，子节点自己成块
      blockMarkdown(el.children, out)
  }
}

function blockMarkdown(nodes: HtmlNode[], out: string[]): void {
  let buffer: HtmlNode[] = []
  const flush = () => {
    if (!buffer.length) return
    const text = finishInline(inlineMarkdown(buffer))
    buffer = []
    pushBlock(out, text)
  }
  for (const node of nodes) {
    if (node.kind === 'text') {
      buffer.push(node)
      continue
    }
    if (DROP_TAGS.has(node.name)) continue
    if (BLOCK_TAGS.has(node.name)) {
      flush()
      blockElement(node, out)
      continue
    }
    buffer.push(node)
  }
  flush()
}

/**
 * HTML → Markdown。
 *
 * 转不出东西时返回空串，调用方据此放行走原生粘贴（拿 text/plain），
 * 别把用户的内容变成一片空白。
 */
export function htmlToMarkdown(html: string): string {
  if (!html || html.indexOf('<') < 0) return ''
  const out: string[] = []
  blockMarkdown(buildTree(html).children, out)
  return out.join('\n\n')
}
