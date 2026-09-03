import { describe, expect, test } from 'bun:test'
import {
  extFromMime,
  imageMarkdown,
  insertAt,
  isImageMime,
  pastedFileName,
  safeDropName,
  sidecarRelPath,
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
