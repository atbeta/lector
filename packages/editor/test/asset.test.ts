import { describe, expect, test } from 'bun:test'
import { sanitizeRelative, resolveImageSrc } from '../src/asset.ts'

describe('asset 路径守卫', () => {
  test('允许同目录与子目录相对路径', () => {
    expect(sanitizeRelative('a.png')).toBe('a.png')
    expect(sanitizeRelative('images/b.png')).toBe('images/b.png')
    expect(sanitizeRelative('./c.png')).toBe('./c.png')
  })

  test('拒绝向 doc 目录之上逃逸（../）', () => {
    expect(sanitizeRelative('../a.png')).toBeNull()
    expect(sanitizeRelative('../../a.png')).toBeNull()
    expect(sanitizeRelative('images/../../a.png')).toBeNull()
  })

  test('绝对路径原样返回', () => {
    // 解析前先走绝对判定，不进入守卫
    expect(resolveImageSrc('https://x.com/a.png')).toBe('https://x.com/a.png')
    expect(resolveImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })
})
