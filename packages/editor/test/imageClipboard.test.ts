import { describe, expect, test } from 'bun:test'
import { clipboardImageSource } from '../src/imageClipboard.ts'

describe('复制图片的 source', () => {
  test('本地协议反解成绝对路径', () => {
    const src = `lector-file://localhost/${encodeURIComponent('/Users/me/notes/images/a.png')}`
    expect(clipboardImageSource(src)).toBe('/Users/me/notes/images/a.png')
  })

  test('图床地址原样交给壳去取', () => {
    expect(clipboardImageSource('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
    expect(clipboardImageSource('http://127.0.0.1:8080/a.jpg')).toBe('http://127.0.0.1:8080/a.jpg')
  })

  test('内嵌位图保留 data url，svg 和空地址复制不了像素', () => {
    expect(clipboardImageSource('data:image/png;base64,aaaa')).toBe('data:image/png;base64,aaaa')
    expect(clipboardImageSource('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull()
    expect(clipboardImageSource('')).toBeNull()
    expect(clipboardImageSource('blob:https://example/uuid')).toBeNull()
  })
})
