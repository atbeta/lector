import { expect, test } from 'bun:test'
import { EditorState, Facet, Transaction } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'
import { remountState, reusableHistory } from '../src/cm.ts'

test('原文没变就还用原来的撤销栈', () => {
  let state = EditorState.create({ doc: '甲', extensions: [history()] })
  state = state.update({
    changes: { from: 1, insert: '乙' },
    annotations: Transaction.userEvent.of('input'),
  }).state
  expect(state.doc.toString()).toBe('甲乙')
  expect(undoDepth(state)).toBeGreaterThan(0)
  expect(reusableHistory(state, '甲乙')).toBe(state)
})

test('外面改过原文就不用旧撤销栈', () => {
  const state = EditorState.create({ doc: '甲乙', extensions: [history()] })
  expect(reusableHistory(state, '甲')).toBeUndefined()
  expect(reusableHistory(undefined, '甲')).toBeUndefined()
})

test('混合换行 / CRLF 原文也能接回撤销栈（按 CM 口径比）', () => {
  // CM 装载时已把行尾规整成 LF：拿 raw 直接比字符串会让这类文件永远接不回历史。
  const state = EditorState.create({ doc: '甲\n乙' })
  expect(reusableHistory(state, '甲\r\n乙')).toBe(state)
  expect(reusableHistory(state, '甲\n乙')).toBe(state)
  expect(reusableHistory(state, '甲\r\n丙')).toBeUndefined()
})

test('复用旧状态挂新视图：新配置生效，撤销深度保留', () => {
  // 直接拿整份旧 EditorState 建视图会把旧挂载的扩展（闭包、keymap、语言）
  // 原样接回来，本次传入的配置静默失效——F7 的回归点。
  let state = EditorState.create({ doc: '甲', extensions: [history()] })
  state = state.update({
    changes: { from: 1, insert: '乙' },
    annotations: Transaction.userEvent.of('input'),
  }).state
  const marker = Facet.define<string, string>({ combine: (v) => v[0] ?? '' })
  const next = remountState(state, '甲乙', [history(), marker.of('new-config')])
  expect(next.doc.toString()).toBe('甲乙')
  // 新挂法的扩展必须在场（旧 state 里没有这个 facet）
  expect(next.facet(marker)).toBe('new-config')
  // 历史字段要从旧状态搬过来
  expect(undoDepth(next)).toBeGreaterThan(0)
})

test('旧状态搬不动就退化成全新状态，不把挂载卡死', () => {
  // 没有 history 字段的旧状态：toJSON / fromJSON 走不通就丢历史重来，
  // 编辑面必须仍然可用（非核心能力降级，不阻塞核心）。
  const state = EditorState.create({ doc: '甲乙' })
  const next = remountState(state, '甲乙', [history()])
  expect(next.doc.toString()).toBe('甲乙')
})
