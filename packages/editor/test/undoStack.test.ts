import { describe, expect, test } from 'bun:test'
import { createUndoStack } from '../src/undoStack.ts'

describe('createUndoStack', () => {
  test('空栈撤销返回 null 且不执行任何动作', () => {
    const stack = createUndoStack()
    expect(stack.undo()).toBeNull()
    expect(stack.size()).toBe(0)
  })

  test('后进先出：最新的操作最先被撤回', () => {
    const stack = createUndoStack()
    const order: string[] = []
    stack.push('a', () => order.push('a'))
    stack.push('b', () => order.push('b'))
    expect(stack.undo()).toBe('b')
    expect(stack.undo()).toBe('a')
    expect(order).toEqual(['b', 'a'])
    expect(stack.undo()).toBeNull()
  })

  test('超出上限时丢掉最老的一条', () => {
    const stack = createUndoStack(3)
    const order: string[] = []
    for (const k of ['a', 'b', 'c', 'd']) stack.push(k, () => order.push(k))
    expect(stack.size()).toBe(3)
    // 连撤三次拿到 d/c/b，a 已经在栈外
    expect([stack.undo(), stack.undo(), stack.undo()]).toEqual(['d', 'c', 'b'])
    expect(stack.undo()).toBeNull()
    expect(order).toEqual(['d', 'c', 'b'])
  })

  test('clear 丢弃历史', () => {
    const stack = createUndoStack()
    const order: string[] = []
    stack.push('a', () => order.push('a'))
    stack.clear()
    expect(stack.size()).toBe(0)
    expect(stack.undo()).toBeNull()
    expect(order).toEqual([])
  })

  test('非法上限退回 1，不会退化成无界栈', () => {
    const zero = createUndoStack(0)
    zero.push('a', () => {})
    zero.push('b', () => {})
    expect(zero.size()).toBe(1)
    expect(zero.undo()).toBe('b')
  })

  test('闭包捕获的是它压栈时的对象，不受后续改动影响', () => {
    const stack = createUndoStack()
    const doc: string[] = ['x']
    // 删掉 doc[0] 并压栈，随后又删了一次
    const removed = doc.splice(0, 1)
    stack.push('删', () => doc.splice(0, 0, ...removed))
    doc.splice(0, 0, 'y')
    stack.undo()
    expect(doc).toEqual(['x', 'y'])
  })
})
