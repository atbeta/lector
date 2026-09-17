import { describe, expect, test } from 'bun:test'
import { isFocusableBlock, parseBlocks, serialize } from '../src/index.ts'

const TABLE = ['| 决策 | 理由 |', '|---|---|', '| A | B |'].join('\n')

describe('表格尾部无管道行切出（GFM 吸行问题）', () => {
  test('表格后紧跟图片行：图片独立成块，不再被吸进表格', () => {
    const text = TABLE + '\n![截图](images/shot.png)'
    const blocks = parseBlocks(text)
    expect(blocks.filter(isFocusableBlock).map((b) => b.kind)).toEqual(['table', 'paragraph'])
    const table = blocks.find((b) => b.kind === 'table')!
    expect(table.raw).toBe(TABLE + '\n')
    expect(table.raw).not.toContain('![截图]')
    const para = blocks.find((b) => b.kind === 'paragraph')!
    expect(para.raw).toBe('![截图](images/shot.png)')
    // 拼接还原全文（字节恒等）
    expect(serialize(blocks)).toBe(text)
  })

  test('表格后紧跟普通文字行：同样切出', () => {
    const text = TABLE + '\n紧跟着的一行文字'
    const blocks = parseBlocks(text)
    expect(blocks.filter(isFocusableBlock).map((b) => b.kind)).toEqual(['table', 'paragraph'])
    expect(serialize(blocks)).toBe(text)
  })

  test('连续多行无管道段落一起切出，仍是一块', () => {
    const text = TABLE + '\n第一行\n第二行'
    const blocks = parseBlocks(text)
    const focusable = blocks.filter(isFocusableBlock)
    expect(focusable.map((b) => b.kind)).toEqual(['table', 'paragraph'])
    expect(focusable[1]!.raw).toBe('第一行\n第二行')
    expect(serialize(blocks)).toBe(text)
  })

  test('表格后是含管道的行：不切（仍是表格行）', () => {
    const text = TABLE + '\n| C | D |'
    const blocks = parseBlocks(text)
    expect(blocks.filter(isFocusableBlock).map((b) => b.kind)).toEqual(['table'])
    expect(serialize(blocks)).toBe(text)
  })

  test('表格与段落之间有空行：行为不变（本来就不吸）', () => {
    const text = TABLE + '\n\n普通段落'
    const blocks = parseBlocks(text)
    expect(blocks.filter(isFocusableBlock).map((b) => b.kind)).toEqual(['table', 'paragraph'])
    expect(serialize(blocks)).toBe(text)
  })

  test('切出后表格 mdast 不再含被吸进去的行（预览不会画出小图）', () => {
    const text = TABLE + '\n![截图](images/shot.png)'
    const blocks = parseBlocks(text)
    const table = blocks.find((b) => b.kind === 'table')!
    const rows = (table.mdast as { children: unknown[] }).children
    expect(rows).toHaveLength(2)
  })
})
