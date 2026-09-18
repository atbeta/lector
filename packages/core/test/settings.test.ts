import { describe, expect, test } from 'bun:test'
import { DEFAULT_SETTINGS, imagePipeline, normalizeSettings, type EditorSettings } from '../src/settings.ts'

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
      markHighlight: false,
    })
    expect(s.theme).toBe('dark')
    expect(s.fontFamily).toBe('serif')
    expect(s.fontSize).toBe(18)
    expect(s.lineHeight).toBe(1.9)
    expect(s.readingWidth).toBe(800)
    expect(s.autoCharacterPairs).toBe(false)
    expect(s.closeAlwaysConfirmsChanges).toBe(false)
    expect(s.showWhitespace).toBe(true)
    expect(s.markHighlight).toBe(false)
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

  test('==高亮== 开关：默认开，非法类型回退', () => {
    expect(DEFAULT_SETTINGS.markHighlight).toBe(true)
    expect(normalizeSettings({}).markHighlight).toBe(true)
    expect(normalizeSettings({ markHighlight: false }).markHighlight).toBe(false)
    expect(normalizeSettings({ markHighlight: 1 as unknown as boolean }).markHighlight).toBe(true)
  })

  test('内联公式开关：默认开，非法类型回退', () => {
    expect(DEFAULT_SETTINGS.math).toBe(true)
    expect(normalizeSettings({}).math).toBe(true)
    expect(normalizeSettings({ math: false }).math).toBe(false)
    expect(normalizeSettings({ math: 'no' as unknown as boolean }).math).toBe(true)
  })

  test('图片设置：默认只复制、不上传', () => {
    expect(DEFAULT_SETTINGS.imageCopy).toBe(true)
    expect(DEFAULT_SETTINGS.imageCopyDir).toBe('images')
    expect(DEFAULT_SETTINGS.imageUploadAuto).toBe(false)
    expect(DEFAULT_SETTINGS.imageCommand).toBe('')
    expect(DEFAULT_SETTINGS.imageCommandTimeoutMs).toBe(30_000)
    const s = normalizeSettings({})
    expect(s.imageCopy).toBe(true)
    expect(s.imageCopyDir).toBe('images')
    expect(s.imageUploadAuto).toBe(false)
  })

  test('旧设置迁移：三档 imageMode 拆成复制 + 上传两根轴', () => {
    // images 档：固定 images/，没有上传
    const a = normalizeSettings({ imageMode: 'images', imageAssetsDir: '{filename}.assets' })
    expect(a.imageCopy).toBe(true)
    expect(a.imageCopyDir).toBe('images')
    expect(a.imageUploadAuto).toBe(false)
    // assets 档：目录模板跟着走
    const b = normalizeSettings({ imageMode: 'assets', imageAssetsDir: ' uploads ' })
    expect(b.imageCopy).toBe(true)
    expect(b.imageCopyDir).toBe('uploads')
    expect(b.imageUploadAuto).toBe(false)
    // command 档：本地副本 + 立即上传
    const c = normalizeSettings({ imageMode: 'command', imageCommand: 'picgo upload' })
    expect(c.imageCopy).toBe(true)
    expect(c.imageCopyDir).toBe('{filename}.assets')
    expect(c.imageUploadAuto).toBe(true)
    // 非法档位 = 没有老键，回退默认
    expect(normalizeSettings({ imageMode: 'weird' }).imageCopyDir).toBe('images')
  })

  test('新键优先于旧键', () => {
    const s = normalizeSettings({
      imageMode: 'command',
      imageAssetsDir: 'legacy',
      imageCopyDir: 'shots',
      imageCopy: false,
      imageUploadAuto: false,
    })
    expect(s.imageCopyDir).toBe('shots')
    expect(s.imageCopy).toBe(false)
    expect(s.imageUploadAuto).toBe(false)
  })

  test('命令字段：字符串清洗、args 过滤、超时夹取', () => {
    const s = normalizeSettings({
      imageCommand: '  /usr/local/bin/picgo upload  ',
      imageCommandArgs: ['-d', 42, ''], // 非字符串剔除
      imageCommandTimeoutMs: 999999,
    })
    expect(s.imageCommand).toBe('/usr/local/bin/picgo upload')
    expect(s.imageCommandArgs).toEqual(['-d', ''])
    expect(s.imageCommandTimeoutMs).toBe(300_000)
    expect(normalizeSettings({ imageCommandTimeoutMs: 10 }).imageCommandTimeoutMs).toBe(1_000)
    expect(normalizeSettings({ imageCommandTimeoutMs: 'x' }).imageCommandTimeoutMs).toBe(30_000)
  })

  test('目录模板：拒绝路径分隔与穿越', () => {
    expect(normalizeSettings({ imageCopyDir: 'docs/images' }).imageCopyDir).toBe('images')
    expect(normalizeSettings({ imageCopyDir: '../evil' }).imageCopyDir).toBe('images')
    expect(normalizeSettings({ imageCopyDir: 'assets folder' }).imageCopyDir).toBe('assets folder')
    expect(normalizeSettings({ imageCopyDir: '' }).imageCopyDir).toBe('images')
  })
})

describe('imagePipeline', () => {
  const withImage = (patch: Partial<EditorSettings>): EditorSettings => ({ ...DEFAULT_SETTINGS, ...patch })

  test('没有命令 = 没有上传，副本开关锁在开', () => {
    // 就算设置里写着「不复制 + 自动上传」，没有命令时也只能留在本地
    const p = imagePipeline(withImage({ imageCopy: false, imageUploadAuto: true }))
    expect(p).toEqual({ copy: true, copyDir: 'images', upload: 'off' })
  })

  test('有命令 + 复制：按 imageUploadAuto 分自动 / 手动', () => {
    const base = { imageCommand: 'picgo upload' }
    expect(imagePipeline(withImage({ ...base, imageUploadAuto: false })).upload).toBe('manual')
    expect(imagePipeline(withImage({ ...base, imageUploadAuto: true })).upload).toBe('auto')
  })

  test('不复制 = 必须当场上传（手动时正文没有地址可写）', () => {
    const p = imagePipeline(withImage({ imageCommand: 'picgo upload', imageCopy: false, imageUploadAuto: false }))
    expect(p.copy).toBe(false)
    expect(p.upload).toBe('auto')
  })

  test('目录模板非法时回退默认，管线不返回空目录', () => {
    expect(imagePipeline(withImage({ imageCopyDir: '../x' })).copyDir).toBe('images')
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
