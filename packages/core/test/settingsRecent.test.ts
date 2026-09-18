import { describe, expect, test } from 'bun:test'
import { appDisplayName, isPlausibleAppPath, pushRecentApp } from '../src/settings.ts'

describe('最近用过的应用', () => {
  test('重复使用提到最前，而不是新增一条', () => {
    expect(pushRecentApp(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })
  test('最多 5 个', () => {
    expect(pushRecentApp(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4'])
  })
  test('空白不占位', () => {
    expect(pushRecentApp(['a'], '   ')).toEqual(['a'])
  })
})

describe('外部应用展示名', () => {
  test('剥掉可执行扩展名', () => {
    expect(appDisplayName('C:\\Program Files\\Typora\\Typora.exe')).toBe('Typora')
    expect(appDisplayName('/Applications/Visual Studio Code.app')).toBe('Visual Studio Code')
  })
  test('无扩展名时原样返回基名', () => {
    expect(appDisplayName('/usr/bin/code')).toBe('code')
  })
  test('光秃秃的名字不炸', () => {
    expect(appDisplayName('typora')).toBe('typora')
  })
})

describe('失焦时要不要入列', () => {
  test('带可执行扩展名就收', () => {
    expect(isPlausibleAppPath('C:\\Program Files\\Typora\\Typora.exe')).toBe(true)
    expect(isPlausibleAppPath('/Applications/Typora.app')).toBe(true)
  })
  test('没扩展名的路径要三层才收——两层正是半截输入的形状', () => {
    expect(isPlausibleAppPath('/usr/bin/code')).toBe(true)
    expect(isPlausibleAppPath('/usr/bi')).toBe(false)
    expect(isPlausibleAppPath('C:\\Program')).toBe(false)
  })
  test('空串与光秃秃的名字不收（后者与"没打完"无法区分）', () => {
    expect(isPlausibleAppPath('   ')).toBe(false)
    expect(isPlausibleAppPath('code')).toBe(false)
  })
})