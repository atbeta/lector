// 行内格式包裹：边界情况多，而这东西出错只是「有点怪」，不报错。
// 所以把每个分支都钉一遍。

import { describe, expect, test } from 'bun:test'
import { expandFence, toggleWrap } from '../src/wrap.ts'

const w = (t: string, f: number, l: number, left: string, right?: string) =>
  toggleWrap(t, f, l, { left, right })

describe('行内格式包裹', () => {
  test('有选区 → 包裹，且保持选中', () => {
    const r = w('hello world', 6, 11, '**')
    expect(r.text).toBe('hello **world**')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('world')
  })

  test('已包裹 → 解包', () => {
    const r = w('hello **world**', 6, 15, '**')
    expect(r.text).toBe('hello world')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('world')
  })

  test('换行等，解包后光标覆盖原文', () => {
    const r = w('a `code` b', 2, 8, '`')
    expect(r.text).toBe('a code b')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('code')
  })

  test('选区把定界符一起选进来 → 也能解包', () => {
    const r = w('hello **world**', 6, 17, '**')
    expect(r.text).toBe('hello world')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('world')
  })

  test('无选区但在词内 → 包裹整个词并选中', () => {
    const r = w('hello world', 8, 8, '**')
    expect(r.text).toBe('hello **world**')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('world')
  })

  test('无选区且不在词内 → 插一对定界符，光标在中间', () => {
    const r = w('hello ', 6, 6, '**')
    expect(r.text).toBe('hello ****')
    expect(r.selection.from).toBe(8)
    expect(r.selection.to).toBe(8)
  })

  test('中文也按词处理', () => {
    const r = w('这是 中文 句子', 4, 4, '**')
    expect(r.text).toBe('这是 **中文** 句子')
  })

  test('光标在换行处：不裹词，就地插一对定界符', () => {
    const r = w('foo\n', 3, 3, '**')
    expect(r.text).toBe('foo****\n')
  })

  test('左右定界符不同的语言（如上下标式）也能工作', () => {
    const r = w('x = y', 4, 5, '<', '>')
    expect(r.text).toBe('x = <y>')
  })
})

describe('链接包裹', () => {
  const link = (t: string, f: number, l: number) =>
    toggleWrap(t, f, l, { left: '[', placeholder: 'url' })

  test('选中文字 → [文字](url)，光标落到 url 占位', () => {
    const r = link('见 CommonMark 规范', 2, 12)
    expect(r.text).toBe('见 [CommonMark](url) 规范')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('url')
  })

  test('无选区 → 给出占位文字与 url 占位，光标在 url', () => {
    const r = link('见 ', 2, 2)
    expect(r.text).toBe('见 [链接文字](url)')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('url')
  })

  test('选中的已是完整链接 → 只选中 URL，方便改地址', () => {
    const src = '[CommonMark](https://commonmark.org)'
    const r = link(src, 0, src.length)
    expect(r.text).toBe('[CommonMark](https://commonmark.org)')
    expect(r.text.slice(r.selection.from, r.selection.to)).toBe('https://commonmark.org')
  })
})

describe('代码围栏展开', () => {
  test('``` 后回车生成空代码块，光标进块内', () => {
    const r = expandFence('```', 3, 0)
    expect(r).not.toBeNull()
    expect(r!.text).toBe('```\n\n```')
    expect(r!.cursor).toBe(4)
  })

  test('缩进的围栏保持缩进', () => {
    const r = expandFence('  ```', 5, 0)
    expect(r!.text).toBe('  ```\n  \n  ```')
    // 光标落在空行的缩进之后，直接就能敲代码
    expect(r!.cursor).toBe(8)
  })

  test('闭合围栏不展开（前面已有奇数个围栏）', () => {
    expect(expandFence('```\ncode\n```', 12, 1)).toBeNull()
  })

  test('光标不在行尾 / 行内有内容 → 不处理', () => {
    expect(expandFence('```ts', 5, 0)).toBeNull()
    expect(expandFence('```', 1, 0)).toBeNull()
  })
})
