import { describe, expect, test } from 'bun:test'
import { tableNeedsBreakout } from '../src/wideTable.ts'

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
})