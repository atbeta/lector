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
 * 行数一致时按行号还原；行数变了就还原不了（多出来的行不知道该配哪个行尾），
 * 这时用 CM 的形态（LF）交出去。
 */
export function restoreLineEndings(edited: string, original: string): string {
  const originalLines = original.split(/\r\n?|\n/)
  const editedLines = edited.split('\n')
  if (originalLines.length !== editedLines.length) return edited
  // 原文每一行后面的行尾（最后一行没有行尾）。
  const ends: string[] = []
  const re = /\r\n?|\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(original)) !== null) ends.push(m[0])
  let out = ''
  for (let i = 0; i < editedLines.length; i++) {
    out += editedLines[i]
    if (i < ends.length) out += ends[i]
  }
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
