// 文档统计：状态行要的数字必须经得起核对。
//
// 这里最要紧的是「中英混排时字数对不对」——按字符数算会低估英文，
// 按空格分词会漏掉中文。下面用真实的中英混排样本钉住它。

import { describe, expect, test } from 'bun:test'
import { countBlocks, countText, formatCount, readingMinutes } from '../src/stats.ts'
import { parseBlocks } from '../src/parse.ts'

describe('文档统计', () => {
  test('空文档', () => {
    expect(countText('')).toEqual({ words: 0, chars: 0, charsWithSpaces: 0, lines: 0 })
    expect(countText('   \n\n  ')).toEqual({ words: 0, chars: 0, charsWithSpaces: 0, lines: 0 })
    expect(readingMinutes(countText(''))).toBe(0)
  })

  test('纯中文按字计，标点计入', () => {
    expect(countText('阅读优先的纯 Markdown 编辑器').words).toBe(10)
    expect(countText('你好，世界。').words).toBe(6)
  })

  test('纯英文按词计，标点不算词', () => {
    const s = countText('The quick brown fox jumps over the lazy dog.')
    expect(s.words).toBe(9)
  })

  test('缩写与连字符词各算一个（对齐 Word/Typora）', () => {
    // 旧实现按标点硬切：don't → 2 词、state-of-the-art → 4 词，虚高一倍
    expect(countText("I don't think it's state-of-the-art.").words).toBe(5)
  })

  test('中英混排（中文按字、英文按词，相加）', () => {
    const s = countText('在 AI 时代，读 远大于 写。Markdown is the format.')
    // 中文（含全角标点）：在时代，读远大于写。共 10
    // 英文词：AI、Markdown、is、the、format 共 5
    expect(s.words).toBe(10 + 5)
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

  test('frontmatter 是元数据，不计入', () => {
    const s = countText('---\ntitle: 笔记\ntags: [a, b]\n---\n正文内容。')
    // 只有正文 5 字（正文内容。），title/tags/a/b 都不算
    expect(s.words).toBe(5)
  })

  test('字符数按渲染后文本算，URL 不计入', () => {
    const s = countText('[看](https://example.com/very/long/path)')
    expect(s.chars).toBe(1)
    expect(s.charsWithSpaces).toBe(1)
  })

  test('字符数两种口径', () => {
    const s = countText('a b\tc\n\nd')
    expect(s.chars).toBe(4) // 不计空白
    expect(s.charsWithSpaces).toBe(7) // a b\tc + \n + d
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

describe('按块增量统计', () => {
  test('countBlocks 与整篇 countText 结果一致', () => {
    const md =
      '---\ntitle: 笔记\n---\n\n# 标题\n\n正文一段，含 [链接](https://example.com/a/b)。\n\n```js\nconst x = 1\n```\n\n- 甲\n- 乙\n'
    const blocks = parseBlocks(md)
    expect(blocks.length).toBeGreaterThan(1)
    expect(countBlocks(blocks)).toEqual(countText(md))
  })

  test('dirty 块不信任旧 mdast，按 raw 现算', () => {
    // 打字中 syncBlockText 只更新 raw 不重解析 mdast——统计必须跟 raw 走
    const blocks = parseBlocks('旧的内容文字')
    const b0 = blocks[0]!
    b0.raw = '全新的内容 hello'
    b0.dirty = true
    expect(countBlocks(blocks)).toEqual(countText('全新的内容 hello'))
  })

  test('memo 命中：重复统计结果一致且缓存生效', () => {
    const blocks = parseBlocks('# A\n\n内容甲\n\n## B\n\n内容乙')
    const memo = new Map<string, string>()
    const s1 = countBlocks(blocks, memo)
    const s2 = countBlocks(blocks, memo)
    expect(s2).toEqual(s1)
    expect(memo.size).toBeGreaterThan(0)
  })

  test('mdast 为数组形态（多顶层节点块）也能统计', () => {
    const blocks = parseBlocks('第一段文字。\n\n第二段文字。')
    const b = blocks[0]!
    const roots = parseBlocks(b.raw)
    // 模拟 finalizeFocused 的多根形态
    b.mdast = roots.length > 1 ? roots : b.mdast
    expect(countBlocks(blocks).words).toBeGreaterThan(0)
  })
})
