// 代码高亮：换成 Prism 之后，重点仍是两件事——
//  1. 注入内容必须被转义（预览里唯一生成带标签 HTML 的地方）；
//  2. 别名归一，```typescript / ```js 这类不再「有标签没颜色」。

import { describe, expect, test } from 'bun:test'
import { highlightCode } from '../src/highlight.ts'

describe('代码高亮 · 安全', () => {
  test('HTML 注入被转义', () => {
    const html = highlightCode('<script>alert(1)</script>', 'html')
    // Prism 会把 `<script>` 拆成「标点 + 标签名 + 标点」着色，且文本里只转义 `<`/`&`
    //（`>` 在文本节点里本就无害）。不变的是：绝不存在能起一个标签的裸 `<`。
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;')
  })

  test('字符串里的引号与尖括号也转义', () => {
    const html = highlightCode(`const s = "<img src=x onerror=alert(1)>"`, 'ts')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('未知语言只转义、不猜着上色', () => {
    const html = highlightCode('<b>hi</b>', 'no-such-lang')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('token ')
  })
})

describe('代码高亮 · 别名归一', () => {
  test('ts 与 typescript 都上色（最常用的围栏名不能是白的）', () => {
    expect(highlightCode('const x = 1', 'ts')).toContain('token keyword')
    expect(highlightCode('const x = 1', 'typescript')).toContain('token keyword')
  })

  test('js / javascript / rs / golang / py / sh / yml 都能落到语法上', () => {
    for (const [lang, code] of [
      ['javascript', 'const x = 1'],
      ['rs', 'fn main() {}'],
      ['golang', 'func main() {}'],
      ['py', 'def f(): pass'],
      ['sh', 'if true; then echo hi; fi'],
      ['yml', 'key: true'],
    ] as const) {
      expect(highlightCode(code, lang)).toContain('token')
    }
  })

  test('language- 前缀与大小写都吃得下', () => {
    expect(highlightCode('const x = 1', 'language-TS')).toContain('token keyword')
  })
})

describe('代码高亮 · 各类语言', () => {
  test('注释 / 字符串 / 数字 / 关键词分别成 token', () => {
    const html = highlightCode('// 注释\nconst n = 42\nconst s = "hi"', 'ts')
    expect(html).toContain('token comment')
    expect(html).toContain('token number')
    expect(html).toContain('token string')
    expect(html).toContain('token keyword')
  })

  test('关键词整词着色，不误伤标识符', () => {
    const html = highlightCode('const constant = 1', 'ts')
    expect(html.match(/token keyword/g)?.length).toBe(1)
    expect(html).not.toContain('>constant</span>')
  })

  test('CSS 颜色值不会被当成注释', () => {
    expect(highlightCode('color: #5E6AD2;', 'css')).not.toContain('token comment')
  })

  test('半导体 / EDA 相关语言可用', () => {
    expect(highlightCode('module top; endmodule', 'verilog')).toContain('token keyword')
    expect(highlightCode('signal clk : std_logic;', 'vhdl')).toContain('token')
    expect(highlightCode('# eda script\nset x 1', 'tcl')).toContain('token comment')
    expect(highlightCode('__kernel void k() {}', 'opencl')).toContain('token keyword')
    expect(highlightCode('SELECT * FROM t', 'sql')).toContain('token keyword')
    expect(highlightCode('mov eax, 1', 'nasm')).toContain('token')
  })

  test('markdown 代码块正常高亮，中文正文不被破坏', () => {
    const html = highlightCode('中文 `代码` 段落', 'md')
    expect(html).toContain('中文')
    expect(html).toContain('代码')
  })
})
