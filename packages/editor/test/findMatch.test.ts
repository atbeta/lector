// 匹配器的契约：三处（计数/高亮/替换）共用它，所以边界必须钉死。
import { describe, expect, test } from 'bun:test'
import { compileFind, countFind, DEFAULT_FIND_OPTIONS, findInLineSource, replaceFind } from '../src/findMatch.ts'

const O = (o: Partial<typeof DEFAULT_FIND_OPTIONS> = {}) => ({ ...DEFAULT_FIND_OPTIONS, ...o })

describe('字符串模式', () => {
  test('默认不区分大小写', () => {
    expect(countFind('Read read READ', 'read', O())).toBe(3)
  })
  test('区分大小写后只算精确匹配', () => {
    expect(countFind('Read read READ', 'read', O({ caseSensitive: true }))).toBe(1)
  })
  test('查询里的正则元字符按字面量处理', () => {
    expect(countFind('a.b axb', 'a.b', O())).toBe(1)
  })
  test('全词只匹配独立单词', () => {
    expect(countFind('cat cats scatter', 'cat', O({ wholeWord: true }))).toBe(1)
    expect(countFind('cat cats scatter', 'cat', O())).toBe(3)
  })
})

describe('正则模式', () => {
  test('捕获组与字符类', () => {
    expect(countFind('a1 b2 c3', '[a-c]\\d', O({ regex: true }))).toBe(3)
  })
  test('语法错报 invalid-regex，不静默退回字符串搜', () => {
    const c = compileFind('([', O({ regex: true }))
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.error).toBe('invalid-regex')
  })
  test('嵌套量词报 risky-regex（灾难性回溯的形状）', () => {
    for (const bad of ['(a+)+$', '(\\w*)*', '(\\d{1,3})+']) {
      const c = compileFind(bad, O({ regex: true }))
      expect(c.ok).toBe(false)
      if (!c.ok) expect(c.error).toBe('risky-regex')
    }
  })
  test('零宽命中不死循环（a* 在无 a 处）', () => {
    expect(countFind('bbb', 'a*', O({ regex: true }))).toBe(0)
    expect(countFind('aba', 'a*', O({ regex: true }))).toBe(2)
  })
  test('超长模式直接拒绝', () => {
    const c = compileFind('a'.repeat(201), O({ regex: true }))
    expect(c.ok).toBe(false)
  })
})

test('空查询是 empty，不是"命中 0 处"', () => {
  const c = compileFind('', O())
  expect(c.ok).toBe(false)
  if (!c.ok) expect(c.error).toBe('empty')
})

describe('源码按行查找（大文件）', () => {
  function lines(text: string) {
    const raw = text.split('\n')
    return {
      lines: raw.length,
      line(n: number) {
        const prev = raw.slice(0, n - 1).join('\n')
        const from = n === 1 ? 0 : prev.length + 1
        return { from, text: raw[n - 1]! }
      },
    }
  }

  test('第二行命中的偏移含换行', () => {
    const src = lines('alpha\nbeta beta\ngamma')
    const hits = findInLineSource(src, 'beta', O())
    expect(hits).toEqual([
      { start: 6, end: 10 },
      { start: 11, end: 15 },
    ])
  })

  test('查询含换行时能跨行命中', () => {
    const src = lines('foo\nbar\nbaz')
    expect(findInLineSource(src, 'foo\nbar', O())).toEqual([{ start: 0, end: 7 }])
  })

  test('无效正则不抛、不报命中', () => {
    expect(findInLineSource(lines('abc'), '([', O({ regex: true }))).toEqual([])
  })
})

describe('替换', () => {
  test('全替换与只替换第一处', () => {
    expect(replaceFind('a a a', 'a', 'b', O(), true)).toBe('b b b')
    expect(replaceFind('a a a', 'a', 'b', O(), false)).toBe('b a a')
  })
  test('正则模式下用捕获组', () => {
    expect(replaceFind('v1 v2', 'v(\\d)', 'V$1', O({ regex: true }), true)).toBe('V1 V2')
  })
  test('无效模式原样返回，不误改正文', () => {
    expect(replaceFind('abc', '([', 'x', O({ regex: true }), true)).toBe('abc')
  })
})
