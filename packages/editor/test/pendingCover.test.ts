import { describe, expect, test } from 'bun:test'
import { coveredEndBeforePending } from '../src/pendingCover.ts'

describe('渐进解析的覆盖终点', () => {
  test('文末插入的 end 为 0 的块不会把覆盖区间拉回文首', () => {
    expect(
      coveredEndBeforePending([
        { kind: 'paragraph', end: 100 },
        { kind: 'pending', end: 5000 },
        { kind: 'paragraph', end: 0 },
      ]),
    ).toBe(100)
  })

  test('占位块前面后插入的块不参与，已解析块的最大 end 才算', () => {
    expect(
      coveredEndBeforePending([
        { kind: 'paragraph', end: 40 },
        { kind: 'paragraph', end: 0 },
        { kind: 'paragraph', end: 80 },
        { kind: 'pending', end: 5000 },
      ]),
    ).toBe(80)
  })
})
