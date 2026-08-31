import { describe, expect, test } from 'bun:test'
import { applyEncoding, createSourceDocument } from '../src/encoding.ts'
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
