// 文档统计：状态行要的数字必须经得起核对。
//
// 这里最要紧的是「中英混排时词数对不对」——按字符数算会低估英文，
// 按空格分词会漏掉中文。下面用真实的中英混排样本钉住它。
//
// 口径：词对齐 Word（CJK 逐字 + 西文分词，标点计入）；字符 = 源码码点；
// 行 = 源码逻辑行（换行 + 1）。

import { describe, expect, test } from 'bun:test'
import { blockStats, countBlocks, countText, countWordsApprox, formatCount, readingMinutes } from '../src/stats.ts'
import { parseBlocks } from '../src/parse.ts'

describe('文档统计', () => {
  test('空文档', () => {
    expect(countText('')).toEqual({ words: 0, chars: 0, lines: 0 })
    // 只有空白：词 0，但源码有 2 个换行 → 3 行（逻辑行）
    expect(countText('   \n\n  ')).toEqual({ words: 0, chars: 7, lines: 3 })
    expect(readingMinutes(countText(''))).toBe(0)
  })

  test('纯中文按字计，标点计入', () => {
    expect(countText('阅读优先的纯 Markdown 编辑器').words).toBe(10)
    expect(countText('你好，世界。').words).toBe(6)
  })

  test('全角空格是空白，不算词', () => {
    // 旧实现把 U+3000 算进 CJK，这里会虚高成 5
    expect(countText('你好\u3000世界').words).toBe(4)
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

  test('字符数按源码算：Markdown 语法与空白都计入（Typora 口径）', () => {
    // 链接的 URL 与括号在源码里，字符数照算；词数仍只算「看」。
    const link = countText('[看](https://example.com/very/long/path)')
    expect(link.chars).toBe(39)
    expect(link.words).toBe(1)

    const marked = countText('# 标题\n\n正文')
    expect(marked.chars).toBe(8) // # 空格 换行都计入
    expect(marked.words).toBe(countText('标题正文').words)
  })

  test('emoji 与增补平面汉字各算一个字符（按码点，不按 UTF-16）', () => {
    // 有意与 Typora 不同：它用 .length（UTF-16），emoji 会算成 2。
    expect(countText('😀').chars).toBe(1)
    expect(countText('你好😀').chars).toBe(3)
    expect(countText('😀').words).toBe(0)
  })

  test('行数按源码逻辑行算（含空行与末尾空行）', () => {
    expect(countText('a\n\n\nb\n   \nc\n').lines).toBe(7) // 6 换行 + 1
    expect(countText('a\nb').lines).toBe(2)
    expect(countText('a\nb\n').lines).toBe(3) // 末尾空行也算一行
    expect(countText('单行').lines).toBe(1)
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

  test('逐块相加与整篇一致（词数可加）', () => {
    const md = '# 标题\n\n中文正文 English words。\n\n- 甲\n- 乙\n\n```\ncode\n```\n'
    const blocks = parseBlocks(md)
    const sum = { words: 0, chars: 0, newlines: 0 }
    for (const b of blocks) {
      const s = blockStats(b)
      sum.words += s.words
      sum.chars += s.chars
      sum.newlines += s.newlines
    }
    const whole = countText(md)
    expect(sum.words).toBe(whole.words)
    expect(sum.chars).toBe(whole.chars)
    expect(sum.newlines + 1).toBe(whole.lines)
  })

  test('缓存命中：同一块 raw 不变时重复统计不重算', () => {
    const blocks = parseBlocks('# A\n\n内容甲\n\n## B\n\n内容乙')
    const first = blockStats(blocks[0]!)
    blocks[0]!.mdast = null
    // mdast 被清空，但 raw 没变：缓存仍命中，结果不变
    expect(blockStats(blocks[0]!)).toEqual(first)
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

describe('大文件近似词数（countWordsApprox）', () => {
  test('纯散文与精确口径基本一致', () => {
    const prose = 'hello world\n\n你好 世界\n\nfoo bar baz\n'
    expect(countWordsApprox(prose)).toBe(countText(prose).words)
  })

  test('剥掉常见语法噪声：标题 / 列表 / 强调 / 链接 URL / 行内代码', () => {
    const md = '# 标题\n\n这是一段**加粗**文字，含 [链接](https://example.com) 和 `code`。\n\n- 列表项一\n- 列表项二\n'
    const approx = countWordsApprox(md)
    const exact = countText(md).words
    // 近似值应落在精确值附近（不把 URL / 语法符算成词）
    expect(approx).toBeGreaterThan(exact * 0.8)
    expect(approx).toBeLessThanOrEqual(exact)
  })

  test('围栏代码块整体不计入', () => {
    const md = '```ts\nconst x = 1\nfunction f() { return x }\n```\n\n正文一段。\n'
    expect(countWordsApprox(md)).toBe(5) // 只有「正文一段。」（CJK 标点计入）
  })

  test('frontmatter 不计入', () => {
    const md = '---\ntitle: 标题\n---\n\n正文内容。\n'
    expect(countWordsApprox(md)).toBe(5) // 只有「正文内容。」
  })

  test('空文本为 0', () => {
    expect(countWordsApprox('')).toBe(0)
  })
})
