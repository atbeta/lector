// 文档统计（无 DOM）。
//
// 状态行要显示「多少字 / 多少小节 / 读多久」。这三个数字都必须是**打开的那个文件**
// 的真实内容算出来的，不能靠编辑器里当前可见的部分——所以输入是整篇原文，
// 而不是 BlockView 数组（脏块未落盘时以 session 序列化结果为准，由调用方负责）。
//
// 中文与西文的「字」不是一回事：CJK 按字计，西文按词计，混排时两者相加才是
// 用户心里那个数。微软 Word 的中文字数统计也是这个算法。

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g

export interface DocStats {
  /** CJK 字符数 + 西文单词数（用户理解的「字数」）。 */
  words: number
  /** 不含空白的字符总数，用于「复制了多少字符」这类精确场景。 */
  chars: number
  /** 非空行数。 */
  lines: number
}

/**
 * 统计一段文本。
 *
 * 实现要点：
 * - 先剥掉代码块与行内代码里的符号噪声？不剥。用户要看的是「这篇有多长」，
 *   代码也是内容。但 markdown 标记（`#`、`*`、`[]()` ）不该计入词数，
 *   否则一篇纯链接列表会虚高。
 * - CJK 标点算字数（中文文档里标点也是版面），西文标点不算词。
 */
export function countText(text: string): DocStats {
  if (!text) return { words: 0, chars: 0, lines: 0 }

  // 去掉 markdown 语法噪声：标题井号、强调星号/下划线、链接与图片的目标部分、
  // 引用箭头、列表符号、围栏。只影响词数统计，不改动原文。
  const stripped = text
    .replace(/^ {0,3}(```|~~~).*$/gm, '') // 围栏行
    .replace(/^ {0,3}#{1,6}\s+/gm, '') // ATX 标题
    .replace(/^\s{0,3}>\s?/gm, '') // 引用
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '') // 列表符号
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片只留文字
    .replace(/[*_`~]/g, '') // 强调与代码定界符
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '') // 分隔线

  const cjkCount = (stripped.match(CJK) ?? []).length
  // 西文词：连续的字母/数字，且不含 CJK（CJK 已经单独数过）
  const latinWords = stripped
    .replace(CJK, ' ')
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length

  const chars = text.replace(/\s/g, '').length
  const lines = text.split('\n').filter((l) => l.trim() !== '').length

  return { words: cjkCount + latinWords, chars, lines }
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
