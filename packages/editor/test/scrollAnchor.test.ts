import { describe, expect, test } from 'bun:test'
import { scrollAnchorDelta } from '../src/scrollAnchor.ts'

describe('占位块换成真实高度后的滚动补偿', () => {
  test('整块在视口顶边之上、变高 → 补上增高', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 0,
        blockBottom: 40,
        viewportTop: 100,
        oldHeight: 40,
        newHeight: 120,
      }),
    ).toBe(80)
  })

  test('整块在视口顶边之上、变矮 → 减去缩掉的高度', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 10,
        blockBottom: 80,
        viewportTop: 200,
        oldHeight: 70,
        newHeight: 30,
      }),
    ).toBe(-40)
  })

  test('底边刚好落在容差内仍算视口之上', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 0,
        blockBottom: 101,
        viewportTop: 100,
        oldHeight: 20,
        newHeight: 50,
      }),
    ).toBe(30)
  })

  test('底边越过顶边（人正在看这块）不补偿', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 80,
        blockBottom: 140,
        viewportTop: 100,
        oldHeight: 40,
        newHeight: 200,
      }),
    ).toBe(0)
  })

  test('整块在视口下方不补偿', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 400,
        blockBottom: 480,
        viewportTop: 100,
        oldHeight: 40,
        newHeight: 90,
      }),
    ).toBe(0)
  })

  test('高度没变 → 0', () => {
    expect(
      scrollAnchorDelta({
        blockTop: 0,
        blockBottom: 40,
        viewportTop: 100,
        oldHeight: 40,
        newHeight: 40,
      }),
    ).toBe(0)
  })
})
