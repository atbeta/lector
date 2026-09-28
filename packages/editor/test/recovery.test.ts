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

import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { rememberRecovery, readRecovery, forgetRecovery } from '../src/recovery.ts'

describe('未保存草稿', () => {
  test('记一份再读回来', async () => {
    await rememberRecovery('/docs/a.md', '# 标题\n\n正文')
    const rec = await readRecovery('/docs/a.md')
    expect(rec?.content).toBe('# 标题\n\n正文')
    expect(rec?.path).toBe('/docs/a.md')
    expect(rec!.at).toBeGreaterThan(0)
  })

  test('不同文件互不串台', async () => {
    await rememberRecovery('/docs/a.md', 'AA')
    await rememberRecovery('/docs/b.md', 'BB')
    expect((await readRecovery('/docs/a.md'))?.content).toBe('AA')
    expect((await readRecovery('/docs/b.md'))?.content).toBe('BB')
  })

  test('清掉之后读不到', async () => {
    await rememberRecovery('/docs/c.md', 'CC')
    await forgetRecovery('/docs/c.md')
    expect(await readRecovery('/docs/c.md')).toBeNull()
  })

  test('没有路径不记（未落盘的新文档没有「上次打开」可言）', async () => {
    await rememberRecovery('', 'X')
    expect(await readRecovery('')).toBeNull()
  })

  test('超过 3MB 不记', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024 + 1)
    await rememberRecovery('/docs/big.md', huge)
    expect(await readRecovery('/docs/big.md')).toBeNull()
  })

  test('3MB 以内记得到（旧的 512KB 上限已取消）', async () => {
    const big = 'y'.repeat(600 * 1024)
    await rememberRecovery('/docs/mid.md', big)
    expect((await readRecovery('/docs/mid.md'))?.content).toBe(big)
  })

  test('旧 localStorage 草稿读到后迁进 IndexedDB 并删除原条目', async () => {
    store.set('lector-recovery:/docs/old.md', JSON.stringify({ content: '旧草稿', at: 123 }))
    const rec = await readRecovery('/docs/old.md')
    expect(rec?.content).toBe('旧草稿')
    expect(rec?.at).toBe(123)
    expect(store.has('lector-recovery:/docs/old.md')).toBe(false)
    // 再读一次走 IndexedDB，仍然在
    expect((await readRecovery('/docs/old.md'))?.content).toBe('旧草稿')
  })

  test('坏数据当没有，不抛异常', async () => {
    store.set('lector-recovery:/docs/bad.md', '{ 这不是 json')
    expect(await readRecovery('/docs/bad.md')).toBeNull()
    store.set('lector-recovery:/docs/bad2.md', JSON.stringify({ content: 42 }))
    expect(await readRecovery('/docs/bad2.md')).toBeNull()
  })
})
