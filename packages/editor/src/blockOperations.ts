import {
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlockRoots,
  parseOne,
  type BlockKind,
  type BlockView,
  type DefinitionSet,
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
  /** 渐进解析未完成时先排空块表，再做拆块 / 插入 / 删除。 */
  beforeStructuralEdit?: () => void
  /** 整篇定义集。单块重解析不带它时，引用链接和脚注会退化成字面量。 */
  getDefinitions?: () => DefinitionSet
  /**
   * 把整篇正文换掉（切档撤销用）。
   *
   * 块表和整篇 CM 是两种承载，只有 documentEditor 知道当前该走哪一条，
   * 所以这里只要一个「把文档变成这段正文」的黑盒。
   */
  replaceWholeDocument?: (raw: string) => void
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
  beforeStructuralEdit,
  getDefinitions,
  replaceWholeDocument,
}: BlockOperationsDeps) {
  function reparseRoots(raw: string): unknown[] {
    return parseBlockRoots(raw, getDefinitions?.())
  }
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
    beforeStructuralEdit?.()
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
    beforeStructuralEdit?.()
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
    beforeStructuralEdit?.()
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
  /**
   * 切档快照的体积上限：每条是一整篇正文，IR 档能开到 20MB，
   * 20 条快照就是几百 MB 内存。超过就不记——这一步撤销宁可没有。
   */
  const MODE_SNAPSHOT_MAX_CHARS = 1_000_000

  /**
   * 切档撤销栈：一条记录 = 「把整篇还原成切档前的那段正文」。
   *
   * 为什么不能只靠 CodeMirror 的历史：历史住在**某一份 EditorState** 里。
   * 聚焦块有自己的一份，源码档有自己的一份，两不相通——在 A 里改的字，
   * B 那份历史根本没见过。所以「切档后还能⌘Z」不可能从 CM 那里要来，
   * 只能在边界上自己存一份整篇快照。
   *
   * 颗粒度刻意做成「一次切档 = 一步撤销」：切档是个明确的心智边界，
   * 用户按 ⌘Z 期望的是「回到刚才那样」，而不是逐字倒放另一档里的输入。
   */
  const modeUndoStack = createUndoStack(BLOCK_UNDO_MAX)

  /** 把一批块插回原位（撤销删除用）。 */
  function restoreBlocks(at: number, blocks: BlockView[]): void {
    beforeStructuralEdit?.()
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

  /**
   * 记下「切档前的整篇正文」，供切档后 ⌘Z 还原。
   *
   * @param before 切档前的整篇正文（原文形态）
   */
  function pushModeSwitchUndo(before: string): void {
    if (!replaceWholeDocument) return
    // 超上限不记这一条还不够，必须清栈：留着更早的快照，下一次 ⌘Z 会把
    // 更早的正文盖到这段没有留下快照的新编辑上——等于用旧内容改写文件。
    if (before.length > MODE_SNAPSHOT_MAX_CHARS) {
      modeUndoStack.clear()
      return
    }
    modeUndoStack.push(t('menuUndoModeSwitch'), () => replaceWholeDocument(before))
  }

  /** 弹一条切档撤销；没有就返回 false，让 ⌘Z 回到正常路径。 */
  function undoModeSwitch(): boolean {
    const label = modeUndoStack.undo()
    if (label === null) return false
    onUndo(label)
    return true
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
   * 换文档 / 关文档：两条撤销栈都属于上一篇。
   * 留着的话，打开 B 之后按 ⌘Z 会把 A 的整篇正文 replaceWholeDocument 进 B，
   * 脏标记一翻，⌘S 就把 A 写进了 B 的文件。
   */
  function clearUndo(): void {
    blockUndoStack.clear()
    modeUndoStack.clear()
  }

  /**
   * 块级撤销项只对「记录时的那张块表」有效：闭包里记着旧块的对象与下标。
   * 块表重建（整篇重解析 / 切档快照落回块档）之后它们指向不存在的块，
   * 必须丢掉——撤错了比没的撤更糟（核心红线：磁盘字节不能被误写）。
   */
  function discardBlockOps(): void {
    blockUndoStack.clear()
  }

  /**
   * 删除块。
   *
   * 连同其后紧邻的空白缝一起删掉——只删内容会留下孤立的空行，
   * 用户看到的是「删了但版面又多空了一截」。
   * 首块删掉时把「前置」缝也带走（缝在它前面）。
   */
  function deleteBlock(id: string): void {
    if (blockIndex(id) < 0) return
    // 排空可能合并折叠块、换掉下标，所以下标要在排空之后再取。
    beforeStructuralEdit?.()
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
    const roots = reparseRoots(raw)
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

  /**
   * 引用 / 列表想再写一行，第一次回车仍留在块里。
   * 末尾已经是空行，或最后一行只剩引用符 / 列表记号时，再按回车是离开这块，
   * 到后面新开一段。代码块里的空行是内容，不走这里。
   */
  function exitContainerRaw(kind: BlockKind, doc: string): string | null {
    if (kind !== 'blockquote' && kind !== 'list') return null
    const nl = doc.lastIndexOf('\n')
    if (nl < 0) return null
    const last = doc.slice(nl + 1)
    const blankLine = last === ''
    const emptyQuote = kind === 'blockquote' && /^>{1,}\s*$/.test(last)
    const emptyItem = kind === 'list' && /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?$/.test(last)
    if (!blankLine && !emptyQuote && !emptyItem) return null
    const kept = doc.slice(0, nl)
    if (kept.trim() === '') return null
    return kept
  }

  /** 聚焦段末回车 → 在后面开一段空段落。段落和标题在块末直接离开；引用和列表要先多出一行空行。 */
  function splitBlock(block: BlockView, view: EditorView): boolean {
    // IME 组合期间的 Enter 是确认候选，不是拆块（同 caretNavigation 的 composition 守卫）
    if (view.composing) return false
    const doc = view.state.doc.toString()
    const pos = view.state.selection.main.head
    if (pos !== doc.length || !view.state.selection.main.empty) return false
    const exiting = exitContainerRaw(block.kind, doc)
    if (block.kind !== 'paragraph' && block.kind !== 'heading' && exiting === null) return false
    // ``` 回车要展开成代码块。那条绑定优先级更低，这里让开。
    const lineStart = doc.lastIndexOf('\n', Math.max(0, pos - 1)) + 1
    if (/^\s*```\s*$/.test(doc.slice(lineStart))) return false
    beforeStructuralEdit?.()
    const i = session.blocks.findIndex((b) => b.id === block.id)
    if (i < 0) return false
    // 其后应是空白缝（段落间必有）
    const gap = session.blocks[i + 1]
    if (!gap || gap.kind !== 'unknown' || gap.raw.trim() !== '') return false
    if (exiting !== null) {
      block.raw = exiting
      const roots = reparseRoots(exiting)
      block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
      block.kind = kindFromMdast(roots[0]) as BlockKind
      block.dirty = exiting !== (session.originals.get(block.id) ?? '')
    }
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
    // IME 组合期间的 Backspace 是删候选拼音，不是合块（同 caretNavigation 的 composition 守卫）
    if (view.composing) return false
    const doc = view.state.doc.toString()
    if (doc.trim() !== '') return false
    if (view.state.selection.main.head !== 0) return false
    beforeStructuralEdit?.()
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
    beforeStructuralEdit?.()
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
    beforeStructuralEdit?.()
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
    pushModeSwitchUndo,
    undoModeSwitch,
    clearUndo,
    discardBlockOps,
    splitBlock,
    mergeBlock,
    appendImageParagraph,
    insertAfterBlock,
    pushUndo: blockUndoStack.push,
  }
}

export type BlockOperations = ReturnType<typeof createBlockOperations>
