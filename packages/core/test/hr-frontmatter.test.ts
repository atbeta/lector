// 分隔线（---）不能被当成 YAML 头。
//
// frontmatter 只在整篇文档的开头成立，但 micromark 的 frontmatter 扩展只看
// 「被解析文本的第一行」：拿它去解析一段片段时，片段开头的 --- 会被当成
// YAML 头，把后面整段（含 ## 小节标题）吞成 yaml 块——分隔线后面的小节
// 就不渲染了。分块的切点常常正好落在 --- 行上（上一行是空行、--- 不是列表
// 项起始，都是合法切点），所以这个错法随切点位置时有时无。
import { describe, expect, test } from 'bun:test'
import { parseBlocks } from '../src/index.ts'
import { parseBlocksWhole } from '../src/chunk.ts'
import type { BlockView } from '../src/types.ts'

function kinds(blocks: BlockView[]): string[] {
  return blocks.filter((b) => b.kind !== 'unknown').map((b) => b.kind)
}

function signature(blocks: BlockView[]): string {
  return blocks.map((b) => `${b.start}:${b.end}:${b.kind}`).join('|')
}

/** 分块结果与整篇 oracle 完全一致。 */
function expectEquivalent(text: string, target: number): void {
  expect(signature(parseBlocks(text, { target }))).toBe(signature(parseBlocksWhole(text)))
}

/**
 * 造一份「切点正好落在 --- 行首」的文档：前面垫一段文本，把 --- 的偏移推到
 * target 上，切点就会切在分隔线前面。
 */
function docWithSplitOnHr(target: number, tail: string): string {
  const pad = 'x'.repeat(target - 2) + '\n\n'
  expect(pad.length).toBe(target)
  return pad + tail
}

const HR_TAIL = '---\n\n## 5. Workflow 开发框架（EDH Workflow SDK）\n\n正文一段。\n\n---\n\n## 6. 下一节\n\n再一段。\n'

describe('分隔线不是 YAML 头', () => {
  test('切点落在 --- 上时，--- 仍是分隔线', () => {
    const text = docWithSplitOnHr(200, HR_TAIL)
    const blocks = parseBlocks(text, { target: 200 })
    expect(blocks.some((b) => b.kind === 'yaml')).toBe(false)
    expect(kinds(blocks)).toContain('thematicBreak')
    // 分隔线后面的小节标题照常是标题
    const heading = blocks.find((b) => b.kind === 'heading' && b.raw.startsWith('## 5.'))
    expect(heading).toBeDefined()
    expectEquivalent(text, 200)
  })

  test('分隔线后面的小节标题照常渲染', () => {
    const text = [
      '### 4.12 集群与高可用',
      '',
      '- 控制面/调度/准入**无状态**，状态仅在 `edh_workflow` 与 Kafka offset',
      '- 多实例共享 Kafka 消费组分摊负载；内存队列随实例分布',
      '',
      '---',
      '',
      '## 5. Workflow 开发框架（EDH Workflow SDK）',
      '',
      '正文一段。',
      '',
    ].join('\n')
    const blocks = parseBlocks(text)
    expect(kinds(blocks)).toEqual(['heading', 'list', 'thematicBreak', 'heading', 'paragraph'])
    expectEquivalent(text, 256)
  })

  test('缩进附录里的分隔线不是 YAML 头', () => {
    // 整段附录被贴成四空格缩进：拆块后它开头的 --- 仍是分隔线
    const text = [
      '    ---',
      '',
      '    ## 5. Workflow 开发框架（EDH Workflow SDK）',
      '',
      '    正文一段。',
      '',
      '    ---',
      '',
      '    ## 6. 下一节',
      '',
    ].join('\n')
    const blocks = parseBlocks(text)
    expect(blocks.some((b) => b.kind === 'yaml')).toBe(false)
    expect(kinds(blocks)).toContain('thematicBreak')
    expect(kinds(blocks)).toContain('heading')
    expectEquivalent(text, 256)
  })

  test('整篇开头的 frontmatter 仍然是 YAML 头', () => {
    const text = '---\ntitle: 标题\ntags:\n  - 甲\n---\n\n正文一段。\n\n---\n\n## 5. 下一节\n'
    const blocks = parseBlocks(text)
    expect(blocks[0]!.kind).toBe('yaml')
    // frontmatter 之后的 --- 仍是分隔线
    expect(kinds(blocks)).toEqual(['yaml', 'paragraph', 'thematicBreak', 'heading'])
    expectEquivalent(text, 256)
  })

  test('大文档里不出现 yaml 块（16KB 分片边界到处跑）', () => {
    const section = (i: number): string =>
      [
        `### 4.${i} 集群与高可用`,
        '',
        '- 控制面/调度/准入**无状态**，状态仅在 `edh_workflow` 与 Kafka offset',
        '- 多实例共享 Kafka 消费组分摊负载；内存队列随实例分布',
        '',
        '---',
        '',
        `## 5.${i} Workflow 开发框架（EDH Workflow SDK）`,
        '',
        '正文一段。',
        '',
      ].join('\n')
    let text = ''
    for (let i = 0; i < 150; i++) text += section(i) + '\n'
    expect(text.length).toBeGreaterThan(16 * 1024)
    const blocks = parseBlocks(text)
    expect(blocks.some((b) => b.kind === 'yaml')).toBe(false)
    expectEquivalent(text, 16 * 1024)
  })
})
