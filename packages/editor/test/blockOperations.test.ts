import { describe, expect, test } from 'bun:test'
import { createSourceDocument, parseBlocks, serialize, type BlockView } from '@lector/core'
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
    saving: false,
    savedAt: null,
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

/**
 * 相邻两个内容块之间在**序列化后的文本里**必须至少隔着一个换行。
 *
 * 为什么单独立一条判据：块数组就是文档文本的顺序，而块与块之间的换行住在单独的
 * gap 块里（块自己的 raw 不含尾部换行）。插入时把顺序插反——段落在前、缝隙在后——
 * 编辑时完全看不出来（渲染是按块建 DOM，每块各占一行），只有在保存后的字节里才现形：
 * 新段落粘在上一块的同一行。断言「块数组里 para 在 gap 前面」是抓不到这个的
 * （原来那条测试就是这么写的，所以这个 bug 一路漏到了保存）。
 */
function gapsBetweenContentBlocks(blocks: readonly BlockView[], text: string): string[] {
  const gaps: string[] = []
  let cursor = 0
  let prevEnd: number | null = null
  for (const b of blocks) {
    if (b.kind === 'unknown' && b.raw.trim() === '') continue
    const at = text.indexOf(b.raw, cursor)
    if (at < 0) continue
    if (prevEnd !== null) gaps.push(text.slice(prevEnd, at))
    prevEnd = at + b.raw.length
    cursor = prevEnd
  }
  return gaps
}

describe('插入的块不能和相邻块粘在同一行', () => {
  test('在 H2 后插入段落：存盘后是「## 标题\\n\\n新段落」，不是「## 标题新段落」', () => {
    const s = makeSession('# 标题\n\n正文\n')
    const { ops } = makeOps(s)
    const h1 = s.blocks.find((b) => b.kind === 'heading')!
    ops.insertParagraphAfter(h1.id)
    // 用户在新段落里打字（走 setBlockRaw，与 CM 里输入等价）
    ops.setBlockRaw(s.blocks.find((b) => b.id === s.focusedId)!, '新段落')
    const text = serialize(s.blocks)
    expect(text).toContain('# 标题\n\n新段落')
    expect(text).not.toContain('# 标题新段落')
  })

  test('在块前插入段落：存盘后新段落自成一行', () => {
    const s = makeSession('# 标题\n\n正文\n')
    const { ops } = makeOps(s)
    const para = s.blocks.find((b) => b.raw === '正文')!
    ops.insertParagraphBefore(para.id)
    ops.setBlockRaw(s.blocks.find((b) => b.id === s.focusedId)!, '新段落')
    const text = serialize(s.blocks)
    expect(text).toContain('新段落\n\n正文')
    expect(text).not.toContain('新段落正文')
  })

  test('插入 mermaid 模板后同样自成一行', () => {
    const s = makeSession('# 标题\n\n正文\n')
    const { ops } = makeOps(s)
    const h1 = s.blocks.find((b) => b.kind === 'heading')!
    ops.insertMermaidAfter(h1.id)
    const text = serialize(s.blocks)
    expect(text).toMatch(/^# 标题\n\n```mermaid/)
  })

  test('文档末尾没有换行、且插在最后一块之后：仍然自成一行', () => {
    // testdata/no-trailing-newline.md 就是这种形状：末尾没有空行缝可借，
    // 插入时那对新块必须自己带缝（缝在前），不能指望后面有 gap 兜底。
    const s = makeSession('甲')
    const { ops } = makeOps(s)
    const last = s.blocks.filter((b) => b.kind !== 'unknown').at(-1)!
    ops.insertParagraphAfter(last.id)
    ops.setBlockRaw(s.blocks.find((b) => b.id === s.focusedId)!, '新段落')
    expect(serialize(s.blocks)).toBe('甲\n\n新段落')
  })

  test('所有插入路径：相邻内容块之间都隔着换行', () => {
    const s = makeSession(DOC)
    const { ops } = makeOps(s)
    const h1 = s.blocks.find((b) => b.kind === 'heading')!
    ops.insertParagraphAfter(h1.id)
    ops.setBlockRaw(s.blocks.find((b) => b.id === s.focusedId)!, '甲')
    const para = s.blocks.find((b) => b.raw === '第二段')!
    ops.insertParagraphBefore(para.id)
    ops.setBlockRaw(s.blocks.find((b) => b.id === s.focusedId)!, '乙')
    const text = serialize(s.blocks)
    const gaps = gapsBetweenContentBlocks(s.blocks, text)
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.filter((g) => !g.includes('\n'))).toEqual([])
  })
})

describe('insertParagraphBefore/After', () => {  test('插入保序，撤销只移除插入的块', () => {
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
    // 在「后」插入是缝在前、段落在后：块的 raw 不含尾部换行，换行由 gap 块持有。
    // 这条以前断言的是 [anchor, paragraph, gap]（顺序反了），那正是「新段落粘在
    // 标题同一行」的来源——块数组看着没问题，序列化出来才发现。
    expect(s.blocks[idxAfter + 1]!.kind).toBe('unknown')
    expect(s.blocks[idxAfter + 2]!.kind).toBe('paragraph')
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
    // 回到插入前的字节：'甲\n'。
    // 这条以前期望 '甲\n\n\n'——那是按「空段落排在缝前面」的旧顺序算出来的：
    // 空段被吃掉、后插的那条缝留在原地，凭空多一行。顺序修正后，Backspace
    // 撤掉的正是刚才那一次插入，一个字节都不多。
    expect(serialize(s.blocks)).toBe('甲\n')
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
