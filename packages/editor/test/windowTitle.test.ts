import { describe, expect, test } from 'bun:test'
import { formatDocTitle } from '../src/windowTitle.ts'

describe('document.title 格式', () => {
  test('空态只有应用名；有文档带后缀', () => {
    expect(formatDocTitle(null, false)).toBe('Lector')
    expect(formatDocTitle('notes.md', false)).toBe('notes.md — Lector')
  })

  test('脏 = 加 ● 前缀（与原生标题的 Windows 前缀同款）', () => {
    expect(formatDocTitle('notes.md', true)).toBe('● notes.md — Lector')
    expect(formatDocTitle(null, true)).toBe('● Lector')
  })
})
