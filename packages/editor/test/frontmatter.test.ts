import { describe, expect, test } from 'bun:test'
import { renderBlockHtml } from '../src/mdastHtml.ts'

describe('frontmatter 预览', () => {
  const yaml = (value: string) => ({ type: 'yaml', value })

  test('顶层 key: value 渲染成属性卡', () => {
    const html = renderBlockHtml(yaml('title: 测试\n作者: 张三'), 'x')
    expect(html).toContain('frontmatter')
    expect(html).toContain('fm-key')
    expect(html).toContain('测试')
    expect(html).toContain('张三')
  })

  test('缩进列表渲染成标签 chips（真实 frontmatter 最常见的形状）', () => {
    const html = renderBlockHtml(yaml('title: x\ntags:\n  - 甲\n  - 乙'), 'x')
    expect(html).toContain('frontmatter')
    expect(html).toContain('fm-tag')
    expect(html).toContain('甲')
    expect(html).toContain('乙')
  })

  test('嵌套对象退回源码（表格表达不了缩进层次）', () => {
    const html = renderBlockHtml(yaml('title: x\nauthor:\n  name: y'), 'x')
    expect(html).toContain('preform')
    expect(html).not.toContain('frontmatter')
  })

  test('空值显示占位符', () => {
    const html = renderBlockHtml(yaml('draft:'), 'x')
    expect(html).toContain('fm-empty')
  })

  test('值里的危险协议不生成链接', () => {
    const html = renderBlockHtml(yaml('src: "[x](javascript:alert(1))"'), 'x')
    expect(html).not.toContain('javascript:')
  })

  test('内容转义，不执行 HTML', () => {
    const html = renderBlockHtml(yaml('title: <img src=x onerror=alert(1)>'), 'x')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
