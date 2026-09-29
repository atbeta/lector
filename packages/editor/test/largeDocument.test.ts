import { describe, expect, test } from 'bun:test'
import {
  HARD_MAX_BYTES,
  MAX_BLOCK_RUN,
  MAX_IR_BLOCKS,
  countLargeWords,
  precheckTooLarge,
  projectBlockCount,
  projectedTooLarge,
  scanText,
} from '../src/largeDocument.ts'

describe('大文件判据：scanText', () => {
  test('空行分隔的散文：行数按换行计，最长连续非空行是 1', () => {
    const text = '第一段。\n\n第二段。\n\n第三段。\n'
    expect(scanText(text)).toEqual({ lines: 5, longestRun: 1 })
  })

  test('没有空行的列表：整篇是一个切不开的巨块', () => {
    const text = '- 一\n- 二\n- 三\n- 四\n'
    expect(scanText(text).longestRun).toBe(4)
  })

  test('空白行（空格 / Tab）也算空行，末行没有换行也计入', () => {
    expect(scanText('a\n   \nb\n').longestRun).toBe(1)
    expect(scanText('a\nb').longestRun).toBe(2)
    expect(scanText('a\t\nb').longestRun).toBe(2)
  })

  test('空文本', () => {
    expect(scanText('')).toEqual({ lines: 0, longestRun: 0 })
  })
})

describe('大文件判据：块数投影', () => {
  test('按首屏密度线性外推', () => {
    // 首屏 64K 字符出 2400 块 → 10MB 字符的文档投影约 37.5 万块
    expect(projectBlockCount(2400, 65536, 10_485_760)).toBe(384_000)
  })

  test('没有采样（headEnd 0）时退回首屏块数，不外推', () => {
    expect(projectBlockCount(5, 0, 1_000_000)).toBe(5)
    expect(projectBlockCount(0, 65536, 1_000_000)).toBe(0)
  })
})

describe('大文件判据：策略', () => {
  test('字节硬线以上直接大文件', () => {
    expect(precheckTooLarge(HARD_MAX_BYTES + 1, 1)).toBe(true)
    expect(precheckTooLarge(HARD_MAX_BYTES, 1)).toBe(false)
  })

  test('切不开的巨块（超长连续非空行）走大文件，无需解析', () => {
    expect(precheckTooLarge(1_000_000, MAX_BLOCK_RUN + 1)).toBe(true)
    expect(precheckTooLarge(1_000_000, MAX_BLOCK_RUN)).toBe(false)
  })

  test('字节不大但块太密的文档由投影拦下', () => {
    // 4MB 密集 mixed：首屏 64K 字符约 3100 块 → 投影约 20 万块 → 拦
    expect(projectedTooLarge(3103, 65_536, 4_194_304)).toBe(true)
    // 10MB 纯散文：首屏 64K 字符约 500 块 → 投影约 8 万块 → 放行
    expect(projectedTooLarge(512, 65_536, 10_485_760)).toBe(false)
  })

  test('阈值常量彼此自洽', () => {
    expect(MAX_IR_BLOCKS).toBeGreaterThan(143_642) // 放得下 10MB 散文实测块数
    expect(MAX_IR_BLOCKS).toBeLessThan(151_746) // 挡得住 4MB 密集 mixed 实测块数
  })
})

describe('大文件词数：后台分片统计', () => {
  test('分片累加，结果与一次性统计一致', () => {
    const text = 'hello world\n\n你好 世界\n\nfoo bar baz\n'
    let done: number | null = null
    // 同步调度：每片立即执行，等价于把时间片压成 0
    countLargeWords(text, (w) => (done = w), (fn) => fn())
    expect(done as number | null).toBe(9) // 与 countText 同口径（含 CJK 逐字计）
  })

  test('取消后不再回调', () => {
    const text = 'a b c d e f g h i j\n'.repeat(1000)
    let done: number | null = null
    // 异步调度：取消发生在第一片之前，回调不该再触发
    const cancel = countLargeWords(text, (w) => (done = w), (fn) => queueMicrotask(fn))
    cancel()
    expect(done).toBeNull()
  })
})
