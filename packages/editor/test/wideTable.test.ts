import { describe, expect, test } from 'bun:test'
import { tableScrollsInColumn } from '../src/wideTable.ts'

describe('表停在阅读栏里', () => {
  test('比栏宽超出容差 → 栏内横滑', () => {
    expect(tableScrollsInColumn(860, 800)).toBe(true)
    expect(tableScrollsInColumn(1559, 800)).toBe(true)
  })

  test('刚刚好或只多 1px → 不滑', () => {
    expect(tableScrollsInColumn(800, 800)).toBe(false)
    expect(tableScrollsInColumn(801, 800)).toBe(false)
  })

  test('窄表不滑', () => {
    expect(tableScrollsInColumn(420, 800)).toBe(false)
  })

  test('还没量到宽度时不滑', () => {
    expect(tableScrollsInColumn(0, 800)).toBe(false)
    expect(tableScrollsInColumn(900, 0)).toBe(false)
    expect(tableScrollsInColumn(Number.NaN, 800)).toBe(false)
  })
})
