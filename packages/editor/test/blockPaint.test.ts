import { expect, test } from 'bun:test'
import { blockPaintSurface, sameBlockPaint, type BlockPaint } from '../src/blockPaint.ts'

const snap = (over: Partial<BlockPaint> = {}): BlockPaint => ({
  raw: '- [ ] 任务\n',
  kind: 'list',
  surface: 'preview',
  ...over,
})

test('三项都没变才跳过重绘', () => {
  expect(sameBlockPaint(snap(), snap())).toBe(true)
})

test('改 raw / 表面 / kind 都要重绘', () => {
  const prev = snap()
  expect(sameBlockPaint(prev, snap({ raw: '- [x] 任务\n' }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ surface: 'cm' }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ surface: 'source' }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ kind: 'paragraph' }))).toBe(false)
})

test('阅读档与编辑档的未聚焦预览是同一种表面', () => {
  expect(blockPaintSurface('read', false)).toBe('preview')
  expect(blockPaintSurface('edit', false)).toBe('preview')
  expect(blockPaintSurface('source', false)).toBe('source')
  expect(blockPaintSurface('edit', true)).toBe('cm')
  expect(blockPaintSurface('read', true)).toBe('cm')
})

test('从没画过（prev 空）必须画', () => {
  expect(sameBlockPaint(undefined, snap())).toBe(false)
})
