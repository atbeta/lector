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

  test('纯 LF 原文：原样返回', () => {
    expect(restoreLineEndings('a\nB\n', 'a\nb\n')).toBe('a\nB\n')
  })

  test('一字未动：返回的字节与原文完全相同', () => {
    for (const raw of ['a\r\nb\nc\r\n', 'a\nb\n', 'a\r\nb\nc', 'a\rb\rc', '', '\n', '\r\n']) {
      expect(restoreLineEndings(raw, raw)).toBe(raw)
    }
  })

  test('混合换行 + 顶部插一行：新行 LF，其余行尾原封不动', () => {
    expect(restoreLineEndings('x\na\nb\nc\n', 'a\r\nb\nc\r\n')).toBe('x\na\r\nb\nc\r\n')
  })

  test('混合换行 + 中间插一行：新行 LF，其余行尾原封不动', () => {
    expect(restoreLineEndings('a\nx\nb\nc\n', 'a\r\nb\nc\r\n')).toBe('a\r\nx\nb\nc\r\n')
  })

  test('混合换行 + 末尾插一行：新行 LF，其余行尾原封不动', () => {
    expect(restoreLineEndings('a\nb\nc\nx\n', 'a\r\nb\nc\r\n')).toBe('a\r\nb\nc\r\nx\n')
  })

  test('末尾追加行但原文末行无换行：新行 LF，且不凭空补尾部换行', () => {
    expect(restoreLineEndings('a\nb\nx', 'a\r\nb')).toBe('a\r\nb\nx')
  })

  test('原文以换行结尾：编辑后末行映射回原文的空末行，不丢尾部换行', () => {
    expect(restoreLineEndings('a\nb\n', 'a\r\nb\r\n')).toBe('a\r\nb\r\n')
    // 末尾换行被删掉：末行不再映射空行，行尾随之消失
    expect(restoreLineEndings('a\nb', 'a\r\nb\r\n')).toBe('a\r\nb')
  })

  test('删一行：剩余行各自保持原来的行尾', () => {
    expect(restoreLineEndings('a\nc\n', 'a\r\nb\nc\r\n')).toBe('a\r\nc\r\n')
    // 删首行
    expect(restoreLineEndings('b\nc\n', 'a\r\nb\nc\n')).toBe('b\nc\n')
  })

  test('行数不变只改一行：那一行继承原来的行尾', () => {
    expect(restoreLineEndings('a\nB\nc\n', 'a\r\nb\nc\r\n')).toBe('a\r\nB\nc\r\n')
    expect(restoreLineEndings('A\nb\nc\n', 'a\nb\nc\r\n')).toBe('A\nb\nc\r\n')
  })

  test('裸 CR 文件：行尾逐个还原', () => {
    expect(restoreLineEndings('a\nB\nc', 'a\rb\rc')).toBe('a\rB\rc')
    expect(restoreLineEndings('x\na\nb\nc', 'a\rb\rc')).toBe('x\na\rb\rc')
  })

  test('行数变了不再整篇退回 LF', () => {
    // 旧行为：行数一变就交出 CM 的 LF 形态，未动过的行也被改写。
    expect(restoreLineEndings('a\nb\nc\n', 'a\r\nb\r\n')).toBe('a\r\nb\r\nc\n')
  })
})
