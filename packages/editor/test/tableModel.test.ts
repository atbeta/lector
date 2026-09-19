// GFM 表格模型：网格弹窗的正确性全压在这份纯函数上。
// 用例移植自 notefast 的 tableModel.test.ts（行为契约一致）。

import { describe, expect, test } from 'bun:test'
import {
  addCol,
  addRow,
  deleteCol,
  deleteRow,
  moveRow,
  padTable,
  parseTable,
  serializeTable,
  setCell,
  tablesEqual,
} from '../src/tableModel.ts'

describe('parseTable / serializeTable', () => {
  test('基本 GFM 表格 roundtrip 单元格与对齐', () => {
    const lines = ['| 名称 | 数量 |', '| :--- | ---: |', '| 苹果 | 3 |']
    const table = parseTable(lines)
    expect(table.header).toEqual(['名称', '数量'])
    expect(table.aligns).toEqual(['left', 'right'])
    expect(table.body).toEqual([['苹果', '3']])
    const again = parseTable(serializeTable(table).split('\n'))
    expect(again.header).toEqual(table.header)
    expect(again.aligns).toEqual(table.aligns)
    expect(again.body).toEqual(table.body)
  })

  test('无冒号分隔行解析为 none 对齐', () => {
    const table = parseTable(['| a | b |', '| --- | --- |', '| 1 | 2 |'])
    expect(table.aligns).toEqual(['none', 'none'])
  })

  test('单元格内管道符 \\| 解析为字面 |，序列化再转义', () => {
    const table = parseTable(['| a \\| b | c |', '| --- | --- |', '| x | y |'])
    expect(table.header).toEqual(['a | b', 'c'])
    const md = serializeTable(table)
    expect(md).toContain('a \\| b')
    expect(parseTable(md.split('\n')).header).toEqual(['a | b', 'c'])
  })

  test('代码 span 里的管道 `` `|` `` 不增列', () => {
    const table = parseTable([
      '| 字符 | 转义写法 | 效果 |',
      '| --- | --- | --- |',
      '| `|` | `\\|` | \\|不是表格分隔 |',
    ])
    expect(table.body[0]).toEqual(['`|`', '`|`', '|不是表格分隔'])
  })

  test('类型联合 number \\| string 保持单格四列表', () => {
    const table = parseTable([
      '| prop | 类型 | 默认 | 说明 |',
      '| --- | --- | --- | --- |',
      '| `minSize` | `number \\| string` | `0` | 最小尺寸 |',
    ])
    expect(table.header).toHaveLength(4)
    expect(table.body[0]).toEqual(['`minSize`', '`number | string`', '`0`', '最小尺寸'])
  })

  test('参差行列按表头列数补齐空单元格', () => {
    const table = padTable(parseTable(['| a | b | c |', '|---|---|---|', '| 1 | 2 |']))
    expect(table.body[0]).toEqual(['1', '2', ''])
  })
})

describe('tablesEqual', () => {
  test('仅空白差异视为相等', () => {
    const a = parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])
    const b = parseTable(['|  a  | b |', '| --- | --- |', '| 1 | 2 |'])
    expect(tablesEqual(a, b)).toBe(true)
  })

  test('改单元格后不相等', () => {
    const a = parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])
    const b = setCell(a, 0, 0, '9')
    expect(tablesEqual(a, b)).toBe(false)
  })
})

describe('grid mutations', () => {
  const base = () => parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])

  test('setCell 改表头（row = -1）与表体', () => {
    let t = setCell(base(), -1, 0, 'A')
    t = setCell(t, 0, 1, 'X')
    expect(t.header[0]).toBe('A')
    expect(t.body[0]?.[1]).toBe('X')
  })

  test('addRow 默认追加空行', () => {
    const t = addRow(base())
    expect(t.body).toHaveLength(2)
    expect(t.body[1]).toEqual(['', ''])
  })

  test('addCol 默认追加空列并保留对齐长度', () => {
    const t = addCol(base())
    expect(t.header).toEqual(['a', 'b', ''])
    expect(t.aligns).toHaveLength(3)
    expect(t.body[0]).toEqual(['1', '2', ''])
  })

  test('deleteRow 可删到 0 行', () => {
    const t = deleteRow(base(), 0)
    expect(t.body).toEqual([])
  })

  test('deleteCol 拒绝删到 0 列', () => {
    let t = deleteCol(base(), 1)
    expect(t.header).toEqual(['a'])
    t = deleteCol(t, 0)
    expect(t.header).toEqual(['a'])
  })

  test('删行加行后序列化仍是合法 GFM', () => {
    let t = addRow(base())
    t = deleteRow(t, 0)
    t = addCol(t)
    const md = serializeTable(t)
    const lines = md.split('\n')
    expect(lines[1]).toBe('| --- | --- | --- |')
    expect(parseTable(lines).body).toEqual([['', '', '']])
  })

  test('moveRow 下移：目标行与中间行顺延', () => {
    const t = parseTable(['| a |', '|---|', '| 1 |', '| 2 |', '| 3 |'])
    const moved = moveRow(t, 0, 2)
    expect(moved.body.map((r) => r[0])).toEqual(['2', '3', '1'])
  })

  test('moveRow 上移对称', () => {
    const t = parseTable(['| a |', '|---|', '| 1 |', '| 2 |', '| 3 |'])
    const moved = moveRow(t, 2, 0)
    expect(moved.body.map((r) => r[0])).toEqual(['3', '1', '2'])
  })

  test('moveRow 越界 / 原地返回等价表', () => {
    const t = parseTable(['| a |', '|---|', '| 1 |', '| 2 |'])
    expect(moveRow(t, 0, 5).body).toEqual(t.body)
    expect(moveRow(t, -1, 0).body).toEqual(t.body)
    expect(moveRow(t, 1, 1).body).toEqual(t.body)
  })

  test('moveRow 后序列化仍是合法 GFM（roundtrip）', () => {
    const t = parseTable(['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'])
    const md = serializeTable(moveRow(t, 1, 0))
    expect(parseTable(md.split('\n')).body).toEqual([
      ['3', '4'],
      ['1', '2'],
    ])
  })
})
