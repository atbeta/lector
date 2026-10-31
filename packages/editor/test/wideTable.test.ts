import { describe, expect, test } from 'bun:test'
import { tableNeedsBreakout, wideTablePlacement } from '../src/wideTable.ts'

describe('宽表才突出栏边', () => {
  test('比栏宽超出容差 → 突出', () => {
    expect(tableNeedsBreakout(860, 800)).toBe(true)
  })

  test('刚刚好或只多 1px → 留在栏内', () => {
    expect(tableNeedsBreakout(800, 800)).toBe(false)
    expect(tableNeedsBreakout(801, 800)).toBe(false)
  })

  test('窄表不突出', () => {
    expect(tableNeedsBreakout(420, 800)).toBe(false)
  })

  test('还没量到宽度时不突出', () => {
    expect(tableNeedsBreakout(0, 800)).toBe(false)
    expect(tableNeedsBreakout(900, 0)).toBe(false)
    expect(tableNeedsBreakout(Number.NaN, 800)).toBe(false)
  })

  test('借得下留白就突出，不在表内横滑', () => {
    expect(wideTablePlacement(858, 800, 960)).toEqual({ breakout: true, scroll: false })
  })

  test('二十列借完留白仍放不下：留在栏内横滑，外框不占满整行', () => {
    expect(wideTablePlacement(1559, 800, 960)).toEqual({ breakout: false, scroll: true })
  })

  test('窄表既不突出也不横滑', () => {
    expect(wideTablePlacement(420, 800, 960)).toEqual({ breakout: false, scroll: false })
  })
})