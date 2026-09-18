// 「最近用过的外部应用」是个纯函数，所以它该有测试：这个列表的价值全在顺序与去重上
// （重复用一个应用应当把它提到最前，而不是在列表里出现两次）。
import { describe, expect, test } from 'bun:test'
import { isPlausibleAppPath, pushRecentApp } from '../src/settings.ts'

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

describe('失焦时要不要入列（isPlausibleAppPath）', () => {
  test('带分隔符的按路径收下（含 Windows 反斜杠）', () => {
    expect(isPlausibleAppPath('C:\\Program Files\\Typora\\Typora.exe')).toBe(true)
    expect(isPlausibleAppPath('/Applications/Typora.app')).toBe(true)
  })

  test('光秃秃的可执行名也收（可能在 PATH 里）', () => {
    expect(isPlausibleAppPath('code')).toBe(true)
  })

  test('半截输入与空串不收——这是它唯一的职责', () => {
    expect(isPlausibleAppPath('C:\\Program')).toBe(false)
    expect(isPlausibleAppPath('   ')).toBe(false)
  })
})
