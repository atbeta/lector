import { describe, expect, test } from 'bun:test'
import { parseBlocks, parseOne, splitTableRow } from '../src/index.ts'

const ESCAPE_TABLE = [
  '| 字符 | 转义写法 | 效果 |',
  '| --- | --- | --- |',
  '| `*` | `\\*` | \\*不被强调\\* |',
  '| `_` | `\\_` | \\_不被强调\\_ |',
  '| `` ` `` | `` \\` `` | \\`不被代码\\` |',
  '| `#` | `\\#` | \\#不是标题 |',
  '| `[` | `\\[` | \\[不是链接 |',
  '| `|` | `\\|` | \\|不是表格分隔 |',
  '| `<` | `\\<` | \\<不是 HTML |',
].join('\n')

type Inline = { type: string; value?: string }
type Cell = { children: Inline[] }
type Row = { children: Cell[] }
type Table = { type: string; children: Row[] }

function cellText(cell: Cell): string {
  return (cell.children ?? []).map((n) => n.value ?? '').join('')
}

describe('splitTableRow：代码 span 里的管道不是列界', () => {
  test('`` `|` `` / `` `\\|` `` / \\|效果 仍是三列', () => {
    expect(splitTableRow('| `|` | `\\|` | \\|不是表格分隔 |', { unescapePipes: false })).toEqual([
      '`|`',
      '`\\|`',
      '\\|不是表格分隔',
    ])
  })

  test('编辑器要的 unescape：代码 span 内 \\| 还原成 |，但不增列', () => {
    expect(splitTableRow('| `number \\| string` | x |')).toEqual(['`number | string`', 'x'])
  })
})

describe('表格 mdast：管道在代码 span 里不裂列', () => {
  test('转义字符表「不是表格分隔」行是三格，效果以 | 开头', () => {
    const blocks = parseBlocks(ESCAPE_TABLE)
    const table = blocks.find((b) => b.kind === 'table')!.mdast as Table
    expect(table.children.map((r) => r.children.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 3])
    const pipeRow = table.children[6]!
    const [ch, esc, effect] = pipeRow.children
    expect(ch!.children[0]).toMatchObject({ type: 'inlineCode', value: '|' })
    expect(esc!.children[0]).toMatchObject({ type: 'inlineCode', value: '\\|' })
    expect(cellText(effect!)).toBe('|不是表格分隔')
  })

  test('parseOne 单表同样修好', () => {
    const table = parseOne(ESCAPE_TABLE) as Table
    expect(table.children[6]!.children).toHaveLength(3)
  })
})
