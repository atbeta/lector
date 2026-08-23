import { describe, expect, test } from 'bun:test'
import { isFocusableBlock, isWhitespaceGap, parseBlocks, adjacentFocusableId } from '../src/index.ts'

describe('空白缝不可作为编辑块', () => {
  test('段间空行是 unknown 空白缝，不可聚焦', () => {
    const blocks = parseBlocks('一段。\n\n两段。\n')
    const gap = blocks.find((b) => b.kind === 'unknown')
    expect(gap).toBeTruthy()
    expect(isWhitespaceGap(gap)).toBe(true)
    expect(isFocusableBlock(gap!)).toBe(false)
  })

  test('连续多个空行仍是一条缝，不是空段落', () => {
    const blocks = parseBlocks('一段。\n\n\n\n两段。\n')
    const gaps = blocks.filter(isWhitespaceGap)
    expect(gaps.length).toBeGreaterThan(0)
    expect(blocks.some((b) => b.kind === 'paragraph' && b.raw.trim() === '')).toBe(false)
  })

  test('空白缝若交给 CM，换行数会变成「行数 = n+1」', () => {
    const blocks = parseBlocks('一段。\n\n两段。')
    const gap = blocks.find(isWhitespaceGap)!
    // "\n\n" 在 CodeMirror 里是 3 行空行——这就是「一点击变三行」的根因
    expect(gap.raw).toBe('\n\n')
    expect(gap.raw.split('\n')).toHaveLength(3)
    expect(isFocusableBlock(gap)).toBe(false)
  })

  test('空段落是内容块，仍可聚焦', () => {
    expect(isWhitespaceGap({ kind: 'paragraph', raw: '' })).toBe(false)
    expect(isFocusableBlock({ kind: 'paragraph', raw: '' })).toBe(true)
  })

  test('含内容的 unknown（如未识别 HTML）仍可聚焦', () => {
    expect(isWhitespaceGap({ kind: 'unknown', raw: '<div></div>' })).toBe(false)
    expect(isFocusableBlock({ kind: 'unknown', raw: '<div></div>' })).toBe(true)
  })
})

describe('跨块方向键：跳过空白缝找相邻可聚焦块', () => {
  test('向下跳过空行缝落到下一段', () => {
    const blocks = parseBlocks('一段。\n\n两段。\n\n三段。\n')
    const paras = blocks.filter((b) => b.kind === 'paragraph')
    expect(paras).toHaveLength(3)
    expect(adjacentFocusableId(blocks, paras[0]!.id, 1)).toBe(paras[1]!.id)
    expect(adjacentFocusableId(blocks, paras[1]!.id, 1)).toBe(paras[2]!.id)
  })

  test('向上跳过空行缝落到上一段', () => {
    const blocks = parseBlocks('一段。\n\n两段。\n\n三段。\n')
    const paras = blocks.filter((b) => b.kind === 'paragraph')
    expect(adjacentFocusableId(blocks, paras[2]!.id, -1)).toBe(paras[1]!.id)
    expect(adjacentFocusableId(blocks, paras[1]!.id, -1)).toBe(paras[0]!.id)
  })

  test('已经在首/末内容块则没有下一跳', () => {
    const blocks = parseBlocks('# 标题\n\n正文。\n')
    const heading = blocks.find((b) => b.kind === 'heading')!
    const para = blocks.find((b) => b.kind === 'paragraph')!
    expect(adjacentFocusableId(blocks, heading.id, -1)).toBeNull()
    expect(adjacentFocusableId(blocks, para.id, 1)).toBeNull()
  })

  test('不把空白缝当成落点', () => {
    const blocks = parseBlocks('甲。\n\n\n乙。\n')
    const a = blocks.find((b) => b.raw.includes('甲'))!
    const next = adjacentFocusableId(blocks, a.id, 1)
    expect(next).toBeTruthy()
    const landed = blocks.find((b) => b.id === next)!
    expect(isWhitespaceGap(landed)).toBe(false)
    expect(landed.raw.includes('乙')).toBe(true)
  })
})
