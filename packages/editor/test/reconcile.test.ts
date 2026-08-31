import { describe, expect, test } from 'bun:test'
import { reconcileKeyedOrder } from '../src/reconcile.ts'
import { sessionIsDirty } from '../src/sessionDirty.ts'

describe('keyed 顺序对齐', () => {
  test('新块插到 IR 位置而不是末尾', () => {
    const existing = ['a', 'gap', 'b']
    const desired = ['a', 'gap', 'empty', 'gap2', 'b']
    expect(reconcileKeyedOrder(existing, desired)).toEqual({
      order: ['a', 'gap', 'empty', 'gap2', 'b'],
      remove: [],
    })
  })

  test('IR 里已删除的节点要移除', () => {
    const existing = ['a', 'gap', 'empty', 'b']
    const desired = ['a', 'gap', 'b']
    expect(reconcileKeyedOrder(existing, desired)).toEqual({
      order: ['a', 'gap', 'b'],
      remove: ['empty'],
    })
  })

  test('顺序与 IR 不一致时按 desired 重排', () => {
    const existing = ['a', 'b', 'c']
    const desired = ['c', 'a', 'b']
    expect(reconcileKeyedOrder(existing, desired)).toEqual({
      order: ['c', 'a', 'b'],
      remove: [],
    })
  })
})

describe('session dirty', () => {
  test('任一块 dirty 则脏', () => {
    expect(sessionIsDirty([{ dirty: false }, { dirty: true }], false)).toBe(true)
  })

  test('结构变化即使块都不 dirty 也算脏', () => {
    expect(sessionIsDirty([{ dirty: false }, { dirty: false }], true)).toBe(true)
  })

  test('无结构变化且块都干净则不脏', () => {
    expect(sessionIsDirty([{ dirty: false }], false)).toBe(false)
  })
})
