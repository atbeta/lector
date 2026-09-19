import { expect, test } from 'bun:test'
import { sameBlockPaint, type BlockPaint } from '../src/blockPaint.ts'

const snap = (over: Partial<BlockPaint> = {}): BlockPaint => ({
  raw: '- [ ] 任务\n',
  kind: 'list',
  focused: false,
  mode: 'edit',
  ...over,
})

test('四项都没变才跳过重绘', () => {
  expect(sameBlockPaint(snap(), snap())).toBe(true)
})

test('改 raw / 聚焦 / 档位 / kind 都要重绘', () => {
  const prev = snap()
  expect(sameBlockPaint(prev, snap({ raw: '- [x] 任务\n' }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ focused: true }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ mode: 'read' }))).toBe(false)
  expect(sameBlockPaint(prev, snap({ kind: 'paragraph' }))).toBe(false)
})

test('从没画过（prev 空）必须画', () => {
  expect(sameBlockPaint(undefined, snap())).toBe(false)
})
