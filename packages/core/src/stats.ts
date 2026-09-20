// 文档统计（无 DOM）。
//
// 状态行要显示「多少字 / 多少字符 / 多少小节 / 读多久」。这些数字都必须是
// **打开的那个文件**的真实内容算出来的，不能靠编辑器里当前可见的部分——所以
// 输入是整篇原文（脏块未落盘时以 session 序列化结果为准，由调用方负责）。
//
// 口径对齐 Typora / 微软 Word：
// - 「字数」= CJK 字符（含中文标点，中文文档里标点也是版面）+ 西文单词。
//   中文按字计、西文按词计，混排相加才是用户心里那个数。
// - 「字符数」= **渲染后文本**的字符数，分计空格 / 不计空格两种。markdown
//   语法（#、*、URL、frontmatter）不计——用户问的是「这篇内容多少字」，
//   不是「源码多少字节」；旧实现按源码算，一篇链接列表能虚高几十倍。
//
// 实现：不走正则剥语法（规则永远追不全，表格/数学/脚注都会漏），直接复用
// parse.ts 的 mdast 解析——frontmatter、GFM、数学扩展全套都在，遍历树收集
// 「渲染文本」即可，链接 URL、frontmatter、HTML 天然排除。状态行刷新有
// debounce，整篇解析一次在毫秒级。

import { parseBlockRoots } from './parse.ts'

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g

// 西文词：字母数字串，内部可含撇号/连字符——don't、state-of-the-art 各算
// 一个词（与 Word/Typora 一致）；按标点硬切会把它们劈成两半，虚高一倍。
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export interface DocStats {
  /** CJK 字符数 + 西文单词数（用户理解的「字数」）。 */
  words: number
  /** 渲染文本去空白后的字符数（Typora 的「字符数（不计空格）」）。 */
  chars: number
  /** 渲染文本总字符数，含空格换行（Typora 的「字符数（计空格）」）。 */
  charsWithSpaces: number
  /** 非空行数。 */
  lines: number
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

/**
 * 统计一篇 markdown 原文。
 *
 * 西文取词前先摘掉 CJK（已按字计过），否则一串连续汉字会被当成一个词。
 */
export function countText(text: string): DocStats {
  if (!text) return { words: 0, chars: 0, charsWithSpaces: 0, lines: 0 }

  const parts: string[] = []
  for (const root of parseBlockRoots(text)) collectText(root, parts)
  const rendered = parts.join('\n')

  const cjkCount = (rendered.match(CJK) ?? []).length
  const latinWords = rendered.replace(CJK, ' ').match(WORD) ?? []

  const chars = rendered.replace(/\s/g, '').length
  const charsWithSpaces = rendered.length
  const lines = text.split('\n').filter((l) => l.trim() !== '').length

  return { words: cjkCount + latinWords.length, chars, charsWithSpaces, lines }
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
