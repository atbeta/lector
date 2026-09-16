import { describe, expect, test } from 'bun:test'
import { createSourceDocument, parseBlocks, serialize } from '@lector/core'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { sessionIsDirty } from '../src/sessionDirty.ts'
import { createBlockOperations } from '../src/blockOperations.ts'
import type { DocumentSession } from '../src/documentSession.ts'
import type { CaretIntent } from '../src/caretNavigation.ts'

function makeSession(text: string): DocumentSession {
  const source = createSourceDocument('/t/doc.md', text, 0)
  const session: DocumentSession = {
    source,
    blocks: parseBlocks(source.text),
    focusedId: null,
    dirty: false,
    structuralDirty: false,
    originals: new Map(),
  }
  session.originals = new Map(session.blocks.map((b) => [b.id, b.raw] as const))
  return session
}

function makeOps(session: DocumentSession) {
  const focusCalls: { id: string | null; intent: CaretIntent | undefined }[] = []
  const ops = createBlockOperations({
    session,
    markDirty: () => {
      session.dirty = sessionIsDirty(session.blocks, session.structuralDirty)
    },
    render: () => Promise.resolve(),
    focusBlock: (id) => {
      session.focusedId = id
    },
    forgetBlockViews: () => {},
    focusAfterStructuralEdit: (id, intent) => {
      focusCalls.push({ id, intent })
      session.focusedId = id
    },
    insertImageMarkdownAtCaret: () => {},
    onUndo: () => {},
  })
  return { ops, focusCalls }
}

function fakeView(doc: string, head = doc.length): EditorView {
  return { state: EditorState.create({ doc, selection: { anchor: head } }) } as EditorView
}

const DOC = '# 标题\n\n第一段\n\n第二段\n\n- [ ] 任务\n- [ ] 任务\n'

describe('deleteBlock', () => {
  test('删中间内容块带走其后空白缝，其余块字节不变', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const target = s.blocks.find((b) => b.raw === '第一段')!
    ops.deleteBlock(target.id)
    const raws = s.blocks.map((b) => b.raw)
    expect(raws.includes('第一段')).toBe(false)
    expect(serialize(s.blocks)).toBe('# 标题\n\n第二段\n\n- [ ] 任务\n- [ ] 任务\n')
    expect(s.dirty).toBe(true)
  })

  test('撤销删除恢复原始序列化', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const target = s.blocks.find((b) => b.raw === '第二段')!
    ops.deleteBlock(target.id)
    expect(ops.undoBlockOp()).toBe(true)
    expect(serialize(s.blocks)).toBe(DOC)
  })

  test('最后一个内容块不可删：清空成空段落且可撤销', () => {
    const s = makeSession('仅一段\n')
    const { ops } = makeOps(s)
    const only = s.blocks.find((b) => b.kind !== 'unknown')!
    ops.deleteBlock(only.id)
    expect(s.blocks.length).toBe(2)
    expect(s.blocks[0]!.kind).toBe('paragraph')
    expect(s.blocks[0]!.raw).toBe('')
    expect(s.dirty).toBe(true)
    ops.undoBlockOp()
    expect(s.blocks[0]!.raw).toBe('仅一段')
  })
})

describe('insertParagraphBefore/After', () => {
  test('插入保序，撤销只移除插入的块', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const anchor = s.blocks.find((b) => b.raw === '第二段')!
    const idsBefore = s.blocks.map((b) => b.id)
    ops.insertParagraphBefore(anchor.id)
    const insertedIds = s.blocks.map((b) => b.id).filter((id) => !idsBefore.includes(id))
    expect(insertedIds.length).toBe(2)
    const idx = s.blocks.findIndex((b) => b.id === anchor.id)
    expect(s.blocks[idx - 2]!.kind).toBe('paragraph')
    expect(s.blocks[idx - 1]!.kind).toBe('unknown')
    expect(s.focusedId).toBe(insertedIds[0]!)
    ops.undoBlockOp()
    expect(s.blocks.map((b) => b.id)).toEqual(idsBefore)
    ops.insertParagraphAfter(anchor.id)
    const idxAfter = s.blocks.findIndex((b) => b.id === anchor.id)
    expect(idxAfter).toBe(idx - 2)
    expect(s.blocks[idxAfter + 1]!.kind).toBe('paragraph')
  })
})

describe('toggleTaskItem', () => {
  test('相同文字的两条任务按序号改对那一条，撤销还原', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const list = s.blocks.find((b) => b.kind === 'list')!
    ops.toggleTaskItem(list, 1, true)
    expect(list.raw).toBe('- [ ] 任务\n- [x] 任务')
    ops.undoBlockOp()
    expect(list.raw).toBe('- [ ] 任务\n- [ ] 任务')
  })
})

describe('setBlockRaw', () => {
  test('改动标脏，写回原文即清脏', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const para = s.blocks.find((b) => b.raw === '第一段')!
    ops.setBlockRaw(para, '改写')
    expect(para.dirty).toBe(true)
    expect(s.dirty).toBe(true)
    ops.setBlockRaw(para, '第一段')
    expect(para.dirty).toBe(false)
    expect(s.dirty).toBe(false)
  })
})

describe('splitBlock', () => {
  test('块末分裂：插入空段 + 缝，originals 登记，回调拿到新块 id', () => {
    const s = makeSession('# 标题\n\n正文\n')
    const { ops, focusCalls } = makeOps(s)
    const heading = s.blocks.find((b) => b.kind === 'heading')!
    const view = fakeView('# 标题')
    expect(ops.splitBlock(heading, view)).toBe(true)
    const ids = s.blocks.map((b) => b.id)
    const hi = s.blocks.findIndex((b) => b.id === heading.id)
    expect(s.blocks[hi + 1]!.kind).toBe('unknown')
    const emptyPara = s.blocks[hi + 2]!
    expect(emptyPara.kind).toBe('paragraph')
    expect(emptyPara.raw).toBe('')
    expect(s.blocks[hi + 3]!.kind).toBe('unknown')
    expect(s.originals.get(emptyPara.id)).toBe('')
    expect(focusCalls.length).toBe(1)
    expect(focusCalls[0]!.id).toBe(emptyPara.id)
    expect(focusCalls[0]!.intent).toBeUndefined()
    expect(s.structuralDirty).toBe(true)
    expect(ids.includes(emptyPara.id)).toBe(true)
  })

  test('非块末 / 非段落标题不分裂', () => {
    const s = makeSession('# 标题\n\n正文\n')
    const { ops, focusCalls } = makeOps(s)
    const heading = s.blocks.find((b) => b.kind === 'heading')!
    const before = s.blocks.map((b) => b.id)
    expect(ops.splitBlock(heading, fakeView('# 标题', 2))).toBe(false)
    const list = makeSession('- a\n')
    const l = list.blocks.find((b) => b.kind === 'list')!
    const { ops: ops2 } = makeOps(list)
    expect(ops2.splitBlock(l, fakeView('- a'))).toBe(false)
    expect(s.blocks.map((b) => b.id)).toEqual(before)
    expect(focusCalls.length).toBe(0)
  })
})

describe('mergeBlock', () => {
  test('块首空段 Backspace：吃掉前面的缝并与上一内容块合并', () => {
    const s = makeSession('甲\n')
    const { ops, focusCalls } = makeOps(s)
    const prev = s.blocks.find((b) => b.raw === '甲')!
    ops.insertParagraphAfter(prev.id)
    const emptyPara = s.blocks.find((b) => b.kind === 'paragraph' && b.raw === '')!
    const view = fakeView('', 0)
    expect(ops.mergeBlock(emptyPara, view)).toBe(true)
    expect(s.blocks.find((b) => b.id === emptyPara.id)).toBeUndefined()
    expect(s.blocks.filter((b) => b.raw === '' && b.kind === 'paragraph').length).toBe(0)
    expect(serialize(s.blocks)).toBe('甲\n\n\n')
    expect(focusCalls.length).toBe(1)
    expect(focusCalls[0]!.id).toBe(prev.id)
    expect(focusCalls[0]!.intent).toEqual({ mode: 'end' })
    expect(s.structuralDirty).toBe(true)
  })

  test('非空块不合并', () => {
    const s = makeSession(DOC)
    const { ops, focusCalls } = makeOps(s)
    const para = s.blocks.find((b) => b.raw === '第二段')!
    const before = s.blocks.map((b) => b.id)
    expect(ops.mergeBlock(para, fakeView('第二段', 0))).toBe(false)
    expect(s.blocks.map((b) => b.id)).toEqual(before)
    expect(focusCalls.length).toBe(0)
  })
})

describe('实例隔离', () => {
  test('两个工厂各管各的 session / 撤销栈 / id 序列', () => {
    const s1 = makeSession('# 甲\n')
    const s2 = makeSession('# 乙\n')
    const a = makeOps(s1)
    const b = makeOps(s2)
    const h1 = s1.blocks.find((x) => x.kind === 'heading')!
    const h2 = s2.blocks.find((x) => x.kind === 'heading')!
    a.ops.insertParagraphAfter(h1.id)
    a.ops.insertParagraphAfter(h1.id)
    b.ops.insertParagraphBefore(h2.id)
    const ids1 = s1.blocks.map((x) => x.id)
    const ids2 = s2.blocks.map((x) => x.id)
    expect(ids1).toContain('e4')
    expect(ids2).toContain('e2')
    expect(ids2).not.toContain('e3')
    b.ops.undoBlockOp()
    expect(serialize(s2.blocks)).toBe('# 乙\n')
    expect(serialize(s1.blocks)).toBe('# 甲\n\n\n\n\n')
    a.ops.undoBlockOp()
    a.ops.undoBlockOp()
    expect(serialize(s1.blocks)).toBe('# 甲\n')
  })
})
