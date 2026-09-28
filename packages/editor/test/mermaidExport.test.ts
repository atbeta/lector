import { describe, expect, test } from 'bun:test'
import {
  MAX_EXPORT_EDGE,
  exportPixelSize,
  prepareExportSvg,
  readSvgSize,
  svgHasForeignObject,
} from '../src/mermaidExport.ts'
import { forceTextLabels, mermaidExportFontStack } from '../src/mermaid.ts'

const sample =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 400px;" viewBox="0 0 400 120"><text>开始</text></svg>'

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
