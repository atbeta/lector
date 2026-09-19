// 数字列判据：表格里最常用也最容易被忽略的排版规则。
// 只测判据本身（渲染层的行为由 ui-verify 的表格断言兜住），
// 重点是别把"日期/编号/带文字的格子"误判成数字。
import { expect, test } from 'bun:test'
import { isNumericCell, looksLikeMath, renderBlockHtml, setMarkHighlight, setMathEnabled } from '../src/mdastHtml.ts'
import { setEmojiShortcodes } from '../src/emojiShortcode.ts'
import { parseBlocks } from '@lector/core'
import { setAssetResolver } from '../src/asset.ts'

function renderMd(md: string): string {
  return parseBlocks(md)
    .map((b) => renderBlockHtml(b.mdast, b.raw))
    .join('')
}

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
  // 引用 → 上标链接（不带方括号，GitHub 同款），指向定义锚点；id 供跳回
  expect(html).toContain('<sup class="footnote-ref" id="fnref-1"><a href="#fn-1">1</a></sup>')
  expect(html).toContain('<sup class="footnote-ref" id="fnref-two"><a href="#fn-two">two</a></sup>')
  // 定义 → 内容可见、带锚点、带序号、带 ↩ 跳回链接
  expect(html).toContain('id="fn-1"')
  expect(html).toContain('第一条脚注')
  expect(html).toContain('id="fn-two"')
  expect(html).toContain('第二条脚注')
  expect(html).toContain('<a class="footnote-backref" href="#fnref-1"')
})

test('==高亮==：默认渲染成 mark，关掉后原样显示两个等号', () => {
  const blocks = parseBlocks('前文 ==重点== 后文')
  const render = () => blocks.map((b) => renderBlockHtml(b.mdast, b.raw)).join('')
  expect(render()).toContain('<mark class="html-mark">重点</mark>')
  setMarkHighlight(false)
  try {
    const off = render()
    expect(off).toContain('==重点==')
    expect(off).not.toContain('<mark')
  } finally {
    setMarkHighlight(true)
  }
})

test('内联公式：默认渲染成 math，关掉后原样显示美元符号', () => {
  const blocks = parseBlocks('公式 $x^2$ 与价格 $5')
  const render = () => blocks.map((b) => renderBlockHtml(b.mdast, b.raw)).join('')
  expect(render()).toContain('math-inline')
  setMathEnabled(false)
  try {
    const off = render()
    expect(off).toContain('$x^2$')
    expect(off).not.toContain('math-inline')
  } finally {
    setMathEnabled(true)
  }
})

test('HTML <mark>：无属性放行，关掉后露出标签源码', () => {
  const md = '前文 <mark>重点</mark> 后文'
  expect(renderMd(md)).toContain('<mark class="html-mark">重点</mark>')
  setMarkHighlight(false)
  try {
    const off = renderMd(md)
    expect(off).toContain('&lt;mark&gt;重点&lt;/mark&gt;')
    expect(off).not.toContain('<mark class="html-mark">')
  } finally {
    setMarkHighlight(true)
  }
})

test('HTML <mark> 带属性：转义降级', () => {
  const html = renderMd('前文 <mark class="x">重点</mark> 后文')
  expect(html).not.toContain('<mark class="html-mark">')
  expect(html).toContain('&lt;mark')
})

test('HTML <mark> 里的加粗仍按 markdown 渲染', () => {
  expect(renderMd('x <mark>**粗**</mark> y')).toContain(
    '<mark class="html-mark"><strong>粗</strong></mark>',
  )
})

test('HTML <img>：行内与块级走 resolveImageSrc，带 data-html-img', () => {
  setAssetResolver((raw) => `resolved:${raw}`)
  try {
    const inline = renderMd('看 <img src="a.png" alt="图"> 完')
    expect(inline).toContain('<img src="resolved:a.png" alt="图" data-html-img="1" />')
    const block = renderMd('<img src="b.png" alt="块" width="120" height="80">')
    expect(block).toContain('src="resolved:b.png"')
    expect(block).toContain('width="120"')
    expect(block).toContain('height="80"')
    expect(block).toContain('data-html-img="1"')
    expect(block).not.toContain('<pre class="preform">')
    const inP = renderMd('<p><img src="c.png" alt="包"></p>')
    expect(inP).toContain('src="resolved:c.png"')
    expect(inP).toContain('data-html-img="1"')
  } finally {
    setAssetResolver(null)
  }
})

test('GitHub emoji 短代码：预览换成字符，行内代码不展开', () => {
  expect(renderMd('基础：:smile: :rocket:')).toContain('😄')
  expect(renderMd('基础：:smile: :rocket:')).toContain('🚀')
  expect(renderMd('状态：:white_check_mark: :x:')).toContain('✅')
  expect(renderMd('`:smile:`')).toContain(':smile:')
  expect(renderMd('`:smile:`')).not.toContain('😄')
  setEmojiShortcodes(false)
  try {
    const off = renderMd('基础：:smile:')
    expect(off).toContain(':smile:')
    expect(off).not.toContain('😄')
  } finally {
    setEmojiShortcodes(true)
  }
})

test('HTML <img> 危险属性/协议：转义降级', () => {
  for (const src of [
    '<img src="a.png" onerror="alert(1)">',
    '<img src="javascript:alert(1)">',
    '<img src="a.png" style="width:1px">',
    '<img src="a.png" srcset="x">',
    '<img src="file:///etc/passwd">',
  ]) {
    const html = renderMd(`x ${src} y`)
    expect(html, src).not.toMatch(/<img src=/)
    expect(html, src).toContain('&lt;img')
  }
})

test('表格：GFM 对齐语法生效，未标注的列才回退数字右对齐', () => {
  const md = [
    '| 名称 | 居中 | 右 | 左 | 数量 |',
    '| :--- | :---: | ---: | :--- | --- |',
    '| a | b | c | 1 | 10 |',
    '| e | f | g | 2 | 22 |',
  ].join('\n')
  const blocks = parseBlocks(md)
  const html = blocks.map((b) => renderBlockHtml(b.mdast, b.raw)).join('')
  // 表头跟着列对齐
  expect(html).toContain('<th data-align="left">名称</th>')
  expect(html).toContain('<th data-align="center">居中</th>')
  expect(html).toContain('<th data-align="right">右</th>')
  expect(html).toContain('<th data-align="left">左</th>')
  // 「数量」列没写冒号（align=null）：整列是数字 → 回退右对齐
  expect(html).toContain('<th data-align="right">数量</th>')
  // 单元格：显式对齐优先，显式左对齐的列即使内容是数字也不右对齐
  expect(html).toContain('<td data-align="center">b</td>')
  expect(html).toContain('<td data-align="right">c</td>')
  expect(html).toContain('<td data-align="left">1</td>')
  expect(html).toContain('<td data-align="right">22</td>')
})
