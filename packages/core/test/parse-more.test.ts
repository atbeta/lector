import { describe, expect, test } from 'bun:test'
import {
  isFocusableBlock,
  parseBlockRoots,
  parseBlocks,
  parseOne,
  serialize,
} from '../src/index.ts'
import { kindFromMdast } from '../src/parse.ts'

describe('空文档', () => {
  test('给一块可聚焦空段落，序列化为空串', () => {
    const blocks = parseBlocks('')
    expect(blocks).toHaveLength(1)
    expect(isFocusableBlock(blocks[0]!)).toBe(true)
    expect(blocks[0]!.kind).toBe('paragraph')
    expect(serialize(blocks)).toBe('')
  })
})

describe('parseBlockRoots', () => {
  test('一段改成两段时返回全部根节点', () => {
    const roots = parseBlockRoots('一段。\n\n两段。\n')
    expect(roots.length).toBe(2)
    expect(kindFromMdast(roots[0])).toBe('paragraph')
    expect(kindFromMdast(roots[1])).toBe('paragraph')
  })

  test('parseOne 仍返回首个根（兼容）', () => {
    expect(kindFromMdast(parseOne('# 标题\n\n正文\n'))).toBe('heading')
  })

  test('标题源码的 kind 随 mdast 走', () => {
    expect(kindFromMdast(parseOne('# 标题'))).toBe('heading')
    expect(kindFromMdast(parseOne('普通段'))).toBe('paragraph')
  })
})
