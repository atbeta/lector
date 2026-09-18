// 「最近用过的外部应用」是个纯函数，所以它该有测试：这个列表的价值全在顺序与去重上
// （重复用一个应用应当把它提到最前，而不是在列表里出现两次）。
import { describe, expect, test } from 'bun:test'
import { pushRecentApp } from '../src/settings.ts'

describe('最近用过的外部应用', () => {
  test('重复使用会把已有的提到最前，而不是新增一条', () => {
    expect(pushRecentApp(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  test('最多留 5 个（新的进来，最旧的出去）', () => {
    expect(pushRecentApp(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4'])
  })

  test('空白输入不占位', () => {
    expect(pushRecentApp(['a'], '   ')).toEqual(['a'])
    expect(pushRecentApp([], '')).toEqual([])
  })

  test('首尾空格会清掉（路径里带空格很常见，前后空格必是误输入）', () => {
    expect(pushRecentApp([], '  /Apps/Typora.app  ')).toEqual(['/Apps/Typora.app'])
  })
})
