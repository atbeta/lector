import type { NewlineStyle, SourceDocument } from './types.ts'

export const BOM = '\uFEFF'

/** 扫描全文：同时出现 CRLF 与裸 LF/CR 则为 mixed。 */
export function detectNewline(text: string): NewlineStyle {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\r') {
      if (text[i + 1] === '\n') {
        crlf += 1
        i += 1
      } else {
        return 'mixed'
      }
    } else if (c === '\n') {
      lf += 1
    }
  }
  if (crlf > 0 && lf > 0) return 'mixed'
  if (crlf > 0) return '\r\n'
  return '\n'
}

/**
 * 从磁盘读到的原始字符串生成 SourceDocument：
 * 检测换行、剥离 BOM。一致 CRLF 正文统一 '\n'；mixed 不改写。
 * path 与 mtimeMs 由调用方传入（壳侧提供）。
 */
export function createSourceDocument(path: string, raw: string, mtimeMs: number): SourceDocument {
  const hasBom = raw.startsWith(BOM)
  const text = hasBom ? raw.slice(BOM.length) : raw
  const newline = detectNewline(text)
  return {
    path,
    text: newline === '\r\n' ? text.replace(/\r\n/g, '\n') : text,
    newline,
    hasBom,
    mtimeMs,
  }
}

/**
 * 把编辑后的正文按原文的行尾还原。
 *
 * 为什么需要它：CodeMirror 里的文档只有 LF 形态，磁盘原文的 CRLF / 混合换行
 * 在装载时就没了。直接写回 CM 的正文，会让没动过的行也换掉行尾——撞产品红线
 * 「未改过的块保存时必须与原文字节级一致」。
 *
 * 行数变了就整篇退回 LF 的代价太大：混合换行的文件插一行，全文的行尾都会被
 * 改写。改成**首尾对齐**——公共前缀的行拿原文同一行的行尾，公共后缀的行映射回
 * 原文对应行；中间段里还在原文范围内的行继承它那一行的行尾，多出来的新行用 LF。
 * 除末行外每一行都必须有行尾（缺了会吃掉行边界）；末行永远不加行尾，
 * 否则文末删行会凭空多出一条尾部换行（"a\n" 按行切是 ["a",""]，
 * 那条换行属于「a」的行尾，不是末行的）。
 */
export function restoreLineEndings(edited: string, original: string): string {
  if (edited === original) return original
  const originalLines = original.split(/\r\n?|\n/)
  const editedLines = edited.split('\n')
  // 原文每一行后面的行尾（最后一行没有行尾）。
  const ends: string[] = []
  const re = /\r\n?|\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(original)) !== null) ends.push(m[0])
  const O = originalLines.length
  const E = editedLines.length
  // 公共前缀行数 p 与公共后缀行数 s：前缀、后缀互不重叠（p + s ≤ min(E, O)）。
  let p = 0
  while (p < O && p < E && editedLines[p] === originalLines[p]) p += 1
  let s = 0
  const sMax = Math.min(E, O) - p
  while (s < sMax && editedLines[E - 1 - s] === originalLines[O - 1 - s]) s += 1
  let out = ''
  for (let i = 0; i < E - 1; i++) {
    out += editedLines[i]
    let ending: string | null = null
    if (i < p) {
      // 前缀：与原文第 i 行逐字相同，行尾照搬。
      ending = ends[i] ?? null
    } else if (i >= E - s) {
      // 后缀：编辑后第 i 行对应原文第 i + (O - E) 行；i < E - 1 保证 j < O - 1，行尾必在。
      ending = ends[i + (O - E)] ?? null
    } else if (i < O - s) {
      // 中间段、但仍在原文中间段范围内：继承原文这一行的行尾。
      ending = ends[i] ?? null
    }
    // 对不上原文边界的都是新边界（多出来的行、原文末行之后的位置）：用 LF。
    out += ending ?? '\n'
  }
  // 末行不给行尾：尾部换行属于前一行的行尾，由上一行承载。
  out += editedLines[E - 1]
  return out
}

/**
 * 把内存正文还原为磁盘字节文本。
 * mixed：调用方传入的已是原文切片拼接，只补 BOM。
 */
export function applyEncoding(doc: SourceDocument, normalized: string): string {
  const body =
    doc.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  return doc.hasBom ? BOM + body : body
}
