import { describe, expect, test } from 'bun:test'
import { parseBlocks, serialize, type BlockView } from '@lector/core'
import { applySourceSpan, coveredSource, type SpanPoint } from '../src/sourceSpan.ts'
import { sourceKeyAction } from '../src/sourceSelection.ts'
import { createBlockOperations } from '../src/blockOperations.ts'
import { sessionIsDirty } from '../src/sessionDirty.ts'
import { createSourceDocument } from '@lector/core'
import type { DocumentSession } from '../src/documentSession.ts'
import type { CaretIntent } from '../src/caretNavigation.ts'

const DOC = '# 标题\n\nhello world\n\nfoo bar\n\n- item\n'

function ids() {
  let n = 0
  return () => `n${n++}`
}

function point(blocks: readonly BlockView[], raw: string, offset: number): SpanPoint {
  const index = blocks.findIndex((block) => block.raw === raw)
  if (index < 0) throw new Error(`missing block ${raw}`)
  return { index, offset }
}

describe('applySourceSpan', () => {
  test('跨块删除去掉中间空白缝，没碰到的块还是原来的对象', () => {
    const blocks = parseBlocks(DOC)
    const heading = blocks.find((block) => block.raw.startsWith('# '))!
    const list = blocks.find((block) => block.kind === 'list')!
    const start = point(blocks, 'hello world', 6)
    const end = point(blocks, 'foo bar', 4)
    const next = applySourceSpan(blocks, start, end, '', ids())
    expect(next).not.toBeNull()
    expect(serialize(next!.blocks)).toBe('# 标题\n\nhello bar\n\n- item\n')
    expect(next!.blocks.find((block) => block.raw.startsWith('# '))!).toBe(heading)
    expect(next!.blocks.find((block) => block.kind === 'list')!).toBe(list)
    const joined = next!.blocks.find((block) => block.raw === 'hello bar')!
    expect(next!.caretIndex).toBe(next!.blocks.indexOf(joined))
    expect(next!.caretPos).toBe(6)
  })

  test('替换选区后光标在插入文字之后', () => {
    const blocks = parseBlocks(DOC)
    const start = point(blocks, 'hello world', 6)
    const end = point(blocks, 'foo bar', 4)
    const next = applySourceSpan(blocks, start, end, 'X', ids())
    expect(serialize(next!.blocks)).toBe('# 标题\n\nhello Xbar\n\n- item\n')
    expect(next!.caretPos).toBe(7)
  })

  test('块内选区只改这一块', () => {
    const blocks = parseBlocks(DOC)
    const hello = blocks.find((block) => block.raw === 'hello world')!
    const index = blocks.indexOf(hello)
    const next = applySourceSpan(blocks, { index, offset: 0 }, { index, offset: 5 }, '', ids())
    expect(serialize(next!.blocks)).toBe('# 标题\n\n world\n\nfoo bar\n\n- item\n')
    expect(next!.blocks.filter((block) => block !== hello).length).toBeGreaterThan(0)
    expect(blocks.filter((block) => block !== hello).every((block) => next!.blocks.includes(block))).toBe(true)
  })

  test('删光整篇留下一个空段落', () => {
    const blocks = parseBlocks('只有一段\n')
    const next = applySourceSpan(
      blocks,
      { index: 0, offset: 0 },
      { index: blocks.length - 1, offset: blocks[blocks.length - 1]!.raw.length },
      '',
      ids(),
    )
    expect(serialize(next!.blocks)).toBe('')
    expect(next!.blocks.some((block) => block.kind === 'paragraph')).toBe(true)
    expect(next!.caretPos).toBe(0)
  })

  test('选区为空时不改', () => {
    const blocks = parseBlocks(DOC)
    const index = blocks.findIndex((block) => block.raw === 'hello world')
    expect(applySourceSpan(blocks, { index, offset: 2 }, { index, offset: 2 }, '', ids())).toBeNull()
  })

  test('coveredSource 含中间的换行缝', () => {
    const blocks = parseBlocks(DOC)
    const text = coveredSource(blocks, point(blocks, 'hello world', 6), point(blocks, 'foo bar', 3))
    expect(text).toBe('world\n\nfoo')
  })

  test('混合换行的块按 raw 偏移切，没删到的 \\r 还在', () => {
    const blocks: BlockView[] = [
      { id: 'a', kind: 'paragraph', start: 0, end: 5, raw: 'ab\rcd', mdast: null, dirty: false },
      { id: 'g', kind: 'unknown', start: 5, end: 7, raw: '\n\n', mdast: null, dirty: false },
      { id: 'b', kind: 'paragraph', start: 7, end: 10, raw: 'xyz', mdast: null, dirty: false },
    ]
    const next = applySourceSpan(blocks, { index: 0, offset: 4 }, { index: 2, offset: 1 }, '', ids())
    expect(serialize(next!.blocks)).toBe('ab\rcyz')
    expect(serialize(blocks)).toBe('ab\rcd\n\nxyz')
  })
})

describe('sourceKeyAction', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, isComposing: false }
  test('删除和退格换成空串', () => {
    expect(sourceKeyAction({ ...base, key: 'Backspace' })).toEqual({ kind: 'replace', text: '' })
    expect(sourceKeyAction({ ...base, key: 'Delete' })).toEqual({ kind: 'replace', text: '' })
  })
  test('普通字符和回车会替换选区', () => {
    expect(sourceKeyAction({ ...base, key: 'a' })).toEqual({ kind: 'replace', text: 'a' })
    expect(sourceKeyAction({ ...base, key: 'Enter' })).toEqual({ kind: 'replace', text: '\n' })
  })
  test('快捷键和输入法组合不拦截', () => {
    expect(sourceKeyAction({ ...base, key: 's', metaKey: true }).kind).toBe('ignore')
    expect(sourceKeyAction({ ...base, key: 'a', isComposing: true }).kind).toBe('ignore')
    expect(sourceKeyAction({ ...base, key: 'ArrowLeft' }).kind).toBe('ignore')
  })
})

describe('replaceSourceSpan', () => {
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
    session.originals = new Map(session.blocks.map((block) => [block.id, block.raw] as const))
    return session
  }

  test('删完能撤销回原来的字节', () => {
    const session = makeSession(DOC)
    const focus: { id: string | null; intent: CaretIntent | undefined }[] = []
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
        focus.push({ id, intent })
        session.focusedId = id
      },
      insertImageMarkdownAtCaret: () => {},
      onUndo: () => {},
    })
    const hello = session.blocks.find((block) => block.raw === 'hello world')!
    const foo = session.blocks.find((block) => block.raw === 'foo bar')!
    expect(
      ops.replaceSourceSpan({
        startId: hello.id,
        startOffset: 6,
        endId: foo.id,
        endOffset: 4,
        replacement: '',
      }),
    ).toBe(true)
    expect(serialize(session.blocks)).toBe('# 标题\n\nhello bar\n\n- item\n')
    expect(focus[0]?.intent).toEqual({ mode: 'pos', pos: 6 })
    expect(ops.undoBlockOp()).toBe(true)
    expect(serialize(session.blocks)).toBe(DOC)
  })
})
