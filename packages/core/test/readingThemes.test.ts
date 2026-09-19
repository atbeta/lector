// 阅读主题的数据契约：清单本身、id 校验、套用标定排版。
//
// 这里只测「数值层」——纸墨与装饰在 CSS 里，由 tools/design-audit.mjs 量对比度，
// tools/ui-verify.mjs 量上屏结果。两边都不能省：数据对了不代表画出来好看，
// 画出来好看也不代表某个主题漏了 id。

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_READING_THEME,
  DEFAULT_SETTINGS,
  READING_THEMES,
  isReadingThemeId,
  matchesReadingThemePreset,
  normalizeSettings,
  readingTheme,
  typographyHome,
  withReadingTheme,
} from '../src/index.ts'

describe('阅读主题清单', () => {
  test('默认主题在清单里，且与 DEFAULT_SETTINGS 的标定值一致', () => {
    const def = readingTheme(DEFAULT_READING_THEME)
    expect(def.preset.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily)
    expect(def.preset.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(def.preset.lineHeight).toBe(DEFAULT_SETTINGS.lineHeight)
    expect(def.preset.readingWidth).toBe(DEFAULT_SETTINGS.readingWidth)
  })

  test('至少 6 款（默认 + 新增 5 款），id 唯一', () => {
    expect(READING_THEMES.length).toBeGreaterThanOrEqual(6)
    const ids = READING_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('每款都有中英名、画面句与规格行，都不为空', () => {
    for (const t of READING_THEMES) {
      for (const v of [t.name, t.tagline, t.spec]) {
        expect(v.zh.trim().length).toBeGreaterThan(0)
        expect(v.en.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test('标定值都落在设置的夹取区间内（否则选主题会被静默改写）', () => {
    for (const t of READING_THEMES) {
      expect(t.preset.fontSize).toBeGreaterThanOrEqual(11)
      expect(t.preset.fontSize).toBeLessThanOrEqual(32)
      expect(t.preset.lineHeight).toBeGreaterThanOrEqual(1.2)
      expect(t.preset.lineHeight).toBeLessThanOrEqual(2.6)
      expect(t.preset.readingWidth).toBeGreaterThanOrEqual(480)
      expect(t.preset.readingWidth).toBeLessThanOrEqual(1200)
    }
  })

  /**
   * 规格行的格式是产品约束，不是文案自由：四段「特征 · 字号 · 行距 · 栏宽」。
   * 卡片里每张牌的第二行都长一样，用户才能横向比较；一旦有人写成散文，
   * 六张卡里就会出现一张长度两倍的，画廊立刻散架。
   */
  test('规格行统一格式：特征 · 字号 · 行距 · 栏宽，且数字与标定值一致', () => {
    for (const t of READING_THEMES) {
      const seg = t.spec.zh.split(' · ')
      expect(seg.length).toBe(4)
      expect(seg[1]).toBe(`${t.preset.fontSize}px`)
      expect(seg[2]).toBe(`${t.preset.lineHeight} 行距`)
      expect(seg[3]).toBe(`${t.preset.readingWidth}px 栏宽`)
      expect(t.spec.en.split(' · ').length).toBe(4)
    }
  })
})

describe('readingTheme 取值', () => {
  test('已知 id 命中', () => {
    expect(readingTheme('paper').id).toBe('paper')
  })

  test('id 校验只认清单里的值', () => {
    expect(isReadingThemeId('sepia')).toBe(true)
    expect(isReadingThemeId('nope')).toBe(false)
    expect(isReadingThemeId(null)).toBe(false)
  })
})

describe('套用阅读主题', () => {
  test('选主题 = 套用四项标定值，其余设置不动', () => {
    const before = { ...DEFAULT_SETTINGS, showWhitespace: true }
    const after = withReadingTheme(before, 'manual')
    expect(after.readingTheme).toBe('manual')
    expect(after.fontSize).toBe(16)
    expect(after.lineHeight).toBe(1.68)
    expect(after.readingWidth).toBe(1000)
    expect(after.fontFamily).toBe('system')
    expect(after.showWhitespace).toBe(true)
    expect(after.theme).toBe(before.theme)
  })

  test('套用后与标定值一致；改动任一项即视为已微调', () => {
    const applied = withReadingTheme(DEFAULT_SETTINGS, 'focus')
    expect(matchesReadingThemePreset(applied)).toBe(true)
    expect(matchesReadingThemePreset({ ...applied, fontSize: 22 })).toBe(false)
  })

  test('排版的家是当前主题标定，不是全局 17px', () => {
    expect(typographyHome({ readingTheme: 'default' }).fontSize).toBe(17)
    expect(typographyHome({ readingTheme: 'manual' }).fontSize).toBe(16)
    expect(typographyHome({ readingTheme: 'paper' }).fontSize).toBe(18)
    expect(typographyHome({ readingTheme: 'manual' }).readingWidth).toBe(1000)
  })
})

describe('设置 schema 里的 readingTheme', () => {
  test('缺失 / 非法值回退到基准', () => {
    expect(normalizeSettings({}).readingTheme).toBe(DEFAULT_READING_THEME)
    expect(normalizeSettings({ readingTheme: 'rainbow' }).readingTheme).toBe(DEFAULT_READING_THEME)
    const base = withReadingTheme(DEFAULT_SETTINGS, 'book')
    expect(normalizeSettings({}, base).readingTheme).toBe('book')
  })

  test('合法值透传，设置往返不丢主题', () => {
    const s = withReadingTheme(DEFAULT_SETTINGS, 'sepia')
    const round = normalizeSettings(JSON.parse(JSON.stringify(s)))
    expect(round).toEqual(s)
  })
})
