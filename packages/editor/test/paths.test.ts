import { describe, expect, test } from 'bun:test'
import { baseName, dirName, docStem, isAbsolutePath } from '../src/paths.ts'

describe('路径工具', () => {
  test('baseName：两种分隔符都认', () => {
    expect(baseName('D:\\Code\\a\\b.md')).toBe('b.md')
    expect(baseName('/Users/me/b.md')).toBe('b.md')
    expect(baseName('b.md')).toBe('b.md')
  })

  test('dirName：按原分隔符还原，无目录给空串', () => {
    expect(dirName('D:\\Code\\a\\b.md')).toBe('D:\\Code\\a')
    expect(dirName('/Users/me/b.md')).toBe('/Users/me')
    expect(dirName('b.md')).toBe('')
  })

  test('docStem：去扩展名，空则回退 untitled', () => {
    expect(docStem('D:\\x\\My Notes.md')).toBe('My Notes')
    expect(docStem('/x/a.markdown')).toBe('a')
    expect(docStem('/x/a.txt')).toBe('a')
    expect(docStem('.md')).toBe('untitled')
  })

  test('isAbsolutePath：POSIX / 盘符 / UNC，未命名不算', () => {
    expect(isAbsolutePath('/home/a.md')).toBe(true)
    expect(isAbsolutePath('C:\\a.md')).toBe(true)
    expect(isAbsolutePath('C:/a.md')).toBe(true)
    expect(isAbsolutePath('\\\\srv\\share\\a.md')).toBe(true)
    expect(isAbsolutePath('a.md')).toBe(false)
    expect(isAbsolutePath('untitled.md')).toBe(false)
  })
})
