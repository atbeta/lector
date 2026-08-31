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
 * 把内存正文还原为磁盘字节文本。
 * mixed：调用方传入的已是原文切片拼接，只补 BOM。
 */
export function applyEncoding(doc: SourceDocument, normalized: string): string {
  const body =
    doc.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  return doc.hasBom ? BOM + body : body
}
