import { describe, expect, test } from 'bun:test'
import { applyEncoding, createSourceDocument, restoreLineEndings } from '../src/encoding.ts'
import { parseBlocks, serialize } from '../src/index.ts'

describe('换行检测与写回', () => {
  test('纯 LF 保持 LF', () => {
    const raw = 'a\n\nb\n'
    const doc = createSourceDocument('x.md', raw, 0)
    expect(doc.newline).toBe('\n')
    expect(doc.text).toBe(raw)
    expect(applyEncoding(doc, serialize(parseBlocks(doc.text)))).toBe(raw)
  })

  test('纯 CRLF 内存归一、写回还原', () => {
    const raw = 'a\r\n\r\nb\r\n'
    const doc = createSourceDocument('x.md', raw, 0)
    expect(doc.newline).toBe('\r\n')
    expect(doc.text).toBe('a\n\nb\n')
    expect(applyEncoding(doc, serialize(parseBlocks(doc.text)))).toBe(raw)
  })

  test('混合换行未编辑保存字节恒等', () => {
    const raw = 'a\r\n\r\nb\n\nc\r\n'
    const doc = createSourceDocument('x.md', raw, 0)
    expect(doc.newline).toBe('mixed')
    const out = applyEncoding(doc, serialize(parseBlocks(doc.text)))
    expect(out).toBe(raw)
  })
})

describe('源码档的行尾还原', () => {
  // edited 一律是 CM 的形态（只有 LF）：它装载磁盘原文时就把 CRLF 规整掉了。
  test('CRLF 原文：改一行，未动的行仍是 CRLF', () => {
    expect(restoreLineEndings('a\nB\nc\n', 'a\r\nb\r\nc\r\n')).toBe('a\r\nB\r\nc\r\n')
  })

  test('混合换行：按行号还原各自的行尾', () => {
    expect(restoreLineEndings('a\nB\nc\n', 'a\r\nb\nc\r\n')).toBe('a\r\nB\nc\r\n')
  })

  test('行数变了就对不齐：交出 CM 的 LF 形态', () => {
    const edited = 'a\nb\nc\n'
    expect(restoreLineEndings(edited, 'a\r\nb\r\n')).toBe(edited)
  })

  test('纯 LF 原文：原样返回', () => {
    expect(restoreLineEndings('a\nB\n', 'a\nb\n')).toBe('a\nB\n')
  })
})
