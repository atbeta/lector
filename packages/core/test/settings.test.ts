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

  test('图片设置：默认 images + {filename}.assets 模板', () => {
    expect(DEFAULT_SETTINGS.imageMode).toBe('images')
    expect(DEFAULT_SETTINGS.imageAssetsDir).toBe('{filename}.assets')
    expect(DEFAULT_SETTINGS.imageCommand).toBe('')
    expect(DEFAULT_SETTINGS.imageCommandTimeoutMs).toBe(30_000)
    const s = normalizeSettings({})
    expect(s.imageMode).toBe('images')
    expect(s.imageAssetsDir).toBe('{filename}.assets')
  })

  test('图片模式三种合法值，非法回退默认', () => {
    expect(normalizeSettings({ imageMode: 'assets' }).imageMode).toBe('assets')
    expect(normalizeSettings({ imageMode: 'command' }).imageMode).toBe('command')
    expect(normalizeSettings({ imageMode: 'images' }).imageMode).toBe('images')
    expect(normalizeSettings({ imageMode: 'weird' }).imageMode).toBe('images')
    expect(normalizeSettings({ imageMode: 7 }).imageMode).toBe('images')
  })

  test('命令字段：字符串清洗、args 过滤、超时夹取', () => {
    const s = normalizeSettings({
      imageMode: 'command',
      imageCommand: '  /usr/local/bin/picgo upload  ',
      imageCommandArgs: ['-d', 42, ''], // 非字符串剔除
      imageCommandTimeoutMs: 999999,
      imageAssetsDir: ' uploads ',
    })
    expect(s.imageCommand).toBe('/usr/local/bin/picgo upload')
    expect(s.imageCommandArgs).toEqual(['-d', ''])
    expect(s.imageCommandTimeoutMs).toBe(300_000)
    expect(normalizeSettings({ imageCommandTimeoutMs: 10 }).imageCommandTimeoutMs).toBe(1_000)
    expect(normalizeSettings({ imageCommandTimeoutMs: 'x' }).imageCommandTimeoutMs).toBe(30_000)
  })

  test('目录模板：拒绝路径分隔与穿越', () => {
    expect(normalizeSettings({ imageAssetsDir: 'docs/images' }).imageAssetsDir).toBe('{filename}.assets')
    expect(normalizeSettings({ imageAssetsDir: '../evil' }).imageAssetsDir).toBe('{filename}.assets')
    expect(normalizeSettings({ imageAssetsDir: 'assets folder' }).imageAssetsDir).toBe('assets folder')
    expect(normalizeSettings({ imageAssetsDir: '' }).imageAssetsDir).toBe('{filename}.assets')
  })
})

describe('mermaidConfig 字段', () => {
  test('默认空、字符串透传、非法类型回退', () => {
    expect(DEFAULT_SETTINGS.mermaidConfig).toBe('')
    expect(normalizeSettings({ mermaidConfig: '{"theme":"dark"}' }).mermaidConfig).toBe('{"theme":"dark"}')
    // 数字/对象之类的意外类型不该变成 "[object Object]" 进设置文件
    expect(normalizeSettings({ mermaidConfig: 42 as unknown as string }).mermaidConfig).toBe('42')
    expect(normalizeSettings({}).mermaidConfig).toBe('')
  })

  test('限长 20000：设置文件不该被当成主题仓库', () => {
    const huge = 'x'.repeat(30000)
    expect(normalizeSettings({ mermaidConfig: huge }).mermaidConfig.length).toBe(20000)
  })
})
