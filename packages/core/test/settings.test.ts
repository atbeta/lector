import { describe, expect, test } from 'bun:test'
import { DEFAULT_SETTINGS, normalizeSettings, type EditorSettings } from '../src/settings.ts'

describe('settings schema', () => {
  test('空输入回退默认', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  test('合法字段透传', () => {
    const s = normalizeSettings({
      theme: 'dark',
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.9,
      readingWidth: 800,
      autoCharacterPairs: false,
      closeAlwaysConfirmsChanges: false,
      showWhitespace: true,
    })
    expect(s.theme).toBe('dark')
    expect(s.fontFamily).toBe('serif')
    expect(s.fontSize).toBe(18)
    expect(s.lineHeight).toBe(1.9)
    expect(s.readingWidth).toBe(800)
    expect(s.autoCharacterPairs).toBe(false)
    expect(s.closeAlwaysConfirmsChanges).toBe(false)
    expect(s.showWhitespace).toBe(true)
  })

  test('非法类型 / 越界回退默认为基准', () => {
    const base: EditorSettings = { ...DEFAULT_SETTINGS, fontSize: 20 }
    expect(normalizeSettings({ fontSize: 'big' }, base).fontSize).toBe(20)
    expect(normalizeSettings({ theme: 'blue' }, base).theme).toBe('system')
    expect(normalizeSettings({ autoCharacterPairs: 1 }, base).autoCharacterPairs).toBe(true)
  })

  test('数值越界夹取', () => {
    expect(normalizeSettings({ fontSize: 100 }).fontSize).toBe(32)
    expect(normalizeSettings({ fontSize: 2 }).fontSize).toBe(11)
    expect(normalizeSettings({ lineHeight: 5 }).lineHeight).toBe(2.6)
    expect(normalizeSettings({ readingWidth: 2000 }).readingWidth).toBe(1600)
  })

  test('theme 三种合法值', () => {
    expect(normalizeSettings({ theme: 'system' }).theme).toBe('system')
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light')
    expect(normalizeSettings({ theme: 'dark' }).theme).toBe('dark')
  })
})
