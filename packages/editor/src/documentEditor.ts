import {
  createSourceDocument,
  adjacentFocusableId,
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlocks,
  parseBlockRoots,
  serialize,
  createChunkedParser,
  definitionsFromBlocks,
  finalizeChunkedBlocks,
  type ChunkedParser,
  type ChunkStepResult,
  type BlockKind,
  type BlockView,
  type DefinitionSet,
} from '@lector/core'
import type { EditorView } from '@codemirror/view'
import { mountEditor, type CmHandle } from './cm.ts'
import { renderBlockHtml, preRenderMath, setLinkDefinitions, addLinkDefinitions, mdastHasLinkReference } from './mdastHtml.ts'
import { iconSvg } from './icons.ts'
import { mermaidLanguage } from './mermaidLanguage.ts'
import { createMermaidLivePanel, type MermaidLivePanel } from './mermaidLive.ts'
import { setCurrentMdPath } from './asset.ts'
import { getSettings } from './settings.ts'
import { findBar, closeFindBar, refreshFindBar } from './findBar.ts'
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
import { coveredEndBeforePending } from './pendingCover.ts'
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
  /** 解析向前推进时刷新状态行。不走 onDirty，避免每片都重建大纲、记草稿。 */
  onStatus?: () => void
}

export interface DocumentEditor {
  getSession(): Readonly<DocumentSession>
  getCmView(): EditorView | null
  isLarge(): boolean
  getLargeInfo(): { bytes: number; totalLines: number; words: number | null }
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
  setSaving(on: boolean): void
  resetDocument(): void
  clearBlocks(): void
  clearBlockElements(): void
  acceptDiskMtime(mtimeMs: number): void
  insertImageMarkdownAtCaret(md: string): void
  replaceInDocument(find: string, replacement: string): boolean
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
  onStatus,
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
  /**
   * 超过这个长度就先解析开头、立刻出首屏，其余用时间片补。
   * 64KB 在分块解析下大约几十毫秒，混合文档大约两千块。
   */
  const PROGRESSIVE_HEAD = 64 * 1024
  /** 每个时间片的解析预算。一片约 16KB，混合文档一片大约 10ms。 */
  const PARSE_SLICE_MS = 12
  let parseGeneration = 0
  let parsePaused = false
  /** render 叠在一起时，只有最后一次绘制能把暂停清掉。换文档 / 关文档也会把票号作废。 */
  let parsePauseTicket = 0
  let activeParser: ChunkedParser | null = null
  let statusNotifiedAt = 0
  let caretIntent: CaretIntent | null = null
  /** 聚焦中的 mermaid 实时预览面板；块失焦/切换时随 CM 一起销毁。 */
  let mermaidPanel: MermaidLivePanel | null = null

  const large = createLargeDocument({
    contentEl,
    getSourceText: () => session.source?.text ?? '',
    onDirty: () => markDirty(),
    onScroll: () => scheduleRecordPosition(),
    onWordsReady: () => onStatus?.(),
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
    // 拆块 / 插图会往块表里塞 end 为 0 的新块。解析没完时先排空，避免把占位块的尾巴算成整篇。
    beforeStructuralEdit: () => flushParse(),
    getDefinitions: () => sessionDefs(),
  })

  /** 当前正文的滚动容器：普通档是 #content，大文件档是 CM 自己的滚动层。 */
  function activeScroller(): HTMLElement | null {
    if (large.isActive()) return large.getView()?.scrollDOM ?? null
    return contentEl
  }

  let containGen = 0
  /**
   * 块集合变过没有（新块 / 删块 / 换文档）。
   *
   * content-visibility 是**布局模式**，摘掉再挂上会让同一批块在「塌边距 / 不塌边距」
   * 两种高度之间跳一帧。实测（1280×820、内置样例）：摘掉那一帧整篇 scrollHeight
   * 1538→1474，被点那块在屏幕上抖 5.4px，屏幕外没渲染过的块还会从「4.5em 估高」
   * 掉回真实高度（69→1px）。勾选任务项正是踩在这上面。
   *
   * 所以只有块集合真的变了才值得走这一趟；改内容（勾选、改字、撤销块的编辑）就地
   * 重画就够了——被改的那块就在眼前，高度是实时量的，不必让整篇按另一种模式重估一遍。
   */
  let containStale = true
  /** 上次走测量那趟时是哪个档（content-visibility 只作用于阅读档）。 */
  let containMode = ''

  /** 首屏（含 mermaid）量完真实高度后再开 content-visibility，大纲位置才不会漂。 */
  function scheduleBlockContainment(): void {
    // 已经在 contain 态、块集合又没变：这套布局就是量准过的，再摘一次只会白抖一下
    if (!containStale && contentEl.classList.contains('blocks-cv')) return
    contentEl.classList.remove('blocks-cv')
    const gen = ++containGen
    containStale = false
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

  function makePending(text: string, start: number): BlockView {
    return {
      id: 'pending',
      kind: 'pending',
      start,
      end: text.length,
      raw: text.slice(start),
      // 占位的 mdast 必须是真值：统计遇到 null 会按 raw 重解析，尾部可能有好几 MB。
      mdast: { type: 'html', value: '' },
      dirty: false,
    }
  }

  function dropBlockEl(block: BlockView): void {
    session.originals.delete(block.id)
    const el = blocksEl.get(block.id)
    if (!el) return
    teardownCodePreview(el)
    el.remove()
    blocksEl.delete(block.id)
    lastPaint.delete(block.id)
  }

  /** 把一步解析结果写进块表。返回需要画出来的新块。 */
  function applyParseStep(blocks: BlockView[], step: ChunkStepResult): BlockView[] {
    const pendingAt = () => blocks.findIndex((b) => b.kind === 'pending')
    const paint: BlockView[] = []
    if (step.retract > 0) {
      const end = pendingAt() < 0 ? blocks.length : pendingAt()
      const from = Math.max(0, end - step.retract)
      for (const block of blocks.splice(from, end - from)) dropBlockEl(block)
    }
    const at = pendingAt()
    if (at < 0) blocks.push(...step.append)
    else blocks.splice(at, 0, ...step.append)
    paint.push(...step.append)
    for (const rep of step.replacements) {
      const range = blocks.filter(
        (b) => b.kind !== 'pending' && b.start >= rep.start && b.end <= rep.end,
      )
      if (range.length === 0) continue
      if (range.some((b) => b.dirty || b.id === session.focusedId)) continue
      const i = blocks.indexOf(range[0]!)
      blocks.splice(i, range.length, ...rep.blocks)
      for (const block of range) dropBlockEl(block)
      paint.push(...rep.blocks)
    }
    const pending = blocks.find((b) => b.kind === 'pending')
    const text = session.source?.text
    if (pending && text) {
      const covered = coveredEndBeforePending(blocks)
      // 只向前推进。插在占位块后面的 end:0 块不能把覆盖区间拉回文首。
      if (covered >= pending.start) {
        pending.start = covered
        pending.end = text.length
        pending.raw = text.slice(covered)
      }
    }
    return paint
  }

  function paintFresh(blocks: BlockView[]): void {
    if (blocks.length === 0) return
    const pendingEl = blocksEl.get('pending') ?? null
    const mode = getViewMode()
    for (const block of blocks) {
      let el = blocksEl.get(block.id)
      if (!el) {
        el = createBlockEl(block)
        blocksEl.set(block.id, el)
      }
      // 关文档会把 #content 清空，但 blocksEl 里可能还留着已经脱离文档的占位节点。
      if (pendingEl && pendingEl.parentNode === contentEl) contentEl.insertBefore(el, pendingEl)
      else contentEl.appendChild(el)
      paintBlock(block, mode)
    }
    const pending = session.blocks.find((b) => b.kind === 'pending')
    if (pending) paintBlock(pending)
  }

  function sessionDefs(): DefinitionSet {
    return definitionsFromBlocks(session.blocks)
  }

  /**
   * 解析收尾。正在编辑的 details 跨度不合并（合并会换 id，光标所在的编辑器被拆掉）。
   * 已经改过、但此刻没聚焦的跨度用各块当前 raw 拼回去，不用磁盘原文覆盖。
   * paint 为 false 时只改块表：结构编辑自己会接着 render，这里再画一次会和它叠在一起。
   */
  function commitParsedBlocks(paint: boolean): void {
    activeParser = null
    const text = session.source?.text
    if (!text) return
    const pending = session.blocks.find((b) => b.kind === 'pending')
    const body = session.blocks.filter((b) => b.kind !== 'pending')
    const finalized = finalizeChunkedBlocks(body, text, {
      preserveBlock: (block) => block.id === session.focusedId,
    })
    const changed = finalized.length !== body.length || finalized.some((b, i) => b !== body[i])
    session.blocks = finalized
    for (const b of finalized) {
      if (!session.originals.has(b.id)) session.originals.set(b.id, text.slice(b.start, b.end))
    }
    if (pending) dropBlockEl(pending)
    if (paint && changed) void render()
    else if (paint) renderOutline()
    markDirty()
    refreshFindBar()
  }

  /** 结构编辑之前把剩余的片子同步排空。时间片还在跑时插块，占位块边界和接缝撤回都会算错。 */
  function flushParse(): void {
    const parser = activeParser
    if (!parser) return
    const generation = parseGeneration
    activeParser = null
    while (!parser.done) {
      if (generation !== parseGeneration) return
      const fresh = applyParseStep(session.blocks, parser.step(0))
      for (const b of fresh) if (!session.originals.has(b.id)) session.originals.set(b.id, b.raw)
    }
    commitParsedBlocks(false)
  }

  function pumpParser(parser: ChunkedParser, generation: number): void {
    const run = () => {
      if (generation !== parseGeneration || activeParser !== parser) return
      if (parsePaused) {
        window.setTimeout(run, 16)
        return
      }
      const started = performance.now()
      const paint: BlockView[] = []
      while (!parser.done && performance.now() - started < PARSE_SLICE_MS) {
        const fresh = applyParseStep(session.blocks, parser.step(0))
        for (const b of fresh) if (!session.originals.has(b.id)) session.originals.set(b.id, b.raw)
        paint.push(...fresh)
      }
      paintFresh(paint)
      // 公式缓存是异步的：先画原文，算完再重画这一批。
      if (paint.length > 0) {
        void preRenderMath(paint).then(() => {
          if (generation !== parseGeneration || activeParser !== parser) return
          for (const b of paint) lastPaint.delete(b.id)
          paintFresh(paint)
        })
      }
      // 定义表变了只重画含引用的块。每片都重画全部已挂载块是 O(片数 × 块数)。
      if (addLinkDefinitions(paint)) {
        for (const block of session.blocks) {
          if (block.kind === 'pending' || !blocksEl.has(block.id)) continue
          if (!mdastHasLinkReference(block.mdast)) continue
          lastPaint.delete(block.id)
          paintBlock(block)
        }
      }
      const now = performance.now()
      if (now - statusNotifiedAt > 200) {
        statusNotifiedAt = now
        onStatus?.()
      }
      if (parser.done) commitParsedBlocks(true)
      else window.setTimeout(run, 0)
    }
    window.setTimeout(run, 0)
  }

  /**
   * 短文档一次解析完。长文档只同步解析开头，尾巴留一个 pending 块（raw 是剩余原文，
   * 拼接仍然等于全文），剩下的交给调用方启动时间片续跑（不在这里启动，是为了让
   * 调用方先按首屏块数判断该走 IR 还是大文件模式）。
   */
  function beginOpen(text: string): { blocks: BlockView[]; parser: ChunkedParser | null; covered: number } {
    if (text.length <= PROGRESSIVE_HEAD) {
      return { blocks: parseBlocks(text), parser: null, covered: text.length }
    }
    const parser = createChunkedParser(text, {
      canRetract: (blocks) => blocks.every((b) => !b.dirty && b.id !== session.focusedId),
    })
    const blocks: BlockView[] = []
    let covered = 0
    while (!parser.done) {
      applyParseStep(blocks, parser.step(0))
      covered = blocks.at(-1)?.end ?? 0
      if (covered >= PROGRESSIVE_HEAD || covered >= text.length) break
    }
    if (!parser.done && covered < text.length) blocks.push(makePending(text, covered))
    return { blocks, parser: parser.done ? null : parser, covered }
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
    session.focusedId = null
    paintGeneration++
    parseGeneration++
    parsePauseTicket++
    activeParser = null
    blocksEl.clear()
    lastPaint.clear()
    liveText.clear()
    containGen++
    containStale = true
    contentEl.classList.remove('large-doc', 'blocks-cv')
    document.documentElement.classList.remove('large-file')
    session.source = createSourceDocument(path, raw, mtimeMs)
    // 换文档 = 另一次保存生命周期：「保存中 / 已保存时间」都属于上一篇
    session.saving = false
    session.savedAt = null
    setCurrentMdPath(session.source.path)
    // 大文件逃生舱：超预算就不解析、不建块，整篇交给一个裸 CM（见 largeDocument.ts）。
    // 字节数由壳给出（read_file 的 byte_len）；浏览器预览退回 Blob 大小。
    const bytes = byteLen ?? new Blob([raw]).size
    const text = session.source.text
    // 先做开解析前的廉价预检（字节上限 + 切不开的巨块）；过了才同步解析首屏，
    // 再按首屏密度投射全文块数——密集表格能靠这一步挡住，纯散文放得进。
    const opened = large.configure(text, bytes) ? null : beginOpen(text)
    if (opened === null || large.overBlockBudget(opened.blocks.length, opened.covered, text.length)) {
      session.blocks = []
      session.originals = new Map()
      session.focusedId = null
      session.dirty = false
      session.structuralDirty = false
    } else {
      session.blocks = opened.blocks
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
      activateLargeMode()
    } else {
      activateIrMode()
      // 长文档的尾巴交给时间片续跑。render 只负责暂停，不再保管唯一的启动闭包——
      // 第一次绘制还没结束就来第二次 render 时，那份闭包会丢，解析就永远停住。
      if (opened?.parser) {
        activeParser = opened.parser
        pumpParser(opened.parser, parseGeneration)
      }
    }
    setDocPresent(true)
  }

  /** 大文件档：整篇裸 CM，锁在源码档，块渲染全部绕开。 */
  function activateLargeMode(): void {
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
  }

  /** 常规块 IR 档：首屏渲染 + 阅读位置 + 大纲。 */
  function activateIrMode(): void {
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

  /**
   * 首屏先画这么多块，其余用时间片分批补。块数少的文档一次画完，行为与原来一致。
   * 取值：首屏约 64KB 正文，mixed 夹具里约 1500 块。
   */
  const FIRST_PAINT_BLOCKS = 1500
  /** 每批补这么多块。一批的 DOM 构建要落在一帧里（16ms 内）。 */
  const PAINT_BATCH = 400
  /** 正在分批补画的文档版本。换文档时递增，旧批次由此失效。 */
  let paintGeneration = 0

  async function render() {
    // 大文件没有块：正文区由 mountLargeDocument 挂的整篇 CM 占据，
    // 任何走块渲染的路径（切档、markDirty 之后等）都必须绕开，否则会把 CM 清掉。
    if (large.isActive()) return
    // 没打开文档时 contentEl 归空态/加载态管（loadState.ts），这里没有块可渲染。
    // 不设防的话 applyKeyedChildren(contentEl, []) 会把空态 UI 整个抹掉——
    // 实际发生过：启动时主题从系统预判切到设置值触发 mermaid 重画（main.ts 的
    // notify → 250ms 后 render），空态闪一下就变白屏。
    if (!session.source) return
    // 重画期间停下尾巴的解析，避免一边改 DOM 一边往里插块。
    // 票号只在「这次绘制确实结束」时才允许清暂停。中途又来一次 render，或换了文档，旧的收尾作废。
    const pauseTicket = ++parsePauseTicket
    parsePaused = true
    // 预渲染 KaTeX：走一次 katex 库加载 + 所有 math 节点并行渲染,之后 renderBlockHtml 同步读 cache。
    // 文档无 math 节点时,这步 0 开销。
    await preRenderMath(session.blocks)
    if (pauseTicket !== parsePauseTicket || !session.source) return
    // 定义一变，引用它的块 raw 没变也得重画（sameBlockPaint 只看 raw/kind/表面）
    if (setLinkDefinitions(session.blocks)) lastPaint.clear()
    const desired: HTMLElement[] = []
    const seen = new Set<string>()
    for (const block of session.blocks) {
      seen.add(block.id)
      let el = blocksEl.get(block.id)
      if (!el) {
        el = createBlockEl(block)
        blocksEl.set(block.id, el)
        containStale = true // 新块的高度是估的，得让它真实布局一次
      }
      desired.push(el)
    }
    for (const [id, el] of blocksEl) {
      if (!seen.has(id)) {
        teardownCodePreview(el)
        el.remove()
        blocksEl.delete(id)
        lastPaint.delete(id)
        containStale = true // 少了一块，下面的东西整体上移，也要重量
      }
    }
    // 块很多时只先画首屏，其余分批补（见 paintRestInBatches）
    const batching = desired.length > FIRST_PAINT_BLOCKS
    applyKeyedChildren(contentEl, batching ? desired.slice(0, FIRST_PAINT_BLOCKS) : desired)
    const mode = getViewMode()
    // content-visibility 只在阅读档生效（见 chrome.css）：档位一变，「contain 态现在
    // 长什么样」就换了一套，得重新量一遍——否则切回阅读档时屏幕外的块还在用估高。
    if (mode !== containMode) {
      containMode = mode
      containStale = true
    }
    const firstCount = batching ? FIRST_PAINT_BLOCKS : session.blocks.length
    for (let i = 0; i < firstCount; i++) paintBlock(session.blocks[i]!, mode)
    caretIntent = null
    scheduleBlockContainment()
    const paintGen = ++paintGeneration
    const unpause = () => {
      if (pauseTicket !== parsePauseTicket) return
      parsePaused = false
    }
    if (batching) paintRestInBatches(desired, firstCount, paintGen, unpause)
    else unpause()
  }

  /** 首屏之后的块分批补进 DOM。每批让出一次主线程，滚动与输入不受挡。 */
  function paintRestInBatches(
    desired: HTMLElement[],
    from: number,
    generation: number,
    onDone: () => void,
  ): void {
    let cursor = from
    const step = () => {
      if (generation !== paintGeneration) {
        onDone()
        return
      }
      const end = Math.min(cursor + PAINT_BATCH, desired.length)
      const mode = getViewMode()
      for (let i = cursor; i < end; i++) {
        contentEl.appendChild(desired[i]!)
        paintBlock(session.blocks[i]!, mode)
      }
      cursor = end
      if (cursor < desired.length) window.setTimeout(step, 0)
      else {
        renderOutline()
        onDone()
      }
    }
    window.setTimeout(step, 0)
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
    if (isWhitespaceGap(block) || block.kind === 'pending') return

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
    if (block.kind === 'pending') {
      // 不把未解析的尾巴画成源码：那可能是好几 MB 的文本。
      el.className = 'block'
      applyBlockMeta(el, block)
      el.replaceChildren()
      return
    }
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
      const roots = parseBlockRoots(text, sessionDefs())
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

  /**
   * 正文里做一次纯文本替换（图片占位的 token → 最终 src 用）。
   * 这段文本可能住在三处：大文件的整篇 CM、聚焦块的 CM、普通块的 raw——按序找，
   * 命中才改并返回 true。用户趁异步把占位删了会返回 false，调用方放弃回写即可。
   * CM 路径走 dispatch（光标、撤销链、脏标记都走既有监听）；块路径复用 setBlockRaw。
   */
  function replaceInDocument(find: string, replacement: string): boolean {
    const largeView = large.getView()
    if (large.isActive() && largeView) {
      const at = largeView.state.doc.toString().indexOf(find)
      if (at < 0) return false
      largeView.dispatch({ changes: { from: at, to: at + find.length, insert: replacement } })
      return true
    }
    if (cm && session.focusedId) {
      const at = cm.view.state.doc.toString().indexOf(find)
      if (at >= 0) {
        cm.view.dispatch({ changes: { from: at, to: at + find.length, insert: replacement } })
        return true
      }
    }
    const block = session.blocks.find((b) => b.raw.includes(find))
    if (!block) return false
    operations.setBlockRaw(block, block.raw.replace(find, replacement))
    void render()
    return true
  }

  function openFind() {
    if (document.querySelector('.find-bar')) {
      document.querySelector<HTMLInputElement>('.find-input')?.focus()
      return
    }
    // 大文件不建块：走整篇 CM 的源码查找（装饰 + 上一个/下一个），不做替换。
    if (large.isActive()) {
      const view = large.getView()
      if (!view) {
        showToast(t('findLargeUnavailable'))
        return
      }
      findBar({
        getBlocks: () => [],
        replaceInBlock: () => {},
        scrollTo: () => {},
        sourceFind: {
          getDoc: () => view.state.doc,
          reveal: (hits, current) => large.revealFind(hits, current),
          clear: () => large.clearFind(),
        },
      })
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
        const roots = parseBlockRoots(b.raw, sessionDefs())
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
    // 未命名文档第一次落盘：顶栏 / document.title / 原生标题一起换到真实文件名
    setDocumentTitle(path)
  }

  function markSaved(normalized: string, mtimeMs: number | undefined): void {
    session.saving = false
    session.savedAt = Date.now()
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
      if (cm && session.focusedId) {
        // ⌘S 不拆正在编辑的块：打字时 raw 已实时同步（syncBlockText），模型即最新。
        // 把 lastPaint 对齐到当前形态，下面 render() 就会跳过这块的重画——
        // CM 会话、光标/选区、IME 组合原样保留，其余块的预览刷新照常。
        const focused = session.blocks.find((b) => b.id === session.focusedId)
        if (focused) {
          lastPaint.set(focused.id, {
            raw: focused.raw,
            kind: focused.kind,
            surface: blockPaintSurface(getViewMode(), true),
          })
        }
      } else {
        if (cm) {
          cm.destroy()
          cm = null
        }
        session.focusedId = null
      }
      render()
    }
    markDirty()
  }

  function setSaving(on: boolean): void {
    session.saving = on
    // 借 markDirty 的通知链刷新保存按钮与状态行（dirty 本身不变）
    markDirty()
  }

  function resetDocument(): void {
    // 关文档也关查找栏：否则它会浮在空态上，还留着上一篇的查询与命中标记。
    closeFindBar()
    if (cm) {
      cm.destroy()
      cm = null
    }
    // 与 loadSession 对齐：旧时间片不能再往已经清空的会话里追加块。
    paintGeneration++
    parseGeneration++
    parsePauseTicket++
    activeParser = null
    parsePaused = false
    large.destroy()
    large.deactivate()
    lastPaint.clear()
    session.source = null
    session.focusedId = null
    session.dirty = false
    session.structuralDirty = false
    session.saving = false
    session.savedAt = null
    session.originals = new Map()
    setCurrentMdPath(null)
    large.clearLargeFileBar()
    containGen++
    containStale = true
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

  function getLargeInfo(): { bytes: number; totalLines: number; words: number | null } {
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
    setSaving,
    resetDocument,
    clearBlocks,
    clearBlockElements,
    acceptDiskMtime,
    insertImageMarkdownAtCaret,
    replaceInDocument,
    openFind,
    operations,
  }
}
