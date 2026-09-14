// 数字列判据：表格里最常用也最容易被忽略的排版规则。
// 只测判据本身（渲染层的行为由 ui-verify 的表格断言兜住），
// 重点是别把"日期/编号/带文字的格子"误判成数字。
import { expect, test } from 'bun:test'
import { isNumericCell } from '../src/mdastHtml.ts'

test('纯数字与常见单位算数字', () => {
  for (const s of ['1', '-3', '+2.5', '1,234', '1,234.56', '42%', '120ms', '3.6 GB', '18px', '5 次', '2 小时', '~150 MB', '≈3.6 GB', '±5%']) {
    expect(isNumericCell(s)).toBe(true)
  }
})

test('日期、混合文本、空串不算数字', () => {
  for (const s of ['', '  ', '2026-09-14', 'v0.12.1', '第 3 章', 'N/A', '约 5 分钟', '1 个文件', '中文']) {
    expect(isNumericCell(s)).toBe(false)
  }
})

test('过长内容不判数字', () => {
  expect(isNumericCell('1'.repeat(25))).toBe(false)
})
