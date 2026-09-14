import { describe, expect, test } from 'bun:test'
import {
  _resetDedupForTests,
  expandImageDir,
  extFromMime,
  findDedupImage,
  imageContentHash,
  imageMarkdown,
  insertAt,
  isImageMime,
  pastedFileName,
  rememberImage,
  safeDropName,
  sidecarRelPath,
  splitUploadCommand,
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
    expect(findDedupImage('abc123')).toBeNull()
    rememberImage('abc123', 'images/foo.png')
    expect(findDedupImage('abc123')).toBe('images/foo.png')
    _resetDedupForTests()
    expect(findDedupImage('abc123')).toBeNull()
  })
})
