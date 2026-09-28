// 文档统计（无 DOM）。
//
// 状态行要显示「多少词 / 多少字符 / 多少行 / 多少小节 / 读多久」。这些数字都必须是
// **打开的那个文件**的真实内容算出来的，不能靠编辑器里当前可见的部分。
//
// 口径取业界通行做法（不是照搬某一家）：
// - 「词」对齐 Microsoft Word（专业场景的事实标准）：CJK 逐字计、西文按空白分词，
//   混排相加；中文标点计入——Word 的 Asian characters 也把全角标点算进去。
//   不含 markdown 语法（#、*、-、URL、frontmatter）——数的是内容，不是源码。
//   （Typora 不计中文标点，反而与 Word 不一致，不照搬。）
// - 「字符」= 源码的 Unicode 码点数：markdown 语法、空白、换行都计入。这是「文本
//   长度」的通行口径（Google API 规范同样以码点为长度单位）；emoji / 增补平面汉字
//   算一个。**不用** UTF-16 码元——那是实现细节，会把 emoji 算成两个（Typora 即如此）。
// - 「行」= 源码逻辑行数（换行数 + 1，含空行与末尾空行）：编辑器状态栏与 Typora
//   都是这个口径；空文档为 0。
//
// 实现：「词」不走正则剥语法（规则永远追不全，表格/数学/脚注都会漏），直接复用
// parse.ts 的 mdast 解析——frontmatter、GFM、数学扩展全套都在，遍历树收集
// 「渲染文本」即可，链接 URL、frontmatter、HTML 天然排除。「字符」与「行」用源码，
// 不需要解析。
//
// 性能：整篇 parseBlockRoots 对 1MB 文档要 3 秒级，状态行不能每次刷新都来
// 一遍——所以编辑器侧走 countBlocks 按块增量（见下）；countText 保留给
// 测试与小块场景。

import { parseBlockRoots } from './parse.ts'

// 范围含 CJK 标点（\u3001-\u303f）与全/半角形（\uff00-\uffef），但不含
// U+3000 表意空格——那是空白，不是字，旧实现把它算成一个词（会虚高）。
const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3001-\u303f\uff00-\uffef]/g

// 西文词：字母数字串，内部可含撇号/连字符——don't、state-of-the-art 各算
// 一个词（与 Word/Typora 一致）；按标点硬切会把它们劈成两半，虚高一倍。
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export interface DocStats {
  /** CJK 逐字 + 西文单词（对齐 Word：一个汉字算一个词，中文标点计入）。 */
  words: number
  /** 源码字符数（Unicode 码点），含 Markdown 语法、空白与换行。 */
  chars: number
  /** 源码逻辑行数（换行数 + 1，含空行与末尾空行）。 */
  lines: number
}

/** countBlocks 的输入：BlockView 的结构子集（core 不反向依赖编辑器类型）。 */
export interface StatsBlock {
  raw: string
  mdast: unknown
  dirty: boolean
}

interface MdNode {
  type?: string
  value?: unknown
  alt?: unknown
  children?: unknown
}

/**
 * 收集「渲染文本」：text/code/inlineCode/math 的值是内容；图片取 alt
 * （渲染时可见），URL 不算；yaml（frontmatter）是元数据、html 是标签，
 * 都不是用户写的内容，跳过。其余节点（标题/段落/引用/表格/脚注…）递归。
 */
function collectText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as MdNode
  if (n.type === 'yaml' || n.type === 'html') return
  if (typeof n.value === 'string') {
    out.push(n.value)
    return
  }
  if (typeof n.alt === 'string') {
    out.push(n.alt)
    return
  }
  if (Array.isArray(n.children)) for (const c of n.children) collectText(c, out)
}

/** 一组 mdast 节点的渲染文本。 */
function renderedFromNodes(nodes: unknown[]): string {
  const parts: string[] = []
  for (const n of nodes) collectText(n, parts)
  return parts.join('\n')
}

/** 按 Unicode 码点计数：emoji / 增补平面汉字算一个字符，不是 UTF-16 的两个。 */
function countCodePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

function statsFrom(rendered: string, chars: number, lines: number): DocStats {
  // 西文取词前先摘掉 CJK（已按字计过），否则一串连续汉字会被当成一个词。
  const cjkCount = (rendered.match(CJK) ?? []).length
  const latinWords = rendered.replace(CJK, ' ').match(WORD) ?? []
  return {
    words: cjkCount + latinWords.length,
    chars,
    lines,
  }
}

/** 源码里的换行符个数（\n；CRLF 里的 \n 照样算一行）。 */
function countNewlines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 逻辑行数 = 换行数 + 1（含空行与末尾空行）；这是编辑器/Typora 的通行口径。 */
function logicalLines(text: string): number {
  return countNewlines(text) + 1
}

/** 统计一篇 markdown 原文（整篇解析；大文档请用 countBlocks）。 */
export function countText(text: string): DocStats {
  if (!text) return { words: 0, chars: 0, lines: 0 }
  return statsFrom(renderedFromNodes(parseBlockRoots(text)), countCodePoints(text), logicalLines(text))
}

/**
 * 按块增量统计——状态行的常规路径。
 *
 * 编辑器按块持有 mdast（BlockView），非 dirty 块的树与 raw 一致，直接遍历
 * （零解析）；dirty 块的 mdast 是旧的（打字中 syncBlockText 只更新 raw，
 * 失焦 finalizeFocused 才重解析），必须从 raw 现算——一块很小，亚毫秒。
 * memo 按 raw 记渲染文本：没改过的块跨刷新直接命中，块对象重建也不重算。
 * 1MB 文档实测：整篇重解析 3.1s → 按块冷启 ~100ms、命中 memo 后 ~30ms。
 */
export function countBlocks(
  blocks: StatsBlock[],
  memo: Map<string, string> = new Map(),
): DocStats {
  if (blocks.length === 0) return { words: 0, chars: 0, lines: 0 }
  const parts: string[] = []
  let newlines = 0
  let chars = 0
  for (const b of blocks) {
    // 块切片无缝覆盖全文（blocks.raw.join('') === text），逐块相加即全文源码的
    // 码点数与换行数；行数只在最后 +1，不能每块 +1。
    newlines += countNewlines(b.raw)
    chars += countCodePoints(b.raw)
    let rendered = memo.get(b.raw)
    if (rendered === undefined) {
      // finalizeFocused 在块含多个顶层节点时把 mdast 存成数组，两种形态都接
      const trees = Array.isArray(b.mdast) ? b.mdast : [b.mdast]
      rendered = !b.dirty && b.mdast ? renderedFromNodes(trees) : renderedFromNodes(parseBlockRoots(b.raw))
      if (memo.size >= 4096) memo.clear()
      memo.set(b.raw, rendered)
    }
      parts.push(rendered)
  }
  // 空渲染块（html/unknown 等）不参与 join：整篇 countText 里这些块不产生
  // 文本片段，这里多一个 '' 会在块间多算一个换行，影响词数。字符/行数另算，
  // 走源码，不受影响。
  return statsFrom(parts.filter((p) => p !== '').join('\n'), chars, newlines + 1)
}

/**
 * 预计阅读时长（分钟，向上取整，至少 1 分钟；空文档为 0）。
 * 中文 300 字/分、西文 200 词/分是常见取值；混排时按上面算出的总量估一个中位数。
 */
export function readingMinutes(stats: DocStats): number {
  if (stats.words === 0) return 0
  return Math.max(1, Math.ceil(stats.words / 260))
}

/** 数字千分位，状态行用。 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
