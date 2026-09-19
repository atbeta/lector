/**
 * GFM 表格行切列。micromark-extension-gfm-table 先按 `|` 切、再解析单元格，
 * 于是 `` `|` `` 里的管道会被当成列界——「不是表格分隔」那一行就裂成四格。
 * 规范允许代码 span 与 `\|` 里出现字面 `|`；切列必须认这两处。
 */

export interface SplitTableRowOptions {
  /**
   * 把单元格外（以及编辑器要的「逻辑源码」里）的 `\|` 还原成 `|`。
   * 预览重解析要留给行内解析器处理转义，传 false。
   */
  unescapePipes?: boolean
}

function tickRun(s: string, i: number): number {
  let n = 0
  while (i + n < s.length && s[i + n] === '`') n++
  return n
}

/** 从 from 起是否有一段恰好 fence 个反引号（更长的一串不算闭合）。 */
function hasCloser(s: string, from: number, fence: number): boolean {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '`') continue
    const n = tickRun(s, i)
    if (n === fence) return true
    i += n - 1
  }
  return false
}

export function splitTableRow(line: string, opts: SplitTableRowOptions = {}): string[] {
  const unescapePipes = opts.unescapePipes !== false
  const t = line.trim()
  const cells: string[] = []
  let cur = ''
  let inCode = false
  let fence = 0
  let lastWasSplit = false

  for (let i = 0; i < t.length; ) {
    if (t[i] === '`') {
      const n = tickRun(t, i)
      if (!inCode) {
        if (hasCloser(t, i + n, n)) {
          inCode = true
          fence = n
        }
      } else if (n === fence) {
        inCode = false
        fence = 0
      }
      cur += t.slice(i, i + n)
      i += n
      lastWasSplit = false
      continue
    }
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += unescapePipes ? '|' : '\\|'
      i += 2
      lastWasSplit = false
      continue
    }
    if (!inCode && t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      i++
      lastWasSplit = true
      continue
    }
    cur += t[i]
    i++
    lastWasSplit = false
  }
  cells.push(cur.trim())
  if (t.startsWith('|') && cells[0] === '') cells.shift()
  if (lastWasSplit && cells[cells.length - 1] === '') cells.pop()
  return cells
}
