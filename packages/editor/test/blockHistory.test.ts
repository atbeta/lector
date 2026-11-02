import { expect, test } from 'bun:test'
import { EditorState, Transaction } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'
import { reusableHistory } from '../src/cm.ts'

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
