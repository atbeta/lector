// 文档统计：状态行要的数字必须经得起核对。
//
// 这里最要紧的是「中英混排时字数对不对」——按字符数算会低估英文，
// 按空格分词会漏掉中文。下面用真实的中英混排样本钉住它。

import { describe, expect, test } from 'bun:test'
import { countText, formatCount, readingMinutes } from '../src/stats.ts'

describe('文档统计', () => {
  test('空文档', () => {
    expect(countText('')).toEqual({ words: 0, chars: 0, lines: 0 })
    expect(countText('   \n\n  ')).toEqual({ words: 0, chars: 0, lines: 0 })
    expect(readingMinutes(countText(''))).toBe(0)
  })

  test('纯中文按字计', () => {
    const s = countText('阅读优先的纯 Markdown 编辑器')
    // 中文 9 字（阅读优先的纯 编辑器）+ 西文 1 词（Markdown）
    expect(s.words).toBe(10)
  })

  test('纯英文按词计，标点不算词', () => {
    const s = countText('The quick brown fox jumps over the lazy dog.')
    expect(s.words).toBe(9)
  })

  test('中英混排（中文按字、英文按词，相加）', () => {
    const s = countText('在 AI 时代，读 远大于 写。Markdown is the format.')
    // 中文：在/时/代/读/远/大/于/写/。（标点计入中文，共 9）
    // 英文词：AI 时代 里的 AI、Markdown is the format
    expect(s.words).toBe(9 + 1 + 5)
  })

  test('markdown 语法不计入词数', () => {
    const plain = countText('标题\n\n正文一段')
    const marked = countText('# 标题\n\n正文一段')
    expect(marked.words).toBe(plain.words)

    const link = countText('看 [CommonMark](https://commonmark.org) 规范')
    // 只算 CommonMark 这个词与中文字，URL 不计
    expect(link.words).toBe(countText('看 CommonMark 规范').words)

    const list = countText('- 第一项\n- 第二项')
    expect(list.words).toBe(countText('第一项 第二项').words)
  })

  test('字符数不含空白', () => {
    expect(countText('a b\tc\n\nd').chars).toBe(4)
  })

  test('非空行数', () => {
    expect(countText('a\n\n\nb\n   \nc\n').lines).toBe(3)
  })

  test('阅读时长至少 1 分钟，随字数增长', () => {
    expect(readingMinutes(countText('短'))).toBe(1)
    const long = '这是一段用来测试阅读时长的文字。'.repeat(40) // 680 字左右
    expect(readingMinutes(countText(long))).toBeGreaterThanOrEqual(3)
    expect(readingMinutes(countText(long))).toBeLessThanOrEqual(5)
  })

  test('千分位', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(0)).toBe('0')
  })
})
