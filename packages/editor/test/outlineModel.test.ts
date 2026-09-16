import { describe, expect, test } from 'bun:test'
import { parseBlocks, type BlockView } from '@lector/core'
import {
  buildOutlineTree,
  headingDepth,
  headingText,
  outlineSignature,
  type OutlineHeading,
} from '../src/outlineModel.ts'

describe('headingText', () => {
  test('嵌套 text / inlineCode 拼出纯文本', () => {
    const mdast = {
      type: 'heading',
      depth: 2,
      children: [
        { type: 'text', value: '读' },
        { type: 'strong', children: [{ type: 'text', value: '写' }] },
        { type: 'inlineCode', value: 'x = 1' },
      ],
    }
    expect(headingText(mdast)).toBe('读写x = 1')
  })

  test('null / 非对象节点 → 空串', () => {
    expect(headingText(null)).toBe('')
    expect(headingText(42)).toBe('')
    expect(headingText({ type: 'thematicBreak' })).toBe('')
  })

  test('数组根（多 mdast 节点）用空格连接', () => {
    const mdast = [
      { type: 'text', value: '甲' },
      { type: 'text', value: '乙' },
    ]
    expect(headingText(mdast)).toBe('甲 乙')
  })
})

describe('headingDepth', () => {
  const blocks = parseBlocks('# 一级\n\n## 二级\n\n正文段落\n')

  test('非 heading 块 → null', () => {
    const para = blocks.find((b) => b.kind === 'paragraph')!
    expect(headingDepth(para)).toBeNull()
  })

  test('heading 缺 depth → 1', () => {
    const h = blocks.find((b) => b.kind === 'heading')!
    const noDepth: BlockView = { ...h, mdast: { type: 'heading', children: [] } }
    expect(headingDepth(noDepth)).toBe(1)
  })

  test('mdast 是数组时取第一个节点的 depth', () => {
    const h2 = blocks.find((b) => b.kind === 'heading' && b.raw.includes('二级'))!
    const asArray: BlockView = { ...h2, mdast: [h2.mdast] }
    expect(headingDepth(asArray)).toBe(2)
  })
})

describe('buildOutlineTree', () => {
  test('空输入 → 空数组', () => {
    expect(buildOutlineTree([])).toEqual([])
  })

  test('depth 回退正确弹出祖先栈', () => {
    const input: OutlineHeading[] = [
      { id: 'a', depth: 1, text: 'A' },
      { id: 'b', depth: 3, text: 'B' },
      { id: 'c', depth: 2, text: 'C' },
      { id: 'd', depth: 1, text: 'D' },
    ]
    const snapshot = input.map((h) => ({ ...h }))
    const roots = buildOutlineTree(input)
    expect(roots.map((n) => n.id)).toEqual(['a', 'd'])
    expect(roots[0]!.children.map((n) => n.id)).toEqual(['b', 'c'])
    expect(roots[1]!.children).toEqual([])
    expect(input).toEqual(snapshot)
    for (const h of input) expect('children' in h).toBe(false)
  })

  test('同名标题不同 id 两条都保留', () => {
    const roots = buildOutlineTree([
      { id: 'x1', depth: 1, text: '同名' },
      { id: 'x2', depth: 1, text: '同名' },
    ])
    expect(roots.length).toBe(2)
    expect(roots.map((n) => n.id)).toEqual(['x1', 'x2'])
  })
})

describe('outlineSignature', () => {
  test('只改正文段落，签名不变', () => {
    const a = parseBlocks('# 标题\n\n第一段\n')
    const b = parseBlocks('# 标题\n\n第一段被改写了\n')
    expect(outlineSignature(a)).toBe(outlineSignature(b))
  })

  test('标题 id / 级别 / 文字任一变化，签名不同', () => {
    const base = parseBlocks('# 标题\n\n正文\n')
    const heading = base.find((b) => b.kind === 'heading')!
    const sig = outlineSignature(base)
    const changed = (replacement: BlockView) => base.map((b) => b === heading ? replacement : b)
    expect(outlineSignature(changed({ ...heading, id: 'different-id' }))).not.toBe(sig)
    expect(outlineSignature(changed({ ...heading, mdast: { type: 'heading', depth: 2, children: [{ type: 'text', value: '标题' }] } }))).not.toBe(sig)
    expect(outlineSignature(changed({ ...heading, mdast: { type: 'heading', depth: 1, children: [{ type: 'text', value: '换名' }] } }))).not.toBe(sig)
  })
})
