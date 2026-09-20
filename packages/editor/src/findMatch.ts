/**
 * 查找的**唯一**匹配实现：计数、高亮、替换三处都走它。
 *
 * 为什么要抽出来：之前三处各写各的（findBar 的 countMatches 用 indexOf、
 * 高亮模块自己扫 text node、替换再走一次字符串替换），于是"大小写/全词/正则"
 * 这种选项一加，三处的边界行为必然慢慢走偏——最后表现为"计数说 3 处、
 * 高亮只标了 2 处、替换换了 4 处"这种谁也说不清的问题。
 *
 * 两个安全上的取舍，写在这里以备将来有人问"为什么不做完整的正则支持"：
 *
 * 1. **灾难性回溯**：(a+)+$ 这类形状能在几十个字符的输入上把主线程卡死几十秒。
 *    JS 正则同步执行、没有超时机制，唯一的兜底是在编译期拦掉已知的危险形状
 *    （嵌套量词），并在匹配时设上限。这不是完备的防护，但对"用户自己输入的正则"
 *    这个场景足够——拦掉的是误伤概率极低的写法，真正需要它的用户能看出提示。
 * 2. **全词匹配对中文无意义**：\b 是「单词边界」，而中文没有空格分词，
 *    "全词"对中文文本等于"整段相等"。所以西文之外不装作支持，提示里写清楚。
 */

export interface FindOptions {
  /** 区分大小写 */
  caseSensitive: boolean
  /** 全词匹配（仅西文有意义，见文件头） */
  wholeWord: boolean
  /** 按正则解释查询串 */
  regex: boolean
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
}

export type FindError = 'empty' | 'invalid-regex' | 'risky-regex'

export interface FindMatch {
  start: number
  end: number
}

/** 命中上限：查找面板不需要报"一万处"，但用户可能在一个大文档里搜常见字。 */
export const MAX_MATCHES = 5000
/** 模式串长度上限：正常查询不会这么长，超了基本是误粘。 */
const MAX_PATTERN = 200

/**
 * 嵌套量词：`(a+)+`、`(\w*)*`、`(\d{1,3})+`——灾难性回溯最经典的形状。
 * 量词包括 `+ * ?` 与 `{n}` / `{n,}` / `{n,m}`；漏掉花括号那一支是实测出来的
 * （`(\d{1,3})+` 当时被判成安全）。
 * 这是**启发式**，会有误伤（如 `(ab{2})+` 其实安全）——宁可提示一句
 * 「正则过于复杂」让用户改写，也不要赌主线程不卡死。
 */
const NESTED_QUANTIFIER = /\([^()]*(?:[+*?]|\{\d+,?\d*\})[^()]*\)\s*(?:[+*?]|\{\d+,?\d*\})/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type CompiledFind =
  /** `re` 供替换用：JS 的 String.replace 会原生展开 $1/$&，自己拼反而容易漏 */
  | { ok: true; find: (text: string) => FindMatch[]; re: RegExp }
  | { ok: false; error: FindError }

/**
 * 编译查询。返回的 `find` 在一段文本里给出所有命中（按位置升序、不重叠）。
 * 无效查询不回退成"当字符串搜"——那会让用户以为正则生效了。
 */
export function compileFind(query: string, opts: FindOptions): CompiledFind {
  if (query.length === 0) return { ok: false, error: 'empty' }
  if (query.length > MAX_PATTERN) return { ok: false, error: 'risky-regex' }

  let source: string
  if (opts.regex) {
    if (NESTED_QUANTIFIER.test(query)) return { ok: false, error: 'risky-regex' }
    source = query
  } else {
    source = escapeRegExp(query)
    // 全词只对西文成立，且正则模式下不再叠加（用户自己在模式里写边界更可控）
    if (opts.wholeWord) source = `\\b${source}\\b`
  }

  let re: RegExp
  try {
    re = new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return { ok: false, error: 'invalid-regex' }
  }

  return {
    ok: true,
    re,
    find: (text: string): FindMatch[] => {
      const out: FindMatch[] = []
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        // 零宽命中（如 a* 在无 a 处）：不推进就会死循环
        if (m[0].length === 0) {
          re.lastIndex += 1
          continue
        }
        out.push({ start: m.index, end: m.index + m[0].length })
        if (out.length >= MAX_MATCHES) break
      }
      return out
    },
  }
}

/** 命中数（不想自己 compile 的调用方用这个）。 */
export function countFind(text: string, query: string, opts: FindOptions): number {
  const c = compileFind(query, opts)
  return c.ok ? c.find(text).length : 0
}

/** 按行寻址的源（CM `Text` 就是这个形状）。 */
export interface LineSource {
  lines: number
  line(n: number): { from: number; text: string }
}

/**
 * 在整篇源码里找命中，位置是文档偏移（给 CM 装饰 / 滚动用）。
 *
 * 默认字符串查找按行扫：大文件下避开 `doc.toString()` 整篇复制。
 * 正则或查询本身含换行才拼一次全文——这两种本来就可能跨行。
 */
export function findInLineSource(source: LineSource, query: string, opts: FindOptions): FindMatch[] {
  const c = compileFind(query, opts)
  if (!c.ok) return []
  if (opts.regex || query.includes('\n')) {
    let text = ''
    for (let i = 1; i <= source.lines; i++) {
      if (i > 1) text += '\n'
      text += source.line(i).text
    }
    return c.find(text)
  }
  const out: FindMatch[] = []
  for (let i = 1; i <= source.lines; i++) {
    const line = source.line(i)
    for (const h of c.find(line.text)) {
      out.push({ start: line.from + h.start, end: line.from + h.end })
      if (out.length >= MAX_MATCHES) return out
    }
  }
  return out
}

/**
 * 替换。`all=false` 时只替换第一处。
 * 替换串里的 `$1` 在正则模式下按捕获组展开（字符串模式下是字面量）。
 */
export function replaceFind(
  text: string,
  query: string,
  to: string,
  opts: FindOptions,
  all: boolean,
): string {
  const c = compileFind(query, opts)
  if (!c.ok || !c.find(text).length) return text
  // 正则模式：替换串里的 $1 / $& 交给 JS 原生展开（这是用户的预期）。
  // 字符串模式：$ 是普通字符，必须转义，否则「替换成 $5」会被当成捕获组而丢失。
  const repl = opts.regex ? to : to.replace(/\$/g, '$$$$')
  if (all) return text.replace(c.re, repl)
  // 只替换第一处：把全局标志摘掉，String.replace 对非全局正则天然只换一处
  return text.replace(new RegExp(c.re.source, c.re.flags.replace('g', '')), repl)
}
