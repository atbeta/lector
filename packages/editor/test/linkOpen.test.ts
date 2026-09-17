// 链接点击策略：分流与分档。
//
// 这两条判据是纯函数、单独测：它们决定「点一下会发生什么」，而这件事在真机上
// 只能靠手动点（ui-verify 里点一下会去开窗口，验不了），所以规则必须在这里钉死。
import { describe, expect, test } from 'bun:test'
import { classifyHref, shouldOpenHref } from '../src/linkOpen.ts'

describe('classifyHref', () => {
  test('外部链接与邮件', () => {
    expect(classifyHref('https://example.com/a.md')).toBe('external')
    expect(classifyHref('HTTP://EXAMPLE.COM')).toBe('external')
    expect(classifyHref('mailto:a@b.c')).toBe('external')
  })

  test('文内锚点单独一类（本轮不开，但要能认出来）', () => {
    expect(classifyHref('#小节')).toBe('anchor')
    expect(classifyHref('  #x  ')).toBe('anchor')
  })

  test('本地：相对路径、绝对路径、file://、Windows 盘符', () => {
    expect(classifyHref('ch2.md')).toBe('local')
    expect(classifyHref('./sub/ch2.md')).toBe('local')
    expect(classifyHref('../other/ch2.md')).toBe('local')
    expect(classifyHref('/Users/x/doc.md')).toBe('local')
    expect(classifyHref('file:///tmp/a%20b.md')).toBe('local')
    // 盘符看着像 scheme（C:），必须按本地路径认——Windows 上全靠这条
    expect(classifyHref('C:\\docs\\a.md')).toBe('local')
    expect(classifyHref('D:/docs/a.md')).toBe('local')
  })

  test('其它 scheme 归 other：绝不能被当成路径去开', () => {
    expect(classifyHref('obsidian://open?vault=x')).toBe('other')
    expect(classifyHref('javascript:alert(1)')).toBe('other')
    expect(classifyHref('')).toBe('other')
    expect(classifyHref(null)).toBe('other')
    expect(classifyHref(undefined)).toBe('other')
  })
})

describe('shouldOpenHref', () => {
  test('可打开的：外部链接、本地文件、文内锚点', () => {
    expect(shouldOpenHref('anchor', 'read', false)).toBe(true)
    expect(shouldOpenHref('other', 'read', true)).toBe(false)
  })

  test('阅读档：直接点就开（带不带修饰键都一样）', () => {
    expect(shouldOpenHref('external', 'read', false)).toBe(true)
    expect(shouldOpenHref('local', 'read', false)).toBe(true)
    expect(shouldOpenHref('local', 'read', true)).toBe(true)
  })

  test('编辑/源码档：要 Cmd/Ctrl——不加修饰键的点击属于「进这块改」', () => {
    for (const mode of ['edit', 'source'] as const) {
      expect(shouldOpenHref('local', mode, false)).toBe(false)
      expect(shouldOpenHref('external', mode, false)).toBe(false)
      expect(shouldOpenHref('anchor', mode, false)).toBe(false)
      expect(shouldOpenHref('local', mode, true)).toBe(true)
      expect(shouldOpenHref('external', mode, true)).toBe(true)
    }
  })
})
