// 代码高亮的安全与边界。
//
// 高亮是唯一一处「预览里生成 HTML 带标签」的地方，所以这里的第一要务不是好看，
// 而是：注入内容必须被转义，且整词边界不能误伤标识符。

import { describe, expect, test } from 'bun:test'
import { highlightCode } from '../src/highlight.ts'

describe('代码高亮', () => {
  test('HTML 注入被转义', () => {
    const html = highlightCode('<script>alert(1)</script>', 'html')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('字符串里的引号与尖括号也转义', () => {
    const html = highlightCode(`const s = "<img src=x onerror=alert(1)>"`, 'ts')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('关键词整词着色，不误伤标识符', () => {
    // const 是关键词，constant / Constructor 不是
    const html = highlightCode('const constant = Constructor', 'ts')
    expect(html.match(/tok-keyword/g)?.length).toBe(1)
    // 两个标识符必须落在标签之外（原样文本）
    expect(html).toContain('constant')
    expect(html).toContain('Constructor')
    expect(html).not.toContain('>constant</span>')
    expect(html).not.toContain('>Constructor</span>')
  })

  test('注释、字符串、数字分别着色', () => {
    const html = highlightCode('// 注释\nconst n = 42\nconst s = "hi"', 'ts')
    expect(html).toContain('tok-comment')
    expect(html).toContain('tok-number')
    expect(html).toContain('tok-string')
  })

  test('CSS 颜色值不会被当成注释', () => {
    // #5E6AD2 是颜色不是注释，不该整行变注释
    const html = highlightCode('color: #5E6AD2;', 'css')
    expect(html).not.toContain('tok-comment')
  })

  test('未知语言只转义、不猜着上色', () => {
    const html = highlightCode('<?php echo "<b>hi</b>"; ?>', 'php-unknown')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
    // 不认识的语言不该冒出任何 token 标签
    expect(html).not.toContain('tok-')
  })

  test('中文正文里的反引号不会被当模板字符串染色', () => {
    // markdown 之类的语言没有关键字表，必须整体原样
    const src = '中文段落里的 `代码` 与符号 —— 都该原样出来'
    expect(highlightCode(src, 'md')).toBe(src)
  })

  test('只有 JS/TS 认反引号模板串', () => {
    expect(highlightCode('const s = `hi`', 'ts')).toContain('tok-string')
    expect(highlightCode('echo `date`', 'sh')).not.toContain('tok-string')
  })

  test('块注释整体着色', () => {
    const html = highlightCode('/* 多行\n   注释 */\nconst a = 1', 'ts')
    expect(html).toContain('tok-comment')
    expect(html.match(/tok-comment/g)?.length).toBe(1)
  })
})
