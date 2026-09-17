import {
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlockRoots,
  parseOne,
  type BlockKind,
  type BlockView,
} from '@lector/core'
import type { EditorView } from '@codemirror/view'
import { openTableEditor } from './tableEditor.ts'
import { t } from './i18n.ts'
import { createUndoStack } from './undoStack.ts'
import type { DocumentSession } from './documentSession.ts'
import type { CaretIntent } from './caretNavigation.ts'

interface BlockOperationsDeps {
  session: DocumentSession
  markDirty(): void
  render(): Promise<void>
  focusBlock(id: string, intent?: CaretIntent): void
  forgetBlockViews(removed: readonly BlockView[]): void
  focusAfterStructuralEdit(id: string | null, intent?: CaretIntent): void
  insertImageMarkdownAtCaret(md: string): void
  onUndo(label: string): void
}

export function createBlockOperations({
  session,
  markDirty,
  render,
  focusBlock,
  forgetBlockViews,
  focusAfterStructuralEdit,
  insertImageMarkdownAtCaret,
  onUndo,
}: BlockOperationsDeps) {
  let seq = 0
  function nextId(): string {
    seq += 1
    return `e${seq}`
  }

  // ───────────── 块级操作（右键菜单用） ─────────────
  // 与 splitBlock/mergeBlock 同一套约定：改 session.blocks、标 structuralDirty、
  // 同步 originals、重新 render。写盘仍由 serialize 按块拼装，所以这里不碰原文偏移。

  /** 找到块在 session.blocks 里的下标。 */
  function blockIndex(id: string): number {
    return session.blocks.findIndex((b) => b.id === id)
  }

  /** 合成一个空段落块与其后的空白缝。 */
  function makeEmptyParagraph(at: number): { para: BlockView; gap: BlockView } {
    const para: BlockView = {
      id: nextId(),
      kind: 'paragraph',
      start: at,
      end: at,
      raw: '',
      mdast: parseOne(''),
      dirty: true,
    }
    const gap: BlockView = {
      id: nextId(),
      kind: 'unknown',
      start: at,
      end: at,
      raw: '\n\n',
      mdast: null,
      dirty: true,
    }
    return { para, gap }
  }

  /** 在块后插入空段落并聚焦，方便直接开始写。 */
  function insertParagraphAfter(id: string): void {
    const i = blockIndex(id)
    if (i < 0) return
    const at = session.blocks[i]!.end
    const { para, gap } = makeEmptyParagraph(at)
    // **顺序是「缝在前、段落在后」**：块的 raw 不含尾部换行，块之间的换行住在 gap 块里。
    // 插反（para, gap）的后果是序列化出 `## 标题新段落`——渲染按块建 DOM，编辑时
    // 每块各占一行，完全看不出来，只有存盘再打开才现形（更早还有一份 bug 就是这么漏的）。
    session.blocks.splice(i + 1, 0, gap, para)
    session.originals.set(para.id, para.raw)
    session.originals.set(gap.id, gap.raw)
    blockUndoStack.push(t('menuUndoInsert'), () => {
      const removed = takeBlocks([para.id, gap.id])
      if (removed.length) forgetBlocks(removed)
    })
    session.structuralDirty = true
    markDirty()
    render()
    focusBlock(para.id)
  }

  /** 在块前插入空段落并聚焦。 */
  function insertParagraphBefore(id: string): void {
    const i = blockIndex(id)
    if (i < 0) return
    const at = session.blocks[i]!.start
    const { para, gap } = makeEmptyParagraph(at)
    session.blocks.splice(i, 0, para, gap)
    session.originals.set(para.id, para.raw)
    session.originals.set(gap.id, gap.raw)
    blockUndoStack.push(t('menuUndoInsert'), () => {
      const removed = takeBlocks([para.id, gap.id])
      if (removed.length) forgetBlocks(removed)
    })
    session.structuralDirty = true
    markDirty()
    render()
    focusBlock(para.id)
  }

  /** 在块后插入 mermaid 模板并聚焦：骨架给足，改两笔就是一张能看的图。 */
  function insertMermaidAfter(id: string): void {
    const i = blockIndex(id)
    if (i < 0) return
    const at = session.blocks[i]!.end
    const raw = t('mermaidTemplate')
    const block: BlockView = {
      id: nextId(),
      kind: 'code',
      start: at,
      end: at,
      raw,
      mdast: parseOne(raw),
      dirty: true,
    }
    const gap: BlockView = {
      id: nextId(),
      kind: 'unknown',
      start: at,
      end: at,
      raw: '\n\n',
      mdast: null,
      dirty: true,
    }
    // 同 insertParagraphAfter：缝要在块之前，否则 mermaid 围栏会粘在上一块的行尾
    session.blocks.splice(i + 1, 0, gap, block)
    session.originals.set(block.id, block.raw)
    session.originals.set(gap.id, gap.raw)
    blockUndoStack.push(t('menuUndoInsert'), () => {
      const removed = takeBlocks([block.id, gap.id])
      if (removed.length) forgetBlocks(removed)
    })
    session.structuralDirty = true
    markDirty()
    render()
    focusBlock(block.id)
  }

  /**
   * 块级撤销栈。
   *
   * 右键菜单能一键删掉整块，而 CodeMirror 的 undo 只管聚焦块内部——
   * 删完就没有后悔药了。对一个「文件是唯一真相」的产品来说这是不能留的风险，
   * 所以删除、插入、勾选都压栈，⌘Z（且不在编辑器里）时撤回。
   *
   * 每项是一个「怎么退回去」的闭包而不是快照：闭包带着操作发生时的位置和对象身份，
   * 退回去时不必猜「当时它是第几块」。
   *
   * 只压结构操作，不压文字编辑（那是 CM 的事）。栈上限 20，够用且不积内存。
   */
  const BLOCK_UNDO_MAX = 20
  const blockUndoStack = createUndoStack(BLOCK_UNDO_MAX)

  /** 把一批块插回原位（撤销删除用）。 */
  function restoreBlocks(at: number, blocks: BlockView[]): void {
    const index = Math.max(0, Math.min(at, session.blocks.length))
    session.blocks.splice(index, 0, ...blocks)
    for (const b of blocks) {
      if (!session.originals.has(b.id)) session.originals.set(b.id, b.raw)
    }
    session.structuralDirty = true
  }

  /** 块离开会话后，DOM、聚焦中的 CM、原文缓存都不能留下孤儿。 */
  function forgetBlocks(removed: BlockView[]): void {
    for (const r of removed) {
      session.originals.delete(r.id)
    }
    forgetBlockViews(removed)
  }

  /** 按 id 摘块（撤销插入用），其余块保持相对顺序。 */
  function takeBlocks(ids: string[]): BlockView[] {
    const wanted = new Set(ids)
    const removed: BlockView[] = []
    session.blocks = session.blocks.filter((b) => {
      if (!wanted.has(b.id)) return true
      removed.push(b)
      return false
    })
    return removed
  }

  /** 弹一次撤销并重绘；没有可撤的就返回 false，让 ⌘Z 回到正常路径。 */
  function undoBlockOp(): boolean {
    const label = blockUndoStack.undo()
    if (label === null) return false
    markDirty()
    render()
    onUndo(label)
    return true
  }

  /**
   * 删除块。
   *
   * 连同其后紧邻的空白缝一起删掉——只删内容会留下孤立的空行，
   * 用户看到的是「删了但版面又多空了一截」。
   * 首块删掉时把「前置」缝也带走（缝在它前面）。
   */
  function deleteBlock(id: string): void {
    const i = blockIndex(id)
    if (i < 0) return
    const block = session.blocks[i]!
    // 最后一个内容块不可删：删了文档就没有任何可编辑表面，连「点一下开始写」
    // 都做不到。退化为清空内容（等价记事本的「全选删除」）——块还在、可写、可撤销。
    if (session.blocks.filter((b) => !isWhitespaceGap(b)).length <= 1) {
      const before = block.raw
      const beforeKind = block.kind
      const beforeMdast = block.mdast
      block.raw = ''
      block.mdast = parseOne('')
      block.kind = 'paragraph'
      block.dirty = (session.originals.get(block.id) ?? '') !== ''
      blockUndoStack.push(t('menuUndoBlock'), () => {
        block.raw = before
        block.kind = beforeKind
        block.mdast = beforeMdast
        block.dirty = block.raw !== (session.originals.get(block.id) ?? '')
      })
      markDirty()
      render()
      focusBlock(block.id)
      return
    }
    const isGap = (b: BlockView | undefined) => b?.kind === 'unknown' && b.raw.trim() === ''
    let from = i
    let count = 1
    if (isGap(session.blocks[i + 1])) {
      count += 1 // 带走后面的缝
    } else if (isGap(session.blocks[i - 1])) {
      from = i - 1
      count += 1 // 末块：带走前面的缝
    }
    const removed = session.blocks.splice(from, count)
    blockUndoStack.push(t('menuUndoBlock'), () => restoreBlocks(from, removed))
    forgetBlocks(removed)
    session.structuralDirty = true
    markDirty()
    render()
  }

  /** 把块的原文写回并标脏（用于任务勾选这类「只改一小处」的操作）。 */
  function setBlockRaw(block: BlockView, raw: string): void {
    block.raw = raw
    const original = session.originals.get(block.id) ?? ''
    block.dirty = raw !== original
    const roots = parseBlockRoots(raw)
    block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
    block.kind = kindFromMdast(roots[0]) as BlockKind
    markDirty()
  }

  /**
   * 勾选/取消任务项。
   *
   * 列表整块是一个 block，所以要按「渲染出来的第 n 个任务项」去源码里找第 n 个
   * `- [ ]` 行。用序号对应而不是文本匹配：两条任务文字相同时文本匹配会改错行。
   */
  function toggleTaskItem(block: BlockView, itemIndex: number, checked: boolean): void {
    const lines = block.raw.split('\n')
    let seen = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)/)
      if (!m) continue
      if (seen === itemIndex) {
        const before = block.raw
        lines[i] = `${m[1]}${checked ? 'x' : ' '}${m[3]}${lines[i]!.slice(m[0].length)}`
        setBlockRaw(block, lines.join('\n'))
        // 勾错了要能撤回来。勾选不经过 CM，所以得自己进撤销链。
        blockUndoStack.push(t('menuUndoCheck'), () => setBlockRaw(block, before))
        render()
        return
      }
      seen += 1
    }
  }


  // ───────────── 表格网格编辑 ─────────────
  // 表格是「结构上想网格、存储上要源码」的典型：弹窗管网格，写回走块原文。

  /** 网格弹窗的结果写回块原文，并进块级撤销链（表格不经过 CM，得自己进）。 */
  function applyTableMarkdown(block: BlockView, md: string): void {
    if (md === block.raw) return
    const before = block.raw
    setBlockRaw(block, md)
    blockUndoStack.push(t('menuUndoTable'), () => setBlockRaw(block, before))
    render()
  }

  function openTableForBlock(block: BlockView): void {
    openTableEditor({
      source: block.raw,
      onDone: (md) => applyTableMarkdown(block, md),
      onEditSource: (md) => {
        applyTableMarkdown(block, md)
        // 网格不够用时的退路：写回网格结果后切到该块的源码编辑
        focusBlock(block.id)
      },
    })
  }

  /** 聚焦段末回车 → 分裂成两段（前段 + 空段）。返回 true 表示已处理。 */
  function splitBlock(block: BlockView, view: EditorView): boolean {
    const doc = view.state.doc.toString()
    const pos = view.state.selection.main.head
    if (block.kind !== 'paragraph' && block.kind !== 'heading') return false
    if (pos !== doc.length) return false // 只在块末分裂，规避光标映射复杂度
    const i = session.blocks.findIndex((b) => b.id === block.id)
    if (i < 0) return false
    // 其后应是空白缝（段落间必有）
    const gap = session.blocks[i + 1]
    if (!gap || gap.kind !== 'unknown' || gap.raw.trim() !== '') return false
    const gapRaw = gap.raw || '\n\n'
    const emptyPara: BlockView = {
      id: nextId(),
      kind: 'paragraph',
      start: gap.start,
      end: gap.start,
      raw: '',
      mdast: parseOne(''),
      dirty: true,
    }
    const extraGap: BlockView = {
      id: nextId(),
      kind: 'unknown',
      start: gap.start,
      end: gap.start,
      raw: gapRaw,
      mdast: null,
      dirty: true,
    }
    session.blocks.splice(i + 2, 0, emptyPara, extraGap)
    session.originals.set(emptyPara.id, emptyPara.raw)
    session.originals.set(extraGap.id, extraGap.raw)
    session.structuralDirty = true
    focusAfterStructuralEdit(emptyPara.id)
    return true
  }

  /** 空段块首 Backspace → 删除该空段并上移，与上方内容块合并。 */
  function mergeBlock(block: BlockView, view: EditorView): boolean {
    const doc = view.state.doc.toString()
    if (doc.trim() !== '') return false
    if (view.state.selection.main.head !== 0) return false
    const i = session.blocks.findIndex((b) => b.id === block.id)
    if (i < 0) return false
    // 删除该空段与其前的空白缝
    const remove: number[] = []
    let prevContent: BlockView | null = null
    for (let k = i - 1; k >= 0; k--) {
      const b = session.blocks[k]!
      if (b.kind === 'unknown') {
        remove.push(k)
      } else {
        prevContent = b
        break
      }
    }
    remove.push(i)
    for (const k of remove.sort((a, b) => b - a)) {
      session.blocks.splice(k, 1)
    }
    session.structuralDirty = true
    focusAfterStructuralEdit(prevContent?.id ?? null, prevContent ? { mode: 'end' } : undefined)
    return true
  }

  function appendImageParagraph(md: string) {
    const onlyEmpty =
      session.blocks.length === 1 &&
      session.blocks[0] &&
      isFocusableBlock(session.blocks[0]) &&
      session.blocks[0].raw === ''
    if (onlyEmpty) {
      const b = session.blocks[0]!
      b.raw = md
      b.dirty = true
      b.mdast = parseOne(md)
      b.kind = kindFromMdast(b.mdast)
      markDirty()
      render()
      return
    }
    const last = session.blocks[session.blocks.length - 1]
    if (last && !isWhitespaceGap(last)) {
      const gapId = nextId()
      session.blocks.push({
        id: gapId,
        kind: 'unknown',
        start: 0,
        end: 0,
        raw: '\n\n',
        mdast: null,
        dirty: true,
      })
      session.originals.set(gapId, '')
    }
    const para: BlockView = {
      id: nextId(),
      kind: 'paragraph',
      start: 0,
      end: 0,
      raw: md,
      mdast: parseOne(md),
      dirty: true,
    }
    session.blocks.push(para)
    session.originals.set(para.id, '')
    session.structuralDirty = true
    markDirty()
    render()
  }

  /** 在某一块之后追加一个图片段落（专门给「拖到文档中间」用）。 */
  function insertAfterBlock(blockId: string, md: string) {
    const i = session.blocks.findIndex((b) => b.id === blockId)
    if (i < 0) return insertImageMarkdownAtCaret(md)
    const gapId = nextId()
    session.blocks.splice(i + 1, 0, {
      id: gapId,
      kind: 'unknown',
      start: 0,
      end: 0,
      raw: '\n\n',
      mdast: null,
      dirty: true,
    })
    session.originals.set(gapId, '')
    const para: BlockView = {
      id: nextId(),
      kind: 'paragraph',
      start: 0,
      end: 0,
      raw: md,
      mdast: parseOne(md),
      dirty: true,
    }
    session.blocks.splice(i + 2, 0, para)
    session.originals.set(para.id, '')
    session.structuralDirty = true
    markDirty()
    render()
  }

  return {
    makeEmptyParagraph,
    insertParagraphBefore,
    insertParagraphAfter,
    insertMermaidAfter,
    deleteBlock,
    setBlockRaw,
    toggleTaskItem,
    openTableForBlock,
    undoBlockOp,
    splitBlock,
    mergeBlock,
    appendImageParagraph,
    insertAfterBlock,
    pushUndo: blockUndoStack.push,
  }
}

export type BlockOperations = ReturnType<typeof createBlockOperations>
