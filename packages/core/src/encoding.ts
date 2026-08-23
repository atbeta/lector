import type { SourceDocument } from './types.ts'

export const BOM = '\uFEFF'

/**
 * 从磁盘读到的原始字符串生成 SourceDocument：
 * 检测换行、剥离 BOM，正文统一 '\n'。
 * path 与 mtimeMs 由调用方传入（壳侧提供）。
 */
export function createSourceDocument(path: string, raw: string, mtimeMs: number): SourceDocument {
  const hasBom = raw.startsWith(BOM)
  const text = hasBom ? raw.slice(BOM.length) : raw
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return {
    path,
    text: newline === '\r\n' ? text.replace(/\r\n/g, '\n') : text,
    newline,
    hasBom,
    mtimeMs,
  }
}

/**
 * 把归一后的 '\n' 正文还原为磁盘字节文本：\n → newline，BOM 前缀。
 */
export function applyEncoding(doc: SourceDocument, normalized: string): string {
  const body =
    doc.newline === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  return doc.hasBom ? BOM + body : body
}
