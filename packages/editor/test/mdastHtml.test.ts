// 数字列判据：表格里最常用也最容易被忽略的排版规则。
// 只测判据本身（渲染层的行为由 ui-verify 的表格断言兜住），
// 重点是别把"日期/编号/带文字的格子"误判成数字。
import { expect, test } from 'bun:test'
import { isNumericCell, looksLikeMath, renderBlockHtml } from '../src/mdastHtml.ts'
import { parseBlocks } from '@lector/core'

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

test('looksLikeMath 把被 micromark 误判的货币/区间当普通文本', () => {
  // 这些本不是公式，micromark-extension-math 却把它们解成 inlineMath
  //（实测 value：`5 - `、`5-`、`100 到 `）。守卫应识别为「非公式」。
  for (const s of ['5 - ', '5-', '100 到 ', '10,000', '0.5', '2:30', '大约 3 次']) {
    expect(looksLikeMath(s), s).toBe(false)
  }
})

test('looksLikeMath 把真公式判成数学', () => {
  for (const s of ['x^2', 'E=mc^2', '\\frac{1}{2}', 'a_b', '\\sum_{i=1}^n i', 'x^{2}', 'f(x) = 2x']) {
    expect(looksLikeMath(s), s).toBe(true)
  }
})

test('脚注：引用与定义都能在预览里看到（不再隐身）', () => {
  const md = '正文引用[^1]和[^two]。\n\n[^1]: 第一条脚注。\n\n[^two]: 第二条脚注。\n'
  const blocks = parseBlocks(md)
  const html = blocks.map((b) => renderBlockHtml(b.mdast, b.raw)).join('')
  // 引用 → 上标链接，指向定义锚点；id="fnref-…" 供定义侧跳回
  expect(html).toContain('<sup class="footnote-ref" id="fnref-1"><a href="#fn-1">[1]</a></sup>')
  expect(html).toContain('<sup class="footnote-ref" id="fnref-two"><a href="#fn-two">[two]</a></sup>')
  // 定义 → 内容可见、带锚点、带序号、带 ↩ 跳回链接
  expect(html).toContain('id="fn-1"')
  expect(html).toContain('第一条脚注')
  expect(html).toContain('id="fn-two"')
  expect(html).toContain('第二条脚注')
  expect(html).toContain('<a class="footnote-backref" href="#fnref-1"')
})
