import { describe, expect, test } from 'bun:test'
import { safeHref } from '../src/mdastHtml.ts'
import { resolveImageSrc } from '../src/asset.ts'

describe('链接协议白名单', () => {
  test('允许 http / https / mailto / 页内锚点 / 无协议相对路径', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeHref('#sec')).toBe('#sec')
    expect(safeHref('other.md')).toBe('other.md')
  })

  test('拒绝 javascript / data / file / 未知协议', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('vbscript:x')).toBeNull()
  })
})

describe('图片 src 守卫', () => {
  test('拒绝 file: 与 blob:', () => {
    expect(resolveImageSrc('file:///tmp/a.png')).toBe('')
    expect(resolveImageSrc('blob:https://x/1')).toBe('')
  })

  test('允许 https 与安全 data 图', () => {
    expect(resolveImageSrc('https://x.com/a.png')).toBe('https://x.com/a.png')
    expect(resolveImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })

  test('拒绝非图片 data:', () => {
    expect(resolveImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe('')
  })
})
