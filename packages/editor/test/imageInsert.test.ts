import { describe, expect, test } from 'bun:test'
import {
  _resetDedupForTests,
  expandImageDir,
  extFromMime,
  findDedupImage,
  imageContentHash,
  imageDedupKey,
  imageMarkdown,
  insertAt,
  isImageMime,
  pastedFileName,
  rememberImage,
  runImageIngest,
  safeDropName,
  sidecarRelPath,
  splitUploadCommand,
  type ImageEffects,
} from '../src/imageInsert.ts'

describe('图片落盘命名', () => {
  test('粘贴位图按本地时间戳命名', () => {
    expect(pastedFileName(new Date(2026, 7, 31, 22, 37, 5), 'image/png')).toBe(
      'pasted-20260831-223705.png',
    )
    expect(pastedFileName(new Date(2026, 0, 2, 3, 4, 5), 'image/jpeg')).toBe(
      'pasted-20260102-030405.jpg',
    )
  })

  test('相对路径固定在 images/ 下', () => {
    expect(sidecarRelPath('pasted-20260831-223705.png')).toBe('images/pasted-20260831-223705.png')
  })

  test('拖入文件名去掉路径与危险字符', () => {
    expect(safeDropName('photo.png')).toBe('photo.png')
    expect(safeDropName('a/b/../x.png')).toBe('x.png')
    expect(safeDropName('..')).toBeNull()
    expect(safeDropName('x.txt')).toBeNull()
    expect(safeDropName('weird name.WEBP')).toBe('weird-name.webp')
  })

  test('中文文件名不再被整段丢成 pasted-<时间戳>', () => {
    expect(safeDropName('读书笔记截图.png')).toBe('读书笔记截图.png')
    expect(safeDropName('草稿-2.jpeg')).toBe('草稿-2.jpeg')
    expect(safeDropName('截图 2026 版.png')).toBe('截图-2026-版.png')
    expect(safeDropName('../省略号/跳到截图.png')).toBe('跳到截图.png')
  })
})

describe('图片目录模板与命令分词', () => {
  test('{filename} 展开为文档基名', () => {
    expect(expandImageDir('{filename}.assets', '读书笔记')).toBe('读书笔记.assets')
    expect(expandImageDir('{filename}媒体', 'roadmap')).toBe('roadmap媒体')
  })

  test('非法模板回退 null', () => {
    expect(expandImageDir('', 'x')).toBeNull()
    expect(expandImageDir('a/b', 'x')).toBeNull()
    expect(expandImageDir('..', 'x')).toBeNull()
    expect(expandImageDir('../foo', 'x')).toBeNull()
    expect(expandImageDir('{filename}', '')).toBe('untitled')
  })

  test('命令按引号感知拆成可执行 + 前置参数', () => {
    expect(splitUploadCommand('picgo upload')).toEqual({ command: 'picgo', preArgs: ['upload'] })
    expect(splitUploadCommand('"/my tools/picgo.exe" -d -v')).toEqual({
      command: '/my tools/picgo.exe',
      preArgs: ['-d', '-v'],
    })
    expect(splitUploadCommand('')).toEqual({ command: '', preArgs: [] })
    expect(splitUploadCommand('   ')).toEqual({ command: '', preArgs: [] })
  })
})

describe('插入 markdown', () => {
  test('光标处插入图片语法', () => {
    const md = imageMarkdown('images/a.png')
    expect(md).toBe('![](images/a.png)')
    expect(insertAt('ab', 1, md)).toEqual({ text: 'a![](images/a.png)b', caret: 1 + md.length })
  })

  test('只认位图 mime', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(false)
    expect(isImageMime('text/plain')).toBe(false)
    expect(extFromMime('image/webp')).toBe('webp')
  })
})

describe('图片内容哈希去重', () => {
  test('同一份字节算出同一个 12-hex 串', async () => {
    const bytes = new TextEncoder().encode('hello world').buffer
    const a = await imageContentHash(bytes)
    const b = await imageContentHash(bytes)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  test('不同字节算出不同 hash', async () => {
    const a = await imageContentHash(new TextEncoder().encode('foo').buffer)
    const b = await imageContentHash(new TextEncoder().encode('bar').buffer)
    expect(a).not.toBe(b)
  })

  test('记入 map 后能查到;reset 后查不到', () => {
    _resetDedupForTests()
    const key = imageDedupKey('abc123', { copy: true, copyDir: 'images', upload: 'off' })
    expect(findDedupImage(key)).toBeNull()
    rememberImage(key, 'images/foo.png')
    expect(findDedupImage(key)).toBe('images/foo.png')
    _resetDedupForTests()
    expect(findDedupImage(key)).toBeNull()
  })

  test('去重键带上管线：同一张图换了走法要重新走一遍', () => {
    const hash = 'abc123'
    const local = imageDedupKey(hash, { copy: true, copyDir: 'images', upload: 'manual' })
    // 换目录 / 改成自动上传 / 不再复制——结果都不同，不能互相复用
    expect(imageDedupKey(hash, { copy: true, copyDir: 'shots', upload: 'manual' })).not.toBe(local)
    expect(imageDedupKey(hash, { copy: true, copyDir: 'images', upload: 'auto' })).not.toBe(local)
    expect(imageDedupKey(hash, { copy: false, copyDir: 'images', upload: 'auto' })).not.toBe(local)
    // 同一管线仍然复用同一个键
    expect(imageDedupKey(hash, { copy: true, copyDir: 'images', upload: 'manual' })).toBe(local)
  })
})

describe('插图管线（复制 × 上传）', () => {
  /** 假的外部动作：记录调用顺序，返回可预期的结果。 */
  function fakeEffects(overrides: Partial<ImageEffects> = {}) {
    const calls: string[] = []
    const fx: ImageEffects = {
      copy: async () => {
        calls.push('copy')
        return { relative_path: 'images/a.png', abs_path: '/doc/images/a.png' }
      },
      stage: async () => {
        calls.push('stage')
        return '/tmp/lector-stage/a.png'
      },
      upload: async () => {
        calls.push('upload')
        return { url: 'https://host/a.png', error: null }
      },
      discard: async () => {
        calls.push('discard')
      },
      ...overrides,
    }
    return { fx, calls }
  }

  test('没有上传命令：只落副本，正文写相对路径', async () => {
    const { fx, calls } = fakeEffects()
    const r = await runImageIngest({ copy: true, copyDir: 'images', upload: 'off' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'images/a.png', uploaded: false, copied: true, error: null })
    expect(calls).toEqual(['copy'])
  })

  test('手动上传：正文同样先写本地路径（上传是之后从图片菜单做的事）', async () => {
    const { fx, calls } = fakeEffects()
    const r = await runImageIngest({ copy: true, copyDir: '{filename}.assets', upload: 'manual' }, 'a.png', 'AAA', fx)
    expect(r.src).toBe('images/a.png')
    expect(r.uploaded).toBe(false)
    expect(calls).toEqual(['copy'])
  })

  test('复制 + 自动上传成功：副本在，正文换成图床地址', async () => {
    const { fx, calls } = fakeEffects()
    const r = await runImageIngest({ copy: true, copyDir: 'images', upload: 'auto' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'https://host/a.png', uploaded: true, copied: true, error: null })
    expect(calls).toEqual(['copy', 'upload'])
  })

  test('复制 + 自动上传失败：正文退回本地副本，原因带回调用方', async () => {
    const { fx, calls } = fakeEffects({
      upload: async () => {
        calls.push('upload')
        return { url: null, error: 'exit code 1' }
      },
    })
    const r = await runImageIngest({ copy: true, copyDir: 'images', upload: 'auto' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'images/a.png', uploaded: false, copied: true, error: 'exit code 1' })
    expect(calls).toEqual(['copy', 'upload'])
  })

  test('不复制 + 自动上传成功：走临时文件，磁盘上不留副本', async () => {
    const { fx, calls } = fakeEffects()
    const r = await runImageIngest({ copy: false, copyDir: 'images', upload: 'auto' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'https://host/a.png', uploaded: true, copied: false, error: null })
    // 上传用临时文件，传完就删——没有 copy
    expect(calls).toEqual(['stage', 'upload', 'discard'])
  })

  test('不复制 + 自动上传失败：补落一份副本兜底（绝不丢图）', async () => {
    const { fx, calls } = fakeEffects({
      upload: async () => {
        calls.push('upload')
        return { url: null, error: 'timed out after 30000ms' }
      },
    })
    const r = await runImageIngest({ copy: false, copyDir: 'images', upload: 'auto' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'images/a.png', uploaded: false, copied: true, error: 'timed out after 30000ms' })
    expect(calls).toEqual(['stage', 'upload', 'discard', 'copy'])
  })

  test('壳里没有 stage_image（旧版本）：退回复制 + 上传', async () => {
    const { fx, calls } = fakeEffects({
      stage: async () => {
        calls.push('stage')
        return null
      },
    })
    const r = await runImageIngest({ copy: false, copyDir: 'images', upload: 'auto' }, 'a.png', 'AAA', fx)
    expect(r).toEqual({ src: 'https://host/a.png', uploaded: true, copied: true, error: null })
    expect(calls).toEqual(['stage', 'copy', 'upload'])
  })
})
