// GFM 管道表格的解析 / 序列化 / 网格变更。
// 切列走 @lector/core 的 splitTableRow：代码 span 里的 `|` 不是列界。
// 单元格内其余 `|` 以 `\|` 转义（GFM 惯例）；对齐保留 none / left / center / right。

import { splitTableRow } from '@lector/core'

export type TableAlign = 'none' | 'left' | 'center' | 'right'

export interface ParsedTable {
  header: string[]
  aligns: TableAlign[]
  body: string[][]
}

/** 按 | 切列；`\|` 与代码 span 里的管道视为字面量，不增列 */
export function splitRow(line: string): string[] {
  return splitTableRow(line)
}

function parseAlign(cell: string): TableAlign {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

/** lines = 表格块的原文行（表头 / 分隔行 / 数据行）。 */
export function parseTable(lines: string[]): ParsedTable {
  const header = splitRow(lines[0] ?? '')
  const aligns = splitRow(lines[1] ?? '').map(parseAlign)
  return { header, aligns, body: lines.slice(2).map(splitRow) }
}

function colCount(table: ParsedTable): number {
  return Math.max(1, table.header.length, table.aligns.length, ...table.body.map((r) => r.length))
}

/** 参差行按列数补齐空单元格（手写的 md 经常列数不齐）。 */
export function padTable(table: ParsedTable): ParsedTable {
  const n = colCount(table)
  const pad = (row: string[]): string[] => Array.from({ length: n }, (_, i) => row[i] ?? '')
  return {
    header: pad(table.header),
    aligns: Array.from({ length: n }, (_, i) => table.aligns[i] ?? 'none'),
    body: table.body.map(pad),
  }
}

export function tablesEqual(a: ParsedTable, b: ParsedTable): boolean {
  return JSON.stringify(padTable(a)) === JSON.stringify(padTable(b))
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function alignDelim(align: TableAlign): string {
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  if (align === 'center') return ':---:'
  return '---'
}

function serializeRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

export function serializeTable(table: ParsedTable): string {
  const t = padTable(table)
  const delim = `| ${t.aligns.map(alignDelim).join(' | ')} |`
  return [serializeRow(t.header), delim, ...t.body.map(serializeRow)].join('\n')
}

/** row = -1 改表头 */
export function setCell(table: ParsedTable, row: number, col: number, value: string): ParsedTable {
  const t = padTable(table)
  if (row < 0) {
    const header = [...t.header]
    if (col < 0 || col >= header.length) return t
    header[col] = value
    return { ...t, header }
  }
  const body = t.body.map((r, i) => (i === row ? r.map((c, j) => (j === col ? value : c)) : r))
  return { ...t, body }
}

export function addRow(table: ParsedTable, at?: number): ParsedTable {
  const t = padTable(table)
  const empty = t.header.map(() => '')
  const idx = at ?? t.body.length
  const body = [...t.body]
  body.splice(idx, 0, empty)
  return { ...t, body }
}

export function addCol(table: ParsedTable, at?: number): ParsedTable {
  const t = padTable(table)
  const idx = at ?? t.header.length
  const insert = <T>(arr: T[], v: T): T[] => {
    const next = [...arr]
    next.splice(idx, 0, v)
    return next
  }
  return {
    header: insert(t.header, ''),
    aligns: insert(t.aligns, 'none'),
    body: t.body.map((r) => insert(r, '')),
  }
}

export function deleteRow(table: ParsedTable, row: number): ParsedTable {
  const t = padTable(table)
  if (row < 0 || row >= t.body.length) return t
  return { ...t, body: t.body.filter((_, i) => i !== row) }
}

/** 把第 from 行移到 to 行（其余行顺延）；越界或原地返回原表。 */
export function moveRow(table: ParsedTable, from: number, to: number): ParsedTable {
  const t = padTable(table)
  if (from < 0 || from >= t.body.length || to < 0 || to >= t.body.length || from === to) return t
  const body = [...t.body]
  const [row] = body.splice(from, 1)
  body.splice(to, 0, row!)
  return { ...t, body }
}

/** 至少保留 1 列 */
export function deleteCol(table: ParsedTable, col: number): ParsedTable {
  const t = padTable(table)
  if (t.header.length <= 1) return t
  if (col < 0 || col >= t.header.length) return t
  const drop = <T>(arr: T[]): T[] => arr.filter((_, i) => i !== col)
  return {
    header: drop(t.header),
    aligns: drop(t.aligns),
    body: t.body.map(drop),
  }
}
