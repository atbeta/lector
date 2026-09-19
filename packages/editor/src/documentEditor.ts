import {
  createSourceDocument,
  adjacentFocusableId,
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlocks,
  parseBlockRoots,
  serialize,
  type BlockKind,
  type BlockView,
} from '@lector/core'
import type { EditorView } from '@codemirror/view'
import { mountEditor, type CmHandle } from './cm.ts'
import { renderBlockHtml, preRenderMath } from './mdastHtml.ts'
import { iconSvg } from './icons.ts'
import { mermaidLanguage } from './mermaidLanguage.ts'
import { createMermaidLivePanel, type MermaidLivePanel } from './mermaidLive.ts'
import { setCurrentMdPath } from './asset.ts'
import { getSettings } from './settings.ts'
import { findBar, closeFindBar } from './findBar.ts'
import { replaceFind } from './findMatch.ts'
import { showToast } from './feedback.ts'
import { decorateCodeBlock, teardownCodePreview, whenCodePreviewIdle } from './codePreview.ts'
import { headingDepth, outlineNeedsRefresh } from './outlineModel.ts'
import { showSvgInLightbox } from './lightbox.ts'
import { closeSelectionBubble, openSelectionBubble } from './selectionBubble.ts'
import { applyKeyedChildren } from './reconcile.ts'
import { blockPaintSurface, sameBlockPaint, type BlockPaint } from './blockPaint.ts'
import { sessionIsDirty } from './sessionDirty.ts'
import { t } from './i18n.ts'
import { createDocumentSession, type DocumentSession } from './documentSession.ts'
import { type CaretIntent, placeCaret, caretX, atVisualVerticalEdge, atHorizontalEdge } from './caretNavigation.ts'
import { createBlockOperations, type BlockOperations } from './blockOperations.ts'
import { createLargeDocument } from './largeDocument.ts'
import type { ViewMode } from './editorChrome.ts'

interface DocumentEditorDeps {
  contentEl: HTMLElement
  getViewMode(): ViewMode
  setViewMode(mode: ViewMode): void
  forceSourceMode(): void
  setDocumentTitle(path: string): void
  setDocPresent(present: boolean): void
  beforeDirty(): void
  onDirty(): void
  resetOutline(): void
  renderOutline(): void
  restoreReadingPosition(): void
  scheduleRecordPosition(): void
}

export interface DocumentEditor {
  getSession(): Readonly<DocumentSession>
  getCmView(): EditorView | null
  isLarge(): boolean
  getLargeInfo(): { bytes: number; totalLines: number }
  activeScroller(): HTMLElement | null
  getBlockElement(id: string): HTMLElement | undefined
  loadSession(path: string, raw: string, mtimeMs?: number, byteLen?: number): void
  render(): Promise<void>
  focusBlock(id: string, intent?: CaretIntent): void
  defocus(): void
  finalizeFocused(): void
  markDirty(opts?: { fromTyping?: boolean; kind?: string }): void
  markStructuralDirty(): void
  allRawText(): string
  getNormalizedText(): string
  retargetSource(path: string): void
  markSaved(normalized: string, mtimeMs: number | undefined): void
  resetDocument(): void
  clearBlocks(): void
  clearBlockElements(): void
  acceptDiskMtime(mtimeMs: number): void
  insertImageMarkdownAtCaret(md: string): void
  openFind(): void
  operations: BlockOperations
}

export function createDocumentEditor({
  contentEl,
  getViewMode,
  setViewMode,
  forceSourceMode,
  setDocumentTitle,
  setDocPresent,
  beforeDirty,
  onDirty,
  resetOutline,
  renderOutline,
  restoreReadingPosition,
  scheduleRecordPosition,
}: DocumentEditorDeps): DocumentEditor {
  const session = createDocumentSession()
  const blocksEl = new Map<string, HTMLElement>()
  /**
   * 上一轮每个块真正画进 DOM 的形态。勾选 / 聚焦 / 切档都会走 render()，
   * 但阅读档和编辑档的未聚焦块是同一份预览——把 data-mode 写进判定会让
   * 「点一块」或「切回阅读」拆掉整篇 mermaid 和图。raw / kind / 表面没变就跳过。
   */
  const lastPaint = new Map<string, BlockPaint>()
  let cm: CmHandle | null = null
  const liveText = new Map<string, string>()
  /** 空文档合成出的那个空段落的 id：渲染落地后要进编辑档并聚焦它（见 loadSession）。 */
  let pendingEmptyFocus: string | null = null
  let caretIntent: CaretIntent | null = null
  /** 聚焦中的 mermaid 实时预览面板；块失焦/切换时随 CM 一起销毁。 */
  let mermaidPanel: MermaidLivePanel | null = null

  const large = createLargeDocument({
    contentEl,
    getSourceText: () => session.source?.text ?? '',
    onDirty: () => markDirty(),
    onScroll: () => scheduleRecordPosition(),
  })

  const operations = createBlockOperations({
    session,
    markDirty: () => markDirty(),
    render: () => render(),
    focusBlock: (id, intent) => focusBlock(id, intent),
    forgetBlockViews: (removed) => forgetBlockViews(removed),
    focusAfterStructuralEdit: (id, intent) => focusAfterStructuralEdit(id, intent),
    insertImageMarkdownAtCaret: (md) => insertImageMarkdownAtCaret(md),
    onUndo: (label) => showToast(label),
  })

  /** 当前正文的滚动容器：普通档是 #content，大文件档是 CM 自己的滚动层。 */
  function activeScroller(): HTMLElement | null {
    if (large.isActive()) return large.getView()?.scrollDOM ?? null
    return contentEl
  }

  let containGen = 0

  /** 首屏（含 mermaid）量完真实高度后再开 content-visibility，大纲位置才不会漂。 */
  function scheduleBlockContainment(): void {
    contentEl.classList.remove('blocks-cv')
    const gen = ++containGen
    void whenCodePreviewIdle()
      .then(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
      )
      .then(() => {
        if (gen !== containGen || !session.source || large.isActive()) return
        contentEl.classList.add('blocks-cv')
      })
  }

  function markDirty(opts?: { fromTyping?: boolean; kind?: string }) {
    // 编辑可能增删标题、改级别或改文字（分裂/合并会换 id），
    // 大纲不重建就会指着一批不存在的块——表现为高亮消失、点击无反应。
    // 段落打字只改 raw，签名不会变，不必每键扫 50 个标题。
    if (!opts?.fromTyping || outlineNeedsRefresh(opts.kind, false)) beforeDirty()
    session.dirty = large.isActive() ? large.isDirty() : sessionIsDirty(session.blocks, session.structuralDirty)
    // 显隐交给样式（html.dirty .dirty-dot），这里只翻一个类，避免两处真相
    document.documentElement.classList.toggle('dirty', session.dirty)
    onDirty()
  }

  function markStructuralDirty(): void {
    session.structuralDirty = true
    markDirty()
  }

  function loadSession(path: string, raw: string, mtimeMs = Date.now(), byteLen?: number) {
    // 换文档先关掉查找栏：它属于上一篇——留着会拿旧查询去搜新文档，
    // 高亮还要等下一次 refresh 才重画，中间那一眼是自相矛盾的。
    closeFindBar()
    if (cm) {
      cm.destroy()
      cm = null
    }
    large.destroy()
    blocksEl.clear()
    lastPaint.clear()
    liveText.clear()
    containGen++
    contentEl.classList.remove('large-doc', 'blocks-cv')
    document.documentElement.classList.remove('large-file')
    session.source = createSourceDocument(path, raw, mtimeMs)
    setCurrentMdPath(session.source.path)
    // 大文件逃生舱：超阈值就不解析、不建块，整篇交给一个裸 CM（见上方注释）。
    // 字节数由壳给出（read_file 的 byte_len）；浏览器预览退回 Blob 大小。
    const bytes = byteLen ?? new Blob([raw]).size
    if (large.configure(session.source.text, bytes)) {
      session.blocks = []
      session.originals = new Map()
      session.focusedId = null
      session.dirty = false
      session.structuralDirty = false
    } else {
      session.blocks = parseBlocks(session.source.text)
      // 空文件必须**仍然是一份可编辑的文档**：整篇没有块时合成一个空段落。
      // "没打开文件"是两件事，界面上不能表现成同一件事（记事本、Typora 都允许空文件直接打字）。
      // 放在 originals 之前：合成出来的块也要进基线，否则一打开就是"未保存"。
      if (session.blocks.length === 0) {
        const { para, gap } = operations.makeEmptyParagraph(0)
        session.blocks = [para, gap]
        pendingEmptyFocus = para.id
      }
      session.originals = new Map(session.blocks.map((b) => [b.id, b.raw] as const))
      // 空文档（整篇没有任何非空内容）→ 渲染落地后进编辑档并聚焦。
      // 判据不能用"块数为 0"：空的 .md 在不同版本里可能产出 0 块或 1 个空块，
      // 而用户看到的问题是同一个——**一个可见表面都没有，点不到也打不了字**。
      if (session.blocks.length > 0 && session.blocks.every((b) => b.raw.trim() === '')) {
        pendingEmptyFocus = session.blocks[0]?.id ?? null
      }
      session.focusedId = null
      session.dirty = false
      session.structuralDirty = false
    }
    setDocumentTitle(path)
    contentEl.innerHTML = ''
    contentEl.scrollTop = 0
    // 有文档了就把「纸页」表面还回来（空态撤掉的纸面底色与描边，见 loadState.ts）
    document.documentElement.classList.remove('is-empty')
    // 冷启动带 argv / 点打开的加载态也要收掉，否则 html.is-loading 会一直挂着
    // （模式开关等按加载态隐藏的东西会永远不出现）
    document.documentElement.classList.remove('is-loading')

    if (large.isActive()) {
      contentEl.classList.add('large-doc')
      document.documentElement.classList.add('large-file')
      // 大文件只有纯文本可编：档位锁在源码档，避免"切回阅读能看见渲染"的误解。
      // 直接改 viewMode 而不走 setViewMode——后者会 render()，而这里是 CM 的场子。
      forceSourceMode()
      large.mountLargeDocument()
      large.showLargeFileBar()
      resetOutline()
      renderOutline()
      restoreReadingPosition()
      // 复位脏点/保存按钮/状态行（换文档前的 dirty 类不能留着）
      markDirty()
    } else {
      render()
      markDirty()
      // 恢复上次的阅读位置。放在 render 之后：需要块已经进 DOM 才能滚到位。
      // 用 rAF 等一帧，避免和 render 的布局在同一帧里打架。
      restoreReadingPosition()
      // 换文档后大纲要重建：标题变了（在 render() 之后，此时 blocksEl 才填好）
      renderOutline()
      // 空文档：进编辑档并把光标放进去。
      // 只合成空段落是不够的——空段落没有可见表面，阅读档里看不到也点不到，
      // 那还是"打不了字"；光标本身就是这里唯一需要的占位。
      // 用 rAF 等这一轮渲染落地再聚焦，否则可能拿到还没进 DOM 的块（表现为"点了没反应"）。
      if (pendingEmptyFocus) {
        const id = pendingEmptyFocus
        pendingEmptyFocus = null
        setViewMode('edit')
        requestAnimationFrame(() => focusBlock(id))
      }
      large.clearLargeFileBar()
    }
    setDocPresent(true)
  }

  async function render() {
    // 大文件没有块：正文区由 mountLargeDocument 挂的整篇 CM 占据，
    // 任何走块渲染的路径（切档、markDirty 之后等）都必须绕开，否则会把 CM 清掉。
    if (large.isActive()) return
    // 没打开文档时 contentEl 归空态/加载态管（loadState.ts），这里没有块可渲染。
    // 不设防的话 applyKeyedChildren(contentEl, []) 会把空态 UI 整个抹掉——
    // 实际发生过：启动时主题从系统预判切到设置值触发 mermaid 重画（main.ts 的
    // notify → 250ms 后 render），空态闪一下就变白屏。
    if (!session.source) return
    // 预渲染 KaTeX：走一次 katex 库加载 + 所有 math 节点并行渲染,之后 renderBlockHtml 同步读 cache。
    // 文档无 math 节点时,这步 0 开销。
    await preRenderMath(session.blocks)
    const desired: HTMLElement[] = []
    const seen = new Set<string>()
    for (const block of session.blocks) {
      seen.add(block.id)
      let el = blocksEl.get(block.id)
      if (!el) {
        el = createBlockEl(block)
        blocksEl.set(block.id, el)
      }
      desired.push(el)
    }
    for (const [id, el] of blocksEl) {
      if (!seen.has(id)) {
        teardownCodePreview(el)
        el.remove()
        blocksEl.delete(id)
        lastPaint.delete(id)
      }
    }
    applyKeyedChildren(contentEl, desired)
    const mode = getViewMode()
    for (const block of session.blocks) {
      paintBlock(block, mode)
    }
    caretIntent = null
    scheduleBlockContainment()
  }

  /** 只重画一块。聚焦/失焦走这条，避免整篇 render() 先 await 公式再按文档序重画上一块。 */
  function paintBlock(block: BlockView, mode: string = getViewMode()): void {
    const el = blocksEl.get(block.id)
    if (!el) return
    const focused = block.id === session.focusedId
    const next = {
      raw: block.raw,
      kind: block.kind,
      surface: blockPaintSurface(mode, focused),
    }
    if (sameBlockPaint(lastPaint.get(block.id), next)) return
    renderBlockContent(el, block)
    // 必须在 renderBlockContent 之后：它每轮 replaceChildren 会把子节点清掉
    appendBlockChrome(el, block)
    lastPaint.set(block.id, next)
  }

  function applyBlockMeta(el: HTMLElement, block: BlockView) {
    el.dataset.kind = block.kind
    // 把块 id 写进 DOM：大纲行、测试、排障都要能自证「这一行指的是哪个块」。
    // 曾经出现过大纲行指着已被替换的旧 id 的情况（表现为高亮消失、点击无反应），
    // 没有这个属性就只能靠猜。
    el.dataset.blockId = block.id
    const depth = headingDepth(block)
    if (depth != null) el.dataset.depth = String(depth)
    else delete el.dataset.depth
  }

  function createBlockEl(block: BlockView): HTMLElement {
    const el = document.createElement('div')
    el.className = 'block'
    el.dataset.blockId = block.id
    applyBlockMeta(el, block)
    if (isWhitespaceGap(block)) el.classList.add('gap')
    return el
  }

  /**
   * 块的边界指示器（完整理由见 chrome.css 的「块指示器」段）。两个节点都挂，
   * 由样式按 `html[data-mode]` 决定哪一个上场——**每档只出一样东西**：
   *   - 轨道：只读档。那里没有衬底、没有左边线、也没有把手，边界只有它说。
   *   - 把手：编辑/源码档。把右键那份块菜单显性化（此前只能靠右键猜出来）。
   * 用样式而不是渲染时判断，切档才不用重渲染整篇块。
   *
   * 每轮渲染重建，不维护第二份「把手表」：renderBlockContent 会 replaceChildren，
   * 那种平行 Map 迟早和 blocksEl 走岔（换文件、块被删时要各清一次，漏一处就是幽灵节点）。
   */
  function appendBlockChrome(el: HTMLElement, block: BlockView): void {
    // 段间空白缝（.gap）零高、pointer-events:none：没有表面，也没有「一块」可言
    if (isWhitespaceGap(block)) return

    const rail = document.createElement('div')
    rail.className = 'block-rail'
    rail.setAttribute('aria-hidden', 'true')
    el.appendChild(rail)

    // 把手只在「点得开菜单」的块上长出来：unknown 是解析不出内容的降级块（见 core/parse.ts
    // 的尾部残余兜底），它没有块菜单。有把手却点了没反应，比没有把手更糟——
    // 把手出现本身就该是「这里有菜单」的承诺。
    if (block.kind === 'unknown') return

    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 'block-handle'
    // 不进 Tab 序：一篇文档几百个块，逐个 Tab 过去等于键盘不可用。
    // 块菜单本身还有右键和（将来的）快捷键这两条路。
    handle.tabIndex = -1
    handle.setAttribute('aria-label', t('blockActions'))
    handle.innerHTML = iconSvg('grip', 16)
    el.appendChild(handle)
  }

  /** 方向键顶到块边界 → 跳到相邻可聚焦块，并接上光标列。 */
  function moveAcrossBlocks(
    block: BlockView,
    view: EditorView,
    dir: 'up' | 'down' | 'left' | 'right',
  ): boolean {
    const vertical = dir === 'up' || dir === 'down'
    const forward = dir === 'down' || dir === 'right'
    if (vertical ? !atVisualVerticalEdge(view, forward) : !atHorizontalEdge(view, forward)) {
      return false
    }
    const nextId = adjacentFocusableId(session.blocks, block.id, forward ? 1 : -1)
    if (!nextId) return false
    const x = vertical ? caretX(view) : undefined
    const intent: CaretIntent = forward
      ? x == null ? { mode: 'start' } : { mode: 'start', x }
      : x == null ? { mode: 'end' } : { mode: 'end', x }
    // 必须等当前 keydown 结束再切块，否则新 CM 会吃到同一记方向键，单行块会被连跳两次。
    window.setTimeout(() => {
      focusBlock(nextId, intent)
      blocksEl.get(nextId)?.scrollIntoView({ block: 'nearest' })
    }, 0)
    return true
  }

  function destroyMermaidPanel(): void {
    mermaidPanel?.destroy()
    mermaidPanel = null
  }

  /** mermaid 围栏块：聚焦时挂实时预览、换专用语法高亮。 */
  function isMermaidBlock(block: BlockView): boolean {
    return block.kind === 'code' && /^\s*```\s*mermaid\b/.test(block.raw)
  }

  function renderBlockContent(el: HTMLElement, block: BlockView) {
    teardownCodePreview(el)
    if (isWhitespaceGap(block)) {
      el.className = 'block gap'
      el.replaceChildren()
      return
    }
    applyBlockMeta(el, block)
    el.classList.remove('gap')
    el.classList.toggle('focused', block.id === session.focusedId)
    const focus = block.id === session.focusedId
    el.replaceChildren()
    if (focus) {
      const host = document.createElement('div')
      host.className = 'cm-host'
      applyBlockMeta(host, block)
      el.appendChild(host)
      // mermaid 块：源码下方挂实时预览，语法高亮换专用分词器
      const mermaid = isMermaidBlock(block)
  const config = {
    autoCharacterPairs: getSettings().autoCharacterPairs,
    showWhitespace: getSettings().showWhitespace,
    // 行号只给代码块：段落块挂 gutter 没有意义
    lineNumbers: block.kind === 'code' && getSettings().codeLineNumbers,
        // 块内历史见底后，⌘Z 接着撤块级操作（见 cm.ts 的 Mod-z）
        onUndoFallback: () => operations.undoBlockOp(),
        // 代码块里不做 HTML→Markdown：那里要的是代码原文
        pasteHtmlAsMarkdown: block.kind !== 'code',
        structuralKeymap: {
          Enter: (view: EditorView) => operations.splitBlock(block, view),
          Backspace: (view: EditorView) => operations.mergeBlock(block, view),
          ArrowUp: (view: EditorView) => moveAcrossBlocks(block, view, 'up'),
          ArrowDown: (view: EditorView) => moveAcrossBlocks(block, view, 'down'),
          ArrowLeft: (view: EditorView) => moveAcrossBlocks(block, view, 'left'),
          ArrowRight: (view: EditorView) => moveAcrossBlocks(block, view, 'right'),
        },
      }
      cm = mountEditor(
        host,
        block.raw,
        (text) => {
          liveText.set(block.id, text)
          syncBlockText(block, text)
          mermaidPanel?.update(text)
        },
        {
          ...config,
          // mermaid 块换专用语法高亮（围栏 + 图类型 + 箭头 + 注释）
          ...(mermaid ? { language: mermaidLanguage } : {}),
          // 选中文字 → 浮出格式浮条；空选区/失焦 → 收起。
          // 位置由 CM 自己算（coordsAtPos），浮条只负责摆和点。
          onSelectionChange: (sel) => {
            if (!sel || !cm) {
              closeSelectionBubble()
              return
            }
            openSelectionBubble(sel, cm.view)
          },
        },
      )
      if (mermaid) {
        // 视图档切换等路径会不经 focusBlock 直接重挂载，先清掉旧面板的防抖计时器
        destroyMermaidPanel()
        mermaidPanel = createMermaidLivePanel(block.raw, (svg) => showSvgInLightbox(svg, 'mermaid'))
        el.appendChild(mermaidPanel.el)
      }
      const intent = caretIntent
      requestAnimationFrame(() => {
        if (!cm) return
        cm.view.focus()
        if (intent) placeCaret(cm.view, intent)
      })
    } else if (getViewMode() === 'source') {
      // 源码模式：每块以等宽源码呈现，不走 mdast HTML。
      // mermaid / 图片的渲染属于预览路径，源码模式不解释。
      const src = document.createElement('pre')
      src.className = 'source-view'
      const code = document.createElement('code')
      code.textContent = block.raw
      src.appendChild(code)
      el.appendChild(src)
    } else {
      const preview = document.createElement('div')
      preview.className = 'preview reading-prose'
      preview.innerHTML = renderBlockHtml(block.mdast, block.raw)
      el.appendChild(preview)
      if (block.kind === 'code') decorateCodeBlock(preview)
    }
  }

  /**
   * 把编辑器里的文本同步回块，并立刻重算脏状态。
   *
   * 打字时就调用，而不是等失焦：
   *   - 状态行的字数/小节数读的是块文本，失焦才同步等于「打字时数字不动」；
   *   - 「保存」按钮的可用性也读脏状态——打了半屏字按钮还是灰的，会被读成没响应。
   * 解析（mdast / kind）仍然留给失焦：那一步贵，且打字过程中没人需要新的大纲。
   */
  function syncBlockText(block: BlockView, text: string): void {
    const original = session.originals.get(block.id) ?? block.raw
    block.raw = text
    block.dirty = text !== original
    markDirty({ fromTyping: true, kind: block.kind })
  }

  function finalizeFocused() {
    closeSelectionBubble()
    if (session.focusedId === null || !cm) return
    const block = session.blocks.find((b) => b.id === session.focusedId)
    if (!block) return
    const text = cm.view.state.doc.toString()
    const original = session.originals.get(block.id) ?? block.raw
    block.raw = text
    block.dirty = text !== original
    if (block.dirty) {
      const roots = parseBlockRoots(text)
      block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
      block.kind = kindFromMdast(roots[0]) as BlockKind
    }
    markDirty()
  }

  function focusBlock(id: string, intent?: CaretIntent) {
    if (session.focusedId === id) {
      if (intent && cm) {
        placeCaret(cm.view, intent)
        cm.view.focus()
      }
      return
    }
    const next = session.blocks.find((b) => b.id === id)
    if (!next || !isFocusableBlock(next)) return
    const prevId = session.focusedId
    finalizeFocused()
    if (cm) {
      cm.destroy()
      cm = null
    }
    destroyMermaidPanel()
    session.focusedId = id
    caretIntent = intent ?? null
    // 先挂这块的 CM：编辑档还原上一块预览（图 / mermaid）若插在前面，
    // 源码档只是填一段文本，观感就是「源码点一下就进、编辑要顿一下」。
    paintBlock(next)
    caretIntent = null
    if (prevId && prevId !== id) {
      const prev = session.blocks.find((b) => b.id === prevId)
      if (prev) {
        requestAnimationFrame(() => {
          if (session.focusedId === prev.id) return
          paintBlock(prev)
        })
      }
    }
  }

  function defocus() {
    const prevId = session.focusedId
    finalizeFocused()
    if (cm) {
      cm.destroy()
      cm = null
    }
    destroyMermaidPanel()
    session.focusedId = null
    if (prevId) {
      const prev = session.blocks.find((b) => b.id === prevId)
      if (prev) paintBlock(prev)
      return
    }
    void render()
  }

  function forgetBlockViews(removed: readonly BlockView[]): void {
    for (const r of removed) {
      const el = blocksEl.get(r.id)
      if (el) teardownCodePreview(el)
      el?.remove()
      blocksEl.delete(r.id)
    }
    if (session.focusedId && removed.some((r) => r.id === session.focusedId)) {
      if (cm) {
        cm.destroy()
        cm = null
      }
      session.focusedId = null
    }
  }

  function focusAfterStructuralEdit(id: string | null, intent?: CaretIntent): void {
    if (intent !== undefined) caretIntent = intent
    session.focusedId = id
    if (cm) {
      cm.destroy()
      cm = null
    }
    markDirty()
    void render()
  }

  function insertImageMarkdownAtCaret(md: string) {
    // 大文件：正文就是一个整篇 CM，插到它的光标处
    const largeView = large.getView()
    if (large.isActive() && largeView) {
      const view = largeView
      const pos = view.state.selection.main.head
      view.dispatch({
        changes: { from: pos, insert: md },
        selection: { anchor: pos + md.length },
        scrollIntoView: true,
      })
      return
    }
    if (cm && session.focusedId) {
      const pos = cm.view.state.selection.main.head
      cm.view.dispatch({
        changes: { from: pos, insert: md },
        selection: { anchor: pos + md.length },
      })
      return
    }
    operations.appendImageParagraph(md)
  }

  function openFind() {
    // 大文件不建块，现有查找是按块计数 + 按块高亮/跳转的，跑不动。
    // 明确说不支持，而不是打开一个「0 处命中」的假面板。
    if (large.isActive()) {
      showToast(t('findLargeUnavailable'))
      return
    }
    if (document.querySelector('.find-bar')) {
      document.querySelector<HTMLInputElement>('.find-input')?.focus()
      return
    }
    findBar({
      getBlocks: () => session.blocks,
      replaceInBlock: (id, from, to, all, opts) => {
        const b = session.blocks.find((x) => x.id === id)
        if (!b) return
        // 统一替换器：与计数、高亮共用同一套匹配规则（字符串 / 全词 / 正则）
        b.raw = replaceFind(b.raw, from, to, opts, all)
        b.dirty = true
        const roots = parseBlockRoots(b.raw)
        b.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
        b.kind = kindFromMdast(roots[0]) as BlockKind
        markDirty()
        if (session.focusedId === id && cm) {
          cm.destroy()
          cm = null
        }
        render()
      },
      // 瞬时跳转：refresh() 会对多个命中块连续 scrollTo，smooth 动画互相
      // 打断很乱；单次跳转长距离也要滑 1s+。与 findHighlight 同一取舍。
      scrollTo: (id) => blocksEl.get(id)?.scrollIntoView({ behavior: 'auto', block: 'center' }),
    })
  }

  /** 当前会把什么写回磁盘——与状态行的字数取自同一份文本。 */
  function allRawText(): string {
    if (large.isActive()) return large.largeText()
    return session.blocks.map((b) => b.raw).join('')
  }

  function getNormalizedText(): string {
    const src = session.source
    if (!src) return ''
    // 大文件：未编辑时直接写回原文——CM 会把 CRLF / 混合换行规整成 LF，从 CM 取全文
    // 会在"打开后原样保存"这一路径上改写换行字节（撞产品红线）。编辑过才用 CM 的文本。
    if (large.isActive()) return large.isDirty() ? large.largeText() : src.text
    finalizeFocused()
    return serialize(session.blocks)
  }

  function retargetSource(path: string): void {
    session.source = createSourceDocument(path, session.source!.text, 0)
  }

  function markSaved(normalized: string, mtimeMs: number | undefined): void {
    if (large.isActive()) {
      // 保存成功：把 CM 的当前全文记为新的基线（含换行归一，因为 applyEncoding 另存了磁盘形态）——
      // 这条基线就是 session.source.text，未编辑保存写回原文靠它。
      large.markSaved()
      session.source!.text = normalized
    } else {
      session.blocks.forEach((b) => {
        session.originals.set(b.id, b.raw)
        b.dirty = false
      })
      session.structuralDirty = false
    }
    if (typeof mtimeMs === 'number') {
      session.source!.mtimeMs = mtimeMs
    }
    if (!large.isActive()) {
      if (cm) {
        cm.destroy()
        cm = null
      }
      session.focusedId = null
      render()
    }
    markDirty()
  }

  function resetDocument(): void {
    // 关文档也关查找栏：否则它会浮在空态上，还留着上一篇的查询与命中标记。
    closeFindBar()
    if (cm) {
      cm.destroy()
      cm = null
    }
    large.destroy()
    large.deactivate()
    lastPaint.clear()
    session.source = null
    session.focusedId = null
    session.dirty = false
    session.structuralDirty = false
    session.originals = new Map()
    setCurrentMdPath(null)
    large.clearLargeFileBar()
    containGen++
    contentEl.classList.remove('large-doc', 'blocks-cv')
    document.documentElement.classList.remove('large-file')
  }

  function clearBlocks(): void {
    session.blocks = []
  }

  function clearBlockElements(): void {
    blocksEl.clear()
    lastPaint.clear()
  }

  function acceptDiskMtime(mtimeMs: number): void {
    if (session.source) session.source.mtimeMs = mtimeMs
  }

  function getSession(): DocumentSession {
    return session
  }

  function getCmView(): EditorView | null {
    return cm?.view ?? null
  }

  function isLarge(): boolean {
    return large.isActive()
  }

  function getLargeInfo(): { bytes: number; totalLines: number } {
    return large.getInfo()
  }

  function getBlockElement(id: string): HTMLElement | undefined {
    return blocksEl.get(id)
  }

  return {
    getSession,
    getCmView,
    isLarge,
    getLargeInfo,
    activeScroller,
    getBlockElement,
    loadSession,
    render,
    focusBlock,
    defocus,
    finalizeFocused,
    markDirty,
    markStructuralDirty,
    allRawText,
    getNormalizedText,
    retargetSource,
    markSaved,
    resetDocument,
    clearBlocks,
    clearBlockElements,
    acceptDiskMtime,
    insertImageMarkdownAtCaret,
    openFind,
    operations,
  }
}
