import { describe, expect, test } from 'bun:test'
import { headingOffsetsStale, pickActiveHeadingId, type HeadingOffset } from '../src/outlineSpy.ts'

const offsets: HeadingOffset[] = [
  { id: 'h1', top: 0 },
  { id: 'h2', top: 400 },
  { id: 'h3', top: 900 },
]

describe('pickActiveHeadingId', () => {
  test('空表返回 null', () => {
    expect(pickActiveHeadingId([], 0, 600, 1000)).toBeNull()
  })

  test('顶部落在第一节', () => {
    expect(pickActiveHeadingId(offsets, 0, 600, 2000)).toBe('h1')
  })

  test('越过第二节阅读线', () => {
    expect(pickActiveHeadingId(offsets, 400 - 72, 600, 2000)).toBe('h2')
  })

  test('刚到第二节顶但还没过阅读线，仍属上一节', () => {
    expect(pickActiveHeadingId(offsets, 400 - 73, 600, 2000)).toBe('h1')
  })

  test('到底取最后一节', () => {
    expect(pickActiveHeadingId(offsets, 1400, 600, 2000)).toBe('h3')
  })
})

describe('headingOffsetsStale', () => {
  test('没量过、或高度变了才算过期', () => {
    expect(headingOffsetsStale(null, 1000)).toBe(true)
    expect(headingOffsetsStale(1000, 1000)).toBe(false)
    expect(headingOffsetsStale(1000, 1200)).toBe(true)
  })
})
