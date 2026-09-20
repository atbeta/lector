import { expect, test } from 'bun:test'
import { shellSupportsPdfExport } from '@lector/shell-web'

test('shellSupportsPdfExport：只有非 Apple 壳给 PDF 入口', () => {
  expect(shellSupportsPdfExport('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
  expect(shellSupportsPdfExport('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  expect(shellSupportsPdfExport('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false)
})
