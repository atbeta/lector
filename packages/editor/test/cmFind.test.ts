import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { findHitField } from '../src/cmFind.ts'

/**
 * 整篇 CM 的查找标记。
 *
 * 大文件档和源码档都不建块，查找只能靠这份 StateField 画高亮。
 * 它曾经挂在 `largeDocument` 这个性能闸门上，源码档因此静默失去高亮——
 * 计数照常、Enter 照样翻序号，正文里却什么都不显示。
 *
 * 这里不建 EditorView：那要 DOM，而 bun test 没有。要守的不变量是
 * 「field 装没装上」——当初坏的就是这一点，装饰集的内容由浏览器脚本覆盖。
 */
const make = (doc: string, whole: boolean): EditorState =>
  EditorState.create({ doc, extensions: whole ? [findHitField] : [] })

describe('整篇 CM 的查找标记', () => {
  test('给了 wholeDocument 才装得上 findHitField', () => {
    const s = make('a Markdown b\nMarkdown', true)
    expect(() => s.field(findHitField)).not.toThrow()
    expect(s.field(findHitField).size).toBe(0)
  })

  test('没给 wholeDocument 就没有这个 field（applyFind 的判据必须与之一致）', () => {
    expect(() => make('a Markdown b', false).field(findHitField)).toThrow()
  })

  test('两个整篇档用的是同一份能力，不因 largeDocument 分叉', () => {
    // 挂载条件只认 wholeDocument。这条防的是有人把它改回 largeDocument——
    // 那会让源码档再次静默失效，而大文件档看不出来（它两个标记都有）。
    const asWhole = make('x', true)
    expect(asWhole.field(findHitField).size).toBe(0)
  })
})
