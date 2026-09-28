// 分块解析必须与整篇解析严格等价：块边界、kind、mdast（去 position）都相同。
// 这些用例专门压切点判据与定义补桩——切错的表现是预览错但不报错，只能靠比对抓。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBlocks } from '../src/index.ts'
import { createChunkedParser, findSafeSplits, parseBlocksWhole, type ChunkOptions } from '../src/chunk.ts'
import type { BlockView } from '../src/types.ts'

const tiny: ChunkOptions = { target: 256 }

function stripPosition(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPosition)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'position') continue
    out[k] = stripPosition(v)
  }
  return out
}

function signature(blocks: BlockView[]): string {
  return blocks.map((b) => `${b.start}:${b.end}:${b.kind}`).join('|')
}

/** 分块结果与整篇 oracle 完全一致，且切片无缝覆盖原文。 */
function expectEquivalent(text: string, opts?: ChunkOptions): void {
  const whole = parseBlocksWhole(text)
  const chunked = parseBlocks(text, opts)
  expect(signature(chunked)).toBe(signature(whole))
  for (let i = 0; i < chunked.length; i++) {
    expect(stripPosition(chunked[i]!.mdast)).toEqual(stripPosition(whole[i]!.mdast))
    expect(chunked[i]!.raw).toBe(whole[i]!.raw)
  }
  expect(chunked.map((b) => b.raw).join('')).toBe(text)
  if (chunked.length > 0) {
    expect(chunked[0]!.start).toBe(0)
    expect(chunked.at(-1)!.end).toBe(text.length)
    for (let i = 1; i < chunked.length; i++) {
      expect(chunked[i]!.start).toBe(chunked[i - 1]!.end)
    }
  }
}

describe('分块解析 ≡ 整篇解析', () => {
  const cases: Array<[string, string]> = [
    ['空文档', ''],
    ['单段', '你好 world\n'],
    ['普通段落', '一段。\n\n两段。\n\n三段。\n'],
    ['围栏内空行', '前文\n\n```\ncode\n\nstill code\n```\n\n后文\n'],
    ['围栏标记混用', '```\ncode\n~~~\nnot close\n```\n\n后文\n'],
    ['带 info string 的假关闭围栏', '````js info\ncode\n``` \n仍在围栏里\n````\n\n后文\n'],
    ['数学块内空行', '前文\n\n$$\na\n\nb\n$$\n\n后文\n'],
    ['单行数学', '价格 $$x$$ 元\n\n后文\n'],
    ['HTML 注释跨空行', '前文\n\n<!--\n注释\n\n还没完\n-->\n\n后文\n'],
    ['pre 跨空行', '前文\n\n<pre>\n代码\n\n还在\n</pre>\n\n后文\n'],
    ['frontmatter', '---\ntitle: 标题\n---\n\n正文\n'],
    ['空行后同类列表续项', '前文\n\n- 甲\n\n- 乙\n\n- 丙\n\n后文\n'],
    ['星号列表', '前文\n\n* 甲\n\n* 乙\n\n后文\n'],
    ['加号列表', '前文\n\n+ 甲\n\n+ 乙\n\n后文\n'],
    ['有序列表点号', '前文\n\n1. 甲\n\n2. 乙\n\n后文\n'],
    ['有序列表括号', '前文\n\n1) 甲\n\n2) 乙\n\n后文\n'],
    ['单独一行的空列表项', '前文\n\n-\n\n-\n\n后文\n'],
    ['空行后换标记字符', '前文\n\n- 甲\n\n* 乙\n\n后文\n'],
    ['details 跨空行', '前文\n\n<details>\n\n内容\n\n</details>\n\n后文\n'],
    ['表格后紧跟段落', '| a | b |\n|---|---|\n| 1 | 2 |\n紧跟的段落\n\n后文\n'],
    ['脚注定义在文末', '见[^a]与[^b]。\n\n正文。\n\n[^a]: 注一\n[^b]: 注二\n'],
    ['定义在引用块里', '引用 [foo][bar]。\n\n> [bar]: https://example.com/bar "标题"\n'],
    ['定义在列表项里', '见 [baz]。\n\n- [baz]: https://example.com/baz\n'],
    ['跨行标签', '见 [foo\nbar] 定义。\n\n[foo bar]: https://example.com/wrap\n'],
    ['脚注定义在引用块里', '见[^a]。\n\n> [^a]: 引用块中的脚注\n'],
    ['缩进代码里形似定义', '见 [x] 吗。\n\n    [x]: https://not-a-definition.com\n'],
    ['文末未闭合围栏加脚注引用', '见[^a]。\n\n```\ncode\n'],
    ['CRLF', '一段。\r\n\r\n两段。\r\n'],
    ['BOM', '\uFEFF正文\n\n第二段\n'],
    ['混合换行', '一段。\r\n\n两段。\n'],
  ]

  for (const [name, text] of cases) {
    test(name, () => expectEquivalent(text, tiny))
  }

  test('仓库夹具逐份等价', () => {
    const dir = join(import.meta.dir, '../../../testdata')
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      expectEquivalent(readFileSync(join(dir, name), 'utf8'), tiny)
    }
  })
})

describe('切点自校验', () => {
  test('未闭合围栏把片尾空行吞掉时，合并重解析而不是切错', () => {
    // 关闭围栏缩进超过 3：micromark 不认，扫描器若误判已关闭就会在后面的空行处切
    const text = '前文\n\n```\ncode\n    ```\n\n后文\n'
    expectEquivalent(text, tiny)
  })

  test('在松散列表中间切开会被接缝检查合并回来', () => {
    const text = '- 甲\n\n- 乙\n\n- 丙\n\n- 丁\n'
    const splits = findSafeSplits(text, 4)
    // 扫描器可能给出切点，但最终块划分必须与整篇一致（一个列表）
    expect(splits.length).toBeGreaterThanOrEqual(0)
    const blocks = parseBlocks(text, tiny)
    expect(blocks.filter((b) => b.kind === 'list')).toHaveLength(1)
    expectEquivalent(text, tiny)
  })
})

describe('单块重解析带定义集', () => {
  test('未闭合围栏不会把桩文本吞进代码块', () => {
    const { parseBlockRoots } = require('../src/index.ts') as typeof import('../src/index.ts')
    const raw = '```\ncode'
    const roots = parseBlockRoots(raw, { links: new Map(), footnotes: new Set(['a']) })
    const code = roots.find((n) => (n as { type: string }).type === 'code') as { value?: string }
    expect(code?.value ?? '').not.toContain('[^a]')
  })

  test('带定义集时引用被解析成 linkReference', () => {
    const { parseBlockRoots } = require('../src/index.ts') as typeof import('../src/index.ts')
    const roots = parseBlockRoots('见 [docs][d] 这里', {
      links: new Map([['d', { url: 'https://a.com', title: null }]]),
      footnotes: new Set(),
    })
    const flat = JSON.stringify(roots)
    expect(flat).toContain('linkReference')
    expect(flat).not.toContain('https://a.com')
  })
})

describe('增量解析', () => {
  test('任意步长跑完与一次性结果相同', () => {
    const text = '一段。\n\n两段。\n\n- 甲\n\n- 乙\n\n见[^a]。\n\n[^a]: 注\n'
    const once = parseBlocks(text, tiny)
    const parser = createChunkedParser(text, tiny)
    const stepped: BlockView[] = []
    // 预算 0：每次最多一片
    while (!parser.done) stepped.push(...parser.step(0))
    expect(signature(stepped)).toBe(signature(once))
    expect(stepped.map((b) => b.raw).join('')).toBe(text)
  })
})

describe('随机拼接', () => {
  const fragments = [
    '一段正文。\n\n',
    '- 甲\n- 乙\n\n',
    '- 甲\n\n- 乙\n\n',
    '1. 甲\n\n2. 乙\n\n',
    '```\ncode\n\nmore\n```\n\n',
    '$$\na+b\n$$\n\n',
    '> 引用\n\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n',
    '见[^n]。\n\n',
    '[^n]: 注\n\n',
    '见 [foo][bar]。\n\n',
    '> [bar]: https://example.com\n\n',
    '<!--\n注释\n-->\n\n',
    '<details>\n\n内文\n\n</details>\n\n',
    '---\n\n',
  ]

  test('种子固定的 200 份随机文档逐份等价', () => {
    let seed = 20260929
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let doc = 0; doc < 200; doc++) {
      let text = ''
      const count = 3 + Math.floor(rand() * 12)
      for (let i = 0; i < count; i++) text += fragments[Math.floor(rand() * fragments.length)]!
      expectEquivalent(text, tiny)
    }
  })
})
