import { describe, expect, test } from 'bun:test'
import { estimateBlockEm } from '../src/offscreenShells.ts'

describe('屏外块的估算高度', () => {
  test('标题用固定行高，不按正文字数折行', () => {
    expect(estimateBlockEm({ kind: 'heading', raw: '# 标题' })).toBe(2.6)
  })

  test('短段落按至少一行估算', () => {
    expect(estimateBlockEm({ kind: 'paragraph', raw: '你好' })).toBeCloseTo(2.25)
  })

  test('代码块用更紧的行高，并且有上限', () => {
    const raw = Array.from({ length: 80 }, () => 'const x = 1').join('\n')
    expect(estimateBlockEm({ kind: 'code', raw })).toBe(28)
  })

  test('很长的段落不超过 24em', () => {
    expect(estimateBlockEm({ kind: 'paragraph', raw: '字'.repeat(8_000) })).toBe(24)
  })
})
