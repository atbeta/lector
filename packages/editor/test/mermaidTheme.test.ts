import { describe, expect, test } from 'bun:test'
import { mermaidBuiltinTheme } from '../src/mermaid.ts'

describe('mermaid 主题覆盖', () => {
  test('暗色走 base 主题，并打开 darkMode', () => {
    const theme = mermaidBuiltinTheme('dark')
    expect(theme.theme).toBe('base')
    expect(theme.themeVariables.darkMode).toBe(true)
  })

  test('浅色不打开 darkMode', () => {
    expect(mermaidBuiltinTheme('light').themeVariables.darkMode).toBe(false)
  })

  test('暗色的线、箭头、正文、饼图描边和序号都不是黑', () => {
    const v = mermaidBuiltinTheme('dark').themeVariables
    for (const key of [
      'lineColor',
      'arrowheadColor',
      'defaultLinkColor',
      'textColor',
      'nodeTextColor',
      'signalColor',
      'pieStrokeColor',
      'pieOuterStrokeColor',
      'scaleLabelColor',
      'sequenceNumberColor',
      'taskTextColor',
    ]) {
      const color = String(v[key]).toLowerCase()
      expect(color).not.toBe('black')
      expect(color).not.toBe('#000')
      expect(color).not.toBe('#000000')
    }
  })

  test('暗色正文和连线来自同一套墨色与灰', () => {
    const v = mermaidBuiltinTheme('dark').themeVariables
    expect(v.textColor).toBe(v.nodeTextColor)
    expect(v.lineColor).toBe(v.arrowheadColor)
    expect(v.lineColor).toBe(v.defaultLinkColor)
    expect(v.lineColor).not.toBe(v.textColor)
  })
})
