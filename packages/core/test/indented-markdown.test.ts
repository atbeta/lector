// 行首四空格在 CommonMark 里是缩进代码。文稿把附录贴成这种缩进时，
// 标题和表格必须仍按块渲染，同时 raw 拼接保持原文。
import { describe, expect, test } from 'bun:test'
import { parseBlockRoots, parseBlocks } from '../src/index.ts'
import { createChunkedParser, finalizeChunkedBlocks, parseBlocksWhole, type ChunkStepResult } from '../src/chunk.ts'
import type { BlockView } from '../src/types.ts'

const APPENDIX = [
  '## 7.2 未决问题',
  '',
  '| # | 问题 | 状态 |',
  '|---|---|---|',
  '| 8 | 设计侧约束 | 待定 |',
  '',
  '    ---',
  '',
  '    ## 附录 A：术语表（修订）',
  '',
  '    | 术语 | 定义 |',
  '    |---|---|',
  '    | UCD | 团队 |',
  '',
].join('\n')

function content(blocks: BlockView[]): BlockView[] {
  return blocks.filter((b) => !(b.kind === 'unknown' && b.raw.trim() === ''))
}

function expectCover(blocks: BlockView[], text: string): void {
  expect(blocks.map((b) => b.raw).join('')).toBe(text)
  if (blocks.length === 0) return
  expect(blocks[0]!.start).toBe(0)
  expect(blocks[blocks.length - 1]!.end).toBe(text.length)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    expect(block.raw).toBe(text.slice(block.start, block.end))
    if (i > 0) expect(block.start).toBe(blocks[i - 1]!.end)
  }
}

function signature(blocks: BlockView[]): string {
  return blocks.map((b) => `${b.start}:${b.end}:${b.kind}`).join('|')
}

function applyStep(blocks: BlockView[], step: ChunkStepResult): void {
  if (step.retract > 0) blocks.splice(blocks.length - step.retract, step.retract)
  blocks.push(...step.append)
  for (const rep of step.replacements) {
    let i = 0
    while (i < blocks.length && blocks[i]!.start < rep.start) i++
    let j = i
    while (j < blocks.length && blocks[j]!.end <= rep.end) j++
    blocks.splice(i, j - i, ...rep.blocks)
  }
}

describe('缩进的 Markdown 段落', () => {
  test('四空格附录拆成标题、表格和分隔线', () => {
    const blocks = parseBlocks(APPENDIX)
    expectCover(blocks, APPENDIX)
    const visible = content(blocks)
    expect(visible.map((b) => b.kind)).toEqual(['heading', 'table', 'thematicBreak', 'heading', 'table'])
    const heading = visible.find((b) => b.kind === 'heading' && b.raw.includes('附录'))
    expect(heading?.raw.startsWith('## ')).toBe(true)
    expect((heading?.mdast as { depth?: number } | null)?.depth).toBe(2)
    expect(visible.find((b) => b.kind === 'thematicBreak')?.raw).toBe('---')
    expect(JSON.stringify(visible.find((b) => b.kind === 'table' && b.raw.includes('UCD'))?.mdast)).toContain('UCD')
    expect(visible.some((b) => b.kind === 'code')).toBe(false)
  })

  test('Tab 缩进同样拆开', () => {
    const text = '\t## 附录\n\n\t| a | b |\n\t|---|---|\n\t| 1 | 2 |\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    expect(content(blocks).map((b) => b.kind)).toEqual(['heading', 'table'])
  })

  test('八空格的标题也会剥到标题', () => {
    const text = '        ## 附录\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    expect(content(blocks).map((b) => b.kind)).toEqual(['heading'])
    expect(content(blocks)[0]!.raw).toBe('## 附录')
  })

  test('普通缩进代码仍是代码块', () => {
    const text = '前文\n\n    const x = 1\n    return x\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    const code = content(blocks).find((b) => b.kind === 'code')
    expect(code?.raw).toContain('const x = 1')
    expect(content(blocks).some((b) => b.kind === 'heading')).toBe(false)
  })

  test('井号注释不会被当成标题', () => {
    const text = '前文\n\n    # just a comment\n    x = 1\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    expect(content(blocks).map((b) => b.kind)).toEqual(['paragraph', 'code'])
  })

  test('单独一行的分隔符仍是缩进代码', () => {
    const text = '前文\n\n    ---\n\n后文\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    expect(content(blocks).map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
  })

  test('围栏代码里的标题和表格保持代码', () => {
    const text = '```\n## hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n'
    const blocks = parseBlocks(text)
    expectCover(blocks, text)
    expect(content(blocks).map((b) => b.kind)).toEqual(['code'])
  })

  test('切得很碎时仍与整篇解析一致', () => {
    const whole = parseBlocksWhole(APPENDIX)
    const chunked = parseBlocks(APPENDIX, { target: 48 })
    expect(signature(chunked)).toBe(signature(whole))
    expectCover(chunked, APPENDIX)
    const parser = createChunkedParser(APPENDIX, { target: 48 })
    const stepped: BlockView[] = []
    let guard = 0
    while (!parser.done) {
      applyStep(stepped, parser.step(0))
      if (++guard > 10000) throw new Error('增量解析没有结束')
    }
    expect(signature(finalizeChunkedBlocks(stepped, APPENDIX))).toBe(signature(whole))
  })

  test('表格续行上的四空格在单块重解析时仍是表格', () => {
    const raw = '| 术语 | 定义 |\n    |---|---|\n    | UCD | 团队 |'
    const roots = parseBlockRoots(raw) as Array<{ type?: string }>
    expect(roots[0]?.type).toBe('table')
    expect(JSON.stringify(roots)).toContain('UCD')
  })

  test('嵌套列表的续行缩进不会被拆平', () => {
    const roots = parseBlockRoots('- 甲\n    - 乙\n') as Array<{ type?: string; children?: Array<{ children?: Array<{ type?: string }> }> }>
    expect(roots[0]?.type).toBe('list')
    const nested = roots[0]?.children?.[0]?.children?.some((node) => node.type === 'list')
    expect(nested).toBe(true)
  })
})
