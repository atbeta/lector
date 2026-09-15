import { describe, expect, test } from 'bun:test'
import { sanitizeRelative, resolveImageSrc, assetLocalPath } from '../src/asset.ts'

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

describe('assetLocalPath：协议 URL 反解成本地路径', () => {
  const winSrc = (p: string) =>
    `http://lector-file.localhost/${encodeURIComponent(p)}`
  const posixSrc = (p: string) => `lector-file://localhost/${encodeURIComponent(p)}`

  test('Windows：剥前导斜杠，并把分隔符统一成反斜杠', () => {
    // base 是原生分隔符、relative 是 '/'，拼出来是混的——必须归一
    expect(assetLocalPath(winSrc('/D:\\Code/images/2025-12-15-010306.png'))).toBe(
      'D:\\Code\\images\\2025-12-15-010306.png',
    )
  })

  test('POSIX：分隔符统一成正斜杠', () => {
    expect(assetLocalPath(posixSrc('/Users/me/notes/images/a.png'))).toBe(
      '/Users/me/notes/images/a.png',
    )
  })

  test('外链 / data / 非本协议返回 null', () => {
    expect(assetLocalPath('https://x.com/a.png')).toBeNull()
    expect(assetLocalPath('data:image/png;base64,abc')).toBeNull()
    expect(assetLocalPath('')).toBeNull()
  })
})
