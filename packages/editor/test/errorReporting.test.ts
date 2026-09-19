// 全局错误回传的整理逻辑：日志文件里留下的应当是能读的文本，且不该被一次崩溃灌满。
import { describe, expect, test } from 'bun:test'
import { clampReport, describeReason, MAX_REPORT_CHARS } from '../src/errorReporting.ts'

describe('describeReason', () => {
  test('Error 带名字、消息与栈', () => {
    const err = new TypeError('boom')
    const out = describeReason(err)
    expect(out.startsWith('TypeError: boom')).toBe(true)
    expect(out).toContain('errorReporting.test.ts')
  })

  test('字符串原因原样返回', () => {
    expect(describeReason('network down')).toBe('network down')
  })

  test('普通对象转 JSON', () => {
    expect(describeReason({ code: 42, msg: 'x' })).toBe('{"code":42,"msg":"x"}')
  })

  test('循环引用不抛，退回 String', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(describeReason(a)).toBe('[object Object]')
  })

  test('null / undefined 也有可读结果', () => {
    expect(describeReason(null)).toBe('null')
    expect(describeReason(undefined)).toBe('undefined')
  })
})

describe('clampReport', () => {
  test('未超限原样返回', () => {
    expect(clampReport('short')).toBe('short')
  })

  test('超限截断并带省略号', () => {
    const long = 'x'.repeat(MAX_REPORT_CHARS + 10)
    const out = clampReport(long)
    expect(out.length).toBe(MAX_REPORT_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})
