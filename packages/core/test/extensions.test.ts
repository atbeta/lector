import { describe, expect, test } from 'bun:test'
import { kindFromMdast, parseBlockRoots } from '../src/index.ts'

type AnyNode = { type: string; children?: AnyNode[]; value?: string }

describe('扩展语法解析', () => {
  test('脚注：引用与定义产出对应节点（GFM 自带）', () => {
    const roots = parseBlockRoots('正文[^1]。\n\n[^1]: 注释内容') as AnyNode[]
    expect(roots.map((r) => r.type)).toEqual(['paragraph', 'footnoteDefinition'])
    expect(roots[0]!.children!.some((c) => c.type === 'footnoteReference')).toBe(true)
  })

  test('脚注定义块映射为 paragraph kind（不降级 unknown）', () => {
    expect(kindFromMdast({ type: 'footnoteDefinition' })).toBe('paragraph')
  })

  test('==高亮== 产出 mark 节点', () => {
    const roots = parseBlockRoots('前文 ==高亮== 后文') as AnyNode[]
    expect(roots[0]!.children!.some((c) => c.type === 'mark')).toBe(true)
  })

  test('代码里的 == 不受影响', () => {
    const roots = parseBlockRoots('`a == b`') as AnyNode[]
    const p = roots[0]!
    expect(p.children!.some((c) => c.type === 'inlineCode')).toBe(true)
    expect(p.children!.some((c) => c.type === 'mark')).toBe(false)
  })

  test('未配对 == 保持字面文本', () => {
    const roots = parseBlockRoots('a == b') as AnyNode[]
    expect(roots[0]!.children!.some((c) => c.type === 'mark')).toBe(false)
  })
})

describe('details 折叠块合并', () => {
  const { parseBlocks } = require('../src/index.ts') as {
    parseBlocks: (text: string) => Array<{ id: string; kind: string; start: number; end: number; raw: string }>
  }

  test('空行分隔的 details 三段合并为一块', () => {
    const md = '<details>\n<summary>标题</summary>\n\n- 甲\n- 乙\n\n</details>\n\n后续段落'
    const blocks = parseBlocks(md)
    const merged = blocks.find((b) => b.kind === 'html' && b.raw.includes('<details>'))
    expect(merged).toBeDefined()
    expect(merged!.raw).toContain('</details>')
    expect(merged!.raw).toContain('- 甲')
    // 合并块与相邻块跨度连续（拼接恒等）
    const after = blocks[blocks.indexOf(merged!) + 1]!
    expect(after.start).toBe(merged!.end)
  })

  test('无闭合标签不合并', () => {
    const md = '<details>\n<summary>标题</summary>\n\n正文没有闭合'
    const blocks = parseBlocks(md)
    expect(blocks.some((b) => b.kind === 'html' && b.raw.includes('<details>'))).toBe(true)
    expect(blocks.filter((b) => b.raw.includes('<details>')).length).toBe(1)
  })

  test('编辑过的折叠正文在合并后还在，且仍算脏', () => {
    const { mergeDetailsBlocks } = require('../src/parse.ts') as typeof import('../src/parse.ts')
    const open = '<details>\n<summary>标题</summary>\n'
    const edited = '\n用户改过的正文。\n\n'
    const close = '</details>\n'
    const text = open + '\n原文。\n\n' + close
    const blocks = [
      { id: 'a', kind: 'html' as const, start: 0, end: open.length, raw: open, mdast: null, dirty: false },
      {
        id: 'b',
        kind: 'paragraph' as const,
        start: open.length,
        end: open.length + 8,
        raw: edited,
        mdast: null,
        dirty: true,
      },
      {
        id: 'c',
        kind: 'html' as const,
        start: text.length - close.length,
        end: text.length,
        raw: close,
        mdast: null,
        dirty: false,
      },
    ]
    const merged = mergeDetailsBlocks(blocks, text)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.raw).toContain('用户改过的正文')
    expect(merged[0]!.raw).not.toContain('原文')
    expect(merged[0]!.dirty).toBe(true)
  })

  test('正在编辑的折叠跨度保持拆开', () => {
    const { mergeDetailsBlocks } = require('../src/parse.ts') as typeof import('../src/parse.ts')
    const open = '<details>\n'
    const body = '正文\n\n'
    const close = '</details>'
    const text = open + '\n' + body + close
    const blocks = [
      { id: 'a', kind: 'html' as const, start: 0, end: open.length, raw: open, mdast: null, dirty: false },
      { id: 'b', kind: 'paragraph' as const, start: open.length, end: open.length + body.length, raw: body, mdast: null, dirty: true },
      { id: 'c', kind: 'html' as const, start: text.length - close.length, end: text.length, raw: close, mdast: null, dirty: false },
    ]
    const merged = mergeDetailsBlocks(blocks, text, { preserveBlock: (b) => b.id === 'b' })
    expect(merged.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1]!.raw).toBe(body)
  })

  test('紧凑写法（单块含闭合）不受影响', () => {
    const md = '<details>\n<summary>标题</summary>\n内容\n</details>'
    const blocks = parseBlocks(md)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.kind).toBe('html')
  })

  test('删除线只认双波浪：单波浪范围写法不误伤', () => {
    // 中文文档常见范围写法，两个单 ~ 不能配对成删除线（GitHub 的单波浪
    // 删除线是它的怪癖，我们不跟——误伤远多于收益）
    const blocks = parseBlocks('使用 1~6 个 `#` 对应 H1~H6。')
    expect(JSON.stringify(blocks)).not.toContain('"delete"')
    // 双波浪正常
    const struck = parseBlocks('这是~~删除~~文本')
    expect(JSON.stringify(struck)).toContain('"delete"')
  })
})
