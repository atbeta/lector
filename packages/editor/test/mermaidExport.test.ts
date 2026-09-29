import { describe, expect, test } from 'bun:test'
import {
  MAX_EXPORT_EDGE,
  exportPixelSize,
  prepareExportSvg,
  readSvgSize,
  stripForeignObjects,
  svgDataUrl,
  svgHasForeignObject,
} from '../src/mermaidExport.ts'
import { forceTextLabels, mermaidExportFontStack } from '../src/mermaid.ts'

const sample =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 400px;" viewBox="0 0 400 120"><text>开始</text></svg>'

/** journey 那类图的导出形态：foreignObject 旁边挂着 mermaid 自带的 <text> 回退。 */
const journeyLabel =
  '<switch><foreignObject x="150" y="50" width="350" height="50">' +
  '<div class="journey-section section-type-0" xmlns="http://www.w3.org/1999/xhtml">' +
  '<div class="label">第一阶段</div></div></foreignObject>' +
  '<text x="325" y="75" class="journey-section section-type-0">第一阶段</text></switch>'

describe('Mermaid 导出尺寸', () => {
  test('viewBox 是整张图的尺寸，百分比宽度不算', () => {
    expect(readSvgSize(sample)).toEqual({ width: 400, height: 120 })
    expect(readSvgSize('<svg width="100%" height="40"></svg>')).toBeNull()
    expect(readSvgSize('<svg width="80" height="40"></svg>')).toEqual({ width: 80, height: 40 })
  })

  test('2 倍出图，长边超过上限就整图缩小', () => {
    expect(exportPixelSize(100, 50)).toEqual({ width: 200, height: 100 })
    const fitted = exportPixelSize(5000, 1000)
    expect(Math.max(fitted.width, fitted.height)).toBe(MAX_EXPORT_EDGE)
    expect(fitted.width / fitted.height).toBeCloseTo(5, 1)
  })
})

describe('Mermaid 导出 SVG', () => {
  test('写成像素宽高，并带上中文字体', () => {
    const out = prepareExportSvg(sample)
    expect(out).toContain('width="400"')
    expect(out).toContain('height="120"')
    expect(out).not.toContain('max-width')
    expect(out).toContain('PingFang SC')
    expect(out).toContain('开始')
  })

  test('HTML 标签的图不能栅格化', () => {
    expect(svgHasForeignObject('<svg><foreignObject><div>字</div></foreignObject></svg>')).toBe(true)
    expect(svgHasForeignObject(sample)).toBe(false)
  })

  test('摘掉 foreignObject 后落到 <switch> 里的 <text> 回退', () => {
    const out = stripForeignObjects(`<svg>${journeyLabel}</svg>`)
    expect(svgHasForeignObject(out)).toBe(false)
    expect(out).toContain('<switch>')
    expect(out).toContain('<text x="325" y="75"')
    expect(out).toContain('第一阶段')
  })

  test('自闭合的 foreignObject 也摘掉', () => {
    expect(stripForeignObjects('<svg><foreignObject x="1"/><text>字</text></svg>')).toBe(
      '<svg><text>字</text></svg>',
    )
  })

  test('导出准备阶段顺带摘掉 foreignObject', () => {
    const out = prepareExportSvg(`<svg width="100%" viewBox="0 0 400 120">${journeyLabel}</svg>`)
    expect(svgHasForeignObject(out)).toBe(false)
    expect(out).toContain('width="400"')
    expect(out).toContain('PingFang SC')
  })

  test('栅格化的 SVG 走 data URL（壳 CSP 不放行 blob:）', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>')
    const prefix = 'data:image/svg+xml;base64,'
    expect(url.startsWith(prefix)).toBe(true)
    expect(Buffer.from(url.slice(prefix.length), 'base64').toString('utf8')).toContain('中文')
  })

  test('导出配置关掉 htmlLabels，字体栈补中文且不重复', () => {
    expect(forceTextLabels({ htmlLabels: true, theme: 'neutral' })).toEqual({
      htmlLabels: false,
      theme: 'neutral',
    })
    const stack = mermaidExportFontStack('Inter, sans-serif')
    expect(stack).toContain('PingFang SC')
    expect(mermaidExportFontStack(stack)).toBe(stack)
  })
})
