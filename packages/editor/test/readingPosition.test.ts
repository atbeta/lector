// 阅读位置记忆：这是「键值累积」型代码，最容易长成一个只增不减的
// localStorage，而它出问题不会有任何报错。边界逐条钉死。

import { describe, expect, test } from 'bun:test'
import {
  MAX_POSITIONS,
  getPosition,
  parsePositions,
  prunePositions,
  recordPosition,
} from '../src/readingPosition.ts'

describe('记录与取回', () => {
  test('记录后能取回', () => {
    const m = recordPosition({}, '/a.md', 1200, 5000, 1000)
    expect(getPosition(m, '/a.md', 5000)).toBe(1200)
  })

  test('同一路径覆盖旧值', () => {
    let m = recordPosition({}, '/a.md', 100, 5000, 1000)
    m = recordPosition(m, '/a.md', 900, 5000, 2000)
    expect(getPosition(m, '/a.md', 5000)).toBe(900)
    expect(m['/a.md']?.at).toBe(2000)
  })

  test('回到顶部 = 放弃记录（否则下次又跳回中间）', () => {
    let m = recordPosition({}, '/a.md', 1200, 5000, 1000)
    m = recordPosition(m, '/a.md', 0, 5000, 2000)
    expect(getPosition(m, '/a.md', 5000)).toBeNull()
    expect('/a.md' in m).toBe(false)
  })

  test('很浅的位置不记（刚打开就关掉不值得占槽位）', () => {
    const m = recordPosition({}, '/a.md', 10, 5000, 1000)
    expect('/a.md' in m).toBe(false)
  })

  test('文档被删掉一半以上 → 不恢复', () => {
    const m = recordPosition({}, '/a.md', 4000, 10000, 1000)
    expect(getPosition(m, '/a.md', 4000)).toBeNull()
    // 正常长度仍可恢复
    expect(getPosition(m, '/a.md', 9500)).toBe(4000)
  })

  test('从没记过的路径返回 null', () => {
    expect(getPosition({}, '/nope.md', 1000)).toBeNull()
  })
})

describe('淘汰', () => {
  test('超过上限时保留最近打开的', () => {
    let m = {}
    for (let i = 0; i < MAX_POSITIONS + 10; i++) {
      m = recordPosition(m, `/f${i}.md`, 100 + i, 5000, 1000 + i)
    }
    expect(Object.keys(m).length).toBe(MAX_POSITIONS + 10)
    const pruned = prunePositions(m)
    expect(Object.keys(pruned).length).toBe(MAX_POSITIONS)
    // 最新的在，最旧的被淘汰
    expect(`/f${MAX_POSITIONS + 9}.md` in pruned).toBe(true)
    expect('/f0.md' in pruned).toBe(false)
  })

  test('未超上限时原样返回', () => {
    const m = recordPosition({}, '/a.md', 100, 5000, 1)
    expect(prunePositions(m)).toBe(m)
  })
})

describe('解析容错', () => {
  test('坏数据当空处理，不抛错', () => {
    expect(parsePositions(null)).toEqual({})
    expect(parsePositions('')).toEqual({})
    expect(parsePositions('not json')).toEqual({})
    expect(parsePositions('[1,2,3]')).toEqual({})
    expect(parsePositions('"str"')).toEqual({})
  })

  test('逐条校验，坏条目丢弃、好条目保留', () => {
    const raw = JSON.stringify({
      '/good.md': { top: 500, length: 3000, at: 10 },
      '/bad-top.md': { top: 'x', length: 1, at: 1 },
      '/missing.md': { length: 1 },
      '/good2.md': { top: 0, length: 0, at: 0 },
    })
    const m = parsePositions(raw)
    expect(Object.keys(m).sort()).toEqual(['/good.md', '/good2.md'])
    expect(m['/good.md']).toEqual({ top: 500, length: 3000, at: 10 })
  })
})
