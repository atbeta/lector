import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyEncoding, createSourceDocument } from '../src/encoding.ts'
import type { SourceDocument } from '../src/types.ts'

// testdata 真实夹具：test/ 在 packages/core/test，仓库根 testdata 在 ../../testdata。
const TESTDATA_DIR = resolve(import.meta.dir, '..', '..', '..', 'testdata')

// 黄金测试：切片必须无缝覆盖全文（blocks[0].start === 0，
// blocks[i].end === blocks[i+1].start，last.end === text.length）。
// 未编辑保存恒等、只改一块只动一块、CRLF/BOM 还原。

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lector-test-'))
  mkdirSync(join(dir, 'images'), { recursive: true })
})

afterAll(() => {})

function writeFixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

/** 打开 → parse → serialize → applyEncoding，返回最终字节文本。 */
async function roundTrip(path: string): Promise<string> {
  const raw = readFileSync(path, 'utf8')
  const doc = createSourceDocument(path, raw, Date.now())
  const blocks = parseBlocks(doc.text)
  const serialized = serialize(blocks)
  return applyEncoding(doc, serialized)
}

// 三个 fixture 来源：内联字符串、testdata/ 文件、运行时生成。

// 夹具 1：纯中文三段 + 空行
const FIX_CHINESE = '第一段中文。\n\n第二段中文。\n\n第三段中文。\n'

// 夹具 2：# 标题 与 ATX
const FIX_HEADING = '# 一级标题\n\n正文段落。\n\n## 二级标题\n'

// 夹具 3：frontmatter
const FIX_FRONTMATTER = '---\ntitle: 测试\ntags: [a, b]\n---\n\n正文开始。\n'

// 夹具 4：CRLF + 末尾换行无
const FIX_CRLF = '第一行\r\n\r\n第二行\r\n第三行'

// 夹具 5：未改保存后字节相等（含末尾换行）
const FIX_TRAILING = '标题\n\n一段。\n\n最后一段\n'

// 夹具 6：未改保存后字节相等（无末尾换行）

// 动态导入引用（测试红阶段的存根由 index 提供）
let parseBlocks: (text: string) => { id: string; kind: string; start: number; end: number; raw: string; dirty: boolean }[]
let serialize: (blocks: { raw: string; dirty: boolean; start: number; end: number }[]) => string

test('载入 core', async () => {
  const mod = await import('../src/index.ts')
  parseBlocks = mod.parseBlocks
  serialize = mod.serialize
  expect(typeof parseBlocks).toBe('function')
  expect(typeof serialize).toBe('function')
})

describe('切片无缝覆盖全文', () => {
  const cases = [
    ['中文三段', FIX_CHINESE],
    ['标题+ATX', FIX_HEADING],
    ['frontmatter', FIX_FRONTMATTER],
    ['末尾无换行', FIX_TRAILING],
    ['CRLF', FIX_CRLF],
  ] as const

  for (const [label, text] of cases) {
    test(label, () => {
      const blocks = parseBlocks(text)
      // 无缝覆盖全文
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks[0]!.start).toBe(0)
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!
        expect(b.end).toBeGreaterThan(b.start)
        if (i + 1 < blocks.length) {
          expect(b.end).toBe(blocks[i + 1]!.start)
        }
      }
      expect(blocks[blocks.length - 1]!.end).toBe(text.length)
      // raw 与切片一致
      for (const b of blocks) {
        expect(b.raw).toBe(text.slice(b.start, b.end))
      }
      // 拼接还原
      expect(blocks.map((b) => b.raw).join('')).toBe(text)
    })
  }
})

describe('未编辑保存恒等', () => {
  const cases = [
    ['中文三段', FIX_CHINESE],
    ['标题+ATX', FIX_HEADING],
    ['frontmatter', FIX_FRONTMATTER],
    ['CRLF', FIX_CRLF],
    ['末尾有换行', FIX_TRAILING],
  ] as const

  for (const [label, text] of cases) {
    test(label, () => {
      const doc = createSourceDocument('x.md', text, Date.now())
      const blocks = parseBlocks(doc.text)
      const out = applyEncoding(doc, serialize(blocks))
      expect(out).toBe(text)
    })
  }
})

describe('CRLF 与 BOM 还原', () => {
  test('CRLF 文件写回仍为 \\r\\n', () => {
    const doc = createSourceDocument('x.md', FIX_CRLF, Date.now())
    expect(doc.newline).toBe('\r\n')
    const blocks = parseBlocks(doc.text)
    const out = applyEncoding(doc, serialize(blocks))
    expect(out).toBe(FIX_CRLF)
  })

  test('BOM 保留', () => {
    const bom = '\uFEFF' + FIX_CHINESE
    const doc = createSourceDocument('x.md', bom, Date.now())
    expect(doc.hasBom).toBe(true)
    expect(doc.text).toBe(FIX_CHINESE)
    const blocks = parseBlocks(doc.text)
    const out = applyEncoding(doc, serialize(blocks))
    expect(out).toBe(bom)
  })
})

describe('脏一块只动一块', () => {
  test('只改第二段，第一/三段不变', () => {
    const text = '第一段。\n\n第二段。\n\n第三段。\n'
    const doc = createSourceDocument('x.md', text, Date.now())
    const blocks = parseBlocks(doc.text)
    // 找到第二段（含“第二段”的那块）
    const target = blocks.find((b) => b.raw.includes('第二段'))!
    target.dirty = true
    target.raw = '第二段（改动后）。'
    const out = applyEncoding(doc, serialize(blocks))
    const expectOut = '第一段。\n\n第二段（改动后）。\n\n第三段。\n'
    expect(out).toBe(expectOut)
    // 第一三段原样
    expect(blocks.filter((b) => b.raw.includes('第一段'))[0]!.dirty).toBe(false)
  })
})

describe('文件级字节相等（testdata 夹具）', () => {
  const fixtures = [
    'zh-cn.md',
    'gfm-table.md',
    'task-list.md',
    'nested-list.md',
    'html-block.md',
    'no-trailing-newline.md',
    'bom.md',
    'crlf.md',
    'frontmatter.md',
    'mixed-newlines.md',
  ]

  for (const f of fixtures) {
    test(`${f} 打开不改再保存字节相等`, () => {
      const path = join(TESTDATA_DIR, f)
      const raw = readFileSync(path, 'utf8')
      const doc = createSourceDocument(path, raw, Date.now())
      const blocks = parseBlocks(doc.text)
      // 未编辑：全部干净，serialize 用 raw 拼接
      expect(blocks.every((b) => typeof b.raw === 'string' && b.dirty === false)).toBe(true)
      const out = applyEncoding(doc, serialize(blocks))
      expect(out).toBe(raw)
    })
  }
})

describe('块语义（v1 关键行为）', () => {
  test('list 整块一块（不拆项）', () => {
    const text = '- 甲\n- 乙\n- 丙\n\n正文。\n'
    const blocks = parseBlocks(text)
    const list = blocks.filter((b) => b.kind === 'list')
    expect(list).toHaveLength(1)
    expect(list[0]!.raw).toBe('- 甲\n- 乙\n- 丙')
  })

  test('块间空行合成 unknown 缝（不丢空行）', () => {
    const text = '一段。\n\n\n两段。\n'
    const blocks = parseBlocks(text)
    expect(blocks.map((b) => b.raw).join('')).toBe(text)
    // 至少有一个 unknown 缝且 >=1 个换行
    const unknown = blocks.filter((b) => b.kind === 'unknown' && b.raw.includes('\n'))
    expect(unknown.length).toBeGreaterThan(0)
  })

  test('code / blockquote / thematicBreak / heading 种类正确', () => {
    const text = '# 标题\n\n> 引用\n\n```js\nconst a = 1\n```\n\n---\n'
    const blocks = parseBlocks(text)
    const kinds = blocks.map((b) => b.kind)
    expect(kinds).toContain('heading')
    expect(kinds).toContain('blockquote')
    expect(kinds).toContain('code')
    expect(kinds).toContain('thematicBreak')
  })

  test('frontmatter 单独成 yaml 块', () => {
    const text = '---\ntitle: x\n---\n\n正文。\n'
    const blocks = parseBlocks(text)
    const yaml = blocks.find((b) => b.kind === 'yaml')
    expect(yaml).toBeTruthy()
    expect(yaml!.raw).toBe('---\ntitle: x\n---')
  })

  test('GFM 表格解析出 table 块', () => {
    const text = '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |\n'
    const blocks = parseBlocks(text)
    expect(blocks.some((b) => b.kind === 'table')).toBe(true)
  })

  test('GFM 任务列表项带 checked 标记', () => {
    const text = '- [ ] 未完成\n- [x] 已完成\n'
    const blocks = parseBlocks(text)
    const list = blocks.find((b) => b.kind === 'list')
    expect(list).toBeTruthy()
    const items = (list as unknown as { mdast: { children?: Array<{ checked?: boolean | null }> } }).mdast.children ?? []
    expect(items.length).toBe(2)
    expect(items[0]!.checked).toBe(false)
    expect(items[1]!.checked).toBe(true)
  })

  test('id 稳定唯一', () => {
    const blocks = parseBlocks('甲。\n\n乙。\n')
    const ids = blocks.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('数学公式', () => {
  test('块级 $$...$$ 切成 math 块', () => {
    const blocks = parseBlocks('$$\nE = mc^2\n$$\n')
    const math = blocks.find((b) => b.kind === 'math')
    expect(math).toBeTruthy()
    // 块级公式也包括定界符——round-trip 恒等
    expect(math!.raw).toContain('$$')
  })

  test('行内 $...$ 是 paragraph 里的 inlineMath 子节点,paragraph 块完整', () => {
    const text = '质能方程 $E=mc^2$ 与勾股 $a^2+b^2=c^2$。\n'
    const blocks = parseBlocks(text)
    const para = blocks.find((b) => b.kind === 'paragraph')
    expect(para).toBeTruthy()
    const paraNode = (para as unknown as { mdast: { children?: Array<{ type: string }> } }).mdast
    const inlineMathNodes = (paraNode.children ?? []).filter((c) => c.type === 'inlineMath')
    expect(inlineMathNodes.length).toBe(2)
    // raw 是行内原文字节(去掉行尾换行,换行缝不进块)——未改的公式与定界符都还在
    expect(para!.raw).toBe('质能方程 $E=mc^2$ 与勾股 $a^2+b^2=c^2$。')
  })

  test('math 块未编辑保存后字节级恒等', async () => {
    const text = '前文。\n\n$$\nx^2 + y^2 = z^2\n$$\n\n后文。\n'
    const path = writeFixture('math-idem.md', text)
    const out = await roundTrip(path)
    expect(out).toBe(text)
  })
})

export type { SourceDocument }
