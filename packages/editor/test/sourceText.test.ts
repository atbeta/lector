import { describe, expect, test } from 'bun:test'
import { EditorState, Text } from '@codemirror/state'
import { restoreLineEndings } from '@lector/core'
import { toCmText } from '../src/sourceText.ts'

/** CM 自己装载这篇文章时的正文形态。 */
const cmDoc = (raw: string): Text => EditorState.create({ doc: raw }).doc

/**
 * 判脏的全部依据：`!cmDoc(原文).eq(toCmText(原文))`。
 *
 * 这一条不成立，打开一个 CRLF 文件就会立刻显示「未保存」，
 * 而用户什么都没做——比漏报更烦人，也更难解释。
 */
const looksDirty = (raw: string): boolean => !cmDoc(raw).eq(toCmText(raw))

describe('源码档判脏的口径', () => {
  test('LF 原文没改过就不脏', () => {
    expect(looksDirty('a\nb\nc\n')).toBe(false)
  })

  test('CRLF 原文没改过就不脏', () => {
    expect(looksDirty('a\r\nb\r\nc\r\n')).toBe(false)
  })

  test('混合换行与裸 CR 的原文没改过就不脏', () => {
    expect(looksDirty('a\r\nb\nc\rd\n')).toBe(false)
  })

  test('空文档与只有结尾换行的文档不脏', () => {
    expect(looksDirty('')).toBe(false)
    expect(looksDirty('\n')).toBe(false)
    expect(looksDirty('\r\n')).toBe(false)
  })

  test('真改了就是脏的（三种换行形态都成立）', () => {
    for (const [raw, edited] of [
      ['a\nb\n', 'a\nB\n'],
      ['a\r\nb\r\n', 'a\r\nB\r\n'],
      ['a\r\nb\n', 'a\r\nB\n'],
    ] as const) {
      expect(!toCmText(edited).eq(toCmText(raw))).toBe(true)
    }
  })

  test('长文档也按同一口径（走 Text 树的多叶分支）', () => {
    const line = '中文段落里混排 Latin 与数字 2026，还有 `inline code`。'
    const lf = Array.from({ length: 200 }, (_, i) => `${line} ${i}`).join('\n') + '\n'
    expect(looksDirty(lf)).toBe(false)
    expect(looksDirty(lf.replace(/\n/g, '\r\n'))).toBe(false)
  })
})

describe('源码档写回时的行尾还原', () => {
  test('CRLF 文件改一行，其余行仍是 CRLF', () => {
    const saved = restoreLineEndings('a\nB\nc\n', 'a\r\nb\r\nc\r\n')
    expect(saved).toBe('a\r\nB\r\nc\r\n')
  })

  test('判脏用的 CM 形态与写回的原文形态对得上', () => {
    // 编辑器里拿到的永远是 LF 形态；写回时按原文行号还原。
    const disk = 'x\r\ny\r\n'
    const edited = cmDoc(disk).toString().replace('y', 'Y')
    expect(edited).toBe('x\nY\n')
    expect(restoreLineEndings(edited, disk)).toBe('x\r\nY\r\n')
  })

  test('混合换行按行号逐行还原', () => {
    expect(restoreLineEndings('a\nB\nc\n', 'a\r\nb\nc\r\n')).toBe('a\r\nB\nc\r\n')
  })
})
