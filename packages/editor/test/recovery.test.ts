// 草稿存储的契约测试。
//
// 只测存储层（记 / 读 / 清 / 坏数据 / 超长），不测"提示条是否弹出"——
// 那条路径只在真实文件上触发（内置样例没有目录，见 main.ts 的 isRecoverable），
// 属于壳里的运行时行为，靠真机验证。这里守住的是"草稿不会读出错东西"。
//
// bun test 没有 localStorage，用一个最小实现顶上：这几个用例关心的正是
// 「我们怎么用它」（字符串键值 + 配额异常），不是浏览器实现细节。
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
} as Storage

import { describe, expect, test } from 'bun:test'
import { rememberRecovery, readRecovery, forgetRecovery } from '../src/recovery.ts'

describe('未保存草稿', () => {
  test('记一份再读回来', () => {
    rememberRecovery('/docs/a.md', '# 标题\n\n正文')
    const rec = readRecovery('/docs/a.md')
    expect(rec?.content).toBe('# 标题\n\n正文')
    expect(rec?.path).toBe('/docs/a.md')
    expect(rec!.at).toBeGreaterThan(0)
  })

  test('不同文件互不串台', () => {
    rememberRecovery('/docs/a.md', 'AA')
    rememberRecovery('/docs/b.md', 'BB')
    expect(readRecovery('/docs/a.md')?.content).toBe('AA')
    expect(readRecovery('/docs/b.md')?.content).toBe('BB')
  })

  test('清掉之后读不到', () => {
    rememberRecovery('/docs/c.md', 'CC')
    forgetRecovery('/docs/c.md')
    expect(readRecovery('/docs/c.md')).toBeNull()
  })

  test('没有路径不记（未落盘的新文档没有「上次打开」可言）', () => {
    rememberRecovery('', 'X')
    expect(readRecovery('')).toBeNull()
  })

  test('超长内容不记（不拿 localStorage 当仓库）', () => {
    const huge = 'x'.repeat(512 * 1024 + 1)
    rememberRecovery('/docs/big.md', huge)
    expect(readRecovery('/docs/big.md')).toBeNull()
  })

  test('坏数据当没有，不抛异常', () => {
    store.set('lector-recovery:/docs/bad.md', '{ 这不是 json')
    expect(readRecovery('/docs/bad.md')).toBeNull()
    store.set('lector-recovery:/docs/bad2.md', JSON.stringify({ content: 42 }))
    expect(readRecovery('/docs/bad2.md')).toBeNull()
  })
})
