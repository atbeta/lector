import { mountEditor, type CmHandle } from './cm.ts'
import type { FindMatch } from './findMatch.ts'
import { getSettings } from './settings.ts'
import { closeSelectionBubble, openSelectionBubble } from './selectionBubble.ts'
import { countWordsApprox, formatCount } from '@lector/core'
import { t } from './i18n.ts'

interface LargeDocumentDeps {
  contentEl: HTMLElement
  getSourceText(): string
  onDirty(): void
  onScroll(): void
  /** 后台词数算完时回调（刷新状态行）。 */
  onWordsReady?(): void
}

/**
 * 绝对内存上限。再"轻"的文档，几十 MB 的正文加每块的 mdast 也会把 webview 压垮，
 * 所以字节数本身留一条硬线兜底。
 */
export const HARD_MAX_BYTES = 20 * 1024 * 1024

/**
 * 单个"切不开的巨块"的行数上限。
 *
 * 分块解析靠空行 / 标题等安全边界把全文切开，块数与耗时才随规模线性增长。
 * 但一串没有空行的列表项 / 表格行（`- x\n- y\n…`）没有任何安全边界，整篇落成
 * **一个块**，退回单块解析又变超线性：实测 1 万行 2.3s、4 万行 15s、且 4 万行
 * 就吃到 1.8GB。所以先用最长连续非空行数把这种文档挡在解析之前。
 */
export const MAX_BLOCK_RUN = 5_000

/**
 * 投影块数上限。这是**可交互**预算，不是内存崩溃线。
 *
 * 15 万块大约对应 20 秒解析 / 1.2GB，webview 到那儿才会被吃光。可是编辑档
 * 没有 content-visibility（把手在块外，contain 会裁掉点击），块一进 DOM 就参与布局。
 * 3MB 短段落散文实测约 4.2 万块：解析本身不到 1 秒，状态栏却会一直停在「解析中」，
 * 滚动和编辑已经不可用。10MB 散文约 8 万块，同样进不了虚拟化。
 * 预算放在这之下，这种文档回到纯文本模式；普通长文（约一千块）仍走块 IR。
 */
export const MAX_IR_BLOCKS = 12_000

function isBlankLine(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i)
    if (c !== 32 && c !== 9 && c !== 13) return false
  }
  return true
}

/** 一遍扫出行数与最长连续非空行。O(n)，不建任何结构。 */
export function scanText(text: string): { lines: number; longestRun: number } {
  let lines = 0
  let run = 0
  let longest = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    lines++
    if (isBlankLine(text, start, i)) run = 0
    else if (++run > longest) longest = run
    start = i + 1
  }
  // 末行没有换行符
  if (start < text.length) {
    if (isBlankLine(text, start, text.length)) run = 0
    else if (++run > longest) longest = run
  }
  return { lines, longestRun: longest }
}

/** 按首屏密度外推全文块数。headEnd 是首屏覆盖到的字符偏移。 */
export function projectBlockCount(headBlocks: number, headEnd: number, totalLen: number): number {
  if (headEnd <= 0 || headBlocks <= 0) return headBlocks
  return Math.ceil((headBlocks * totalLen) / headEnd)
}

/** 开解析之前的廉价判据：字节硬线，或一个切不开的巨块。 */
export function precheckTooLarge(bytes: number, longestRun: number): boolean {
  return bytes > HARD_MAX_BYTES || longestRun > MAX_BLOCK_RUN
}

/** 首屏采样后的判据：投影全文块数超预算。 */
export function projectedTooLarge(headBlocks: number, headEnd: number, totalLen: number): boolean {
  return projectBlockCount(headBlocks, headEnd, totalLen) > MAX_IR_BLOCKS
}

/**
 * 大文件的词数：后台分片扫一遍，不阻塞输入。
 *
 * 用 countWordsApprox（轻量正则清洗）而不是 countText（整篇 mdast 解析）——
 * 后者对 4MB 文档要 24 秒，大文件状态行只要量级。仍切成时间片：每片扫 CHUNK 个
 * 字符，让出一帧再继续。结果算完前是 null，状态行不占位。
 * 编辑后词数会过期——不重算，等下次打开；状态行报的是「打开时这份文档多大」。
 */
const WORD_SCAN_CHUNK = 1 << 20

export function countLargeWords(
  text: string,
  onDone: (words: number) => void,
  schedule: (fn: () => void) => void = (fn) => window.setTimeout(fn, 0),
): () => void {
  let cancelled = false
  let offset = 0
  let words = 0
  const step = (): void => {
    if (cancelled) return
    const end = Math.min(offset + WORD_SCAN_CHUNK, text.length)
    words += countWordsApprox(text.slice(offset, end))
    offset = end
    if (offset < text.length) schedule(step)
    else onDone(words)
  }
  schedule(step)
  return () => {
    cancelled = true
  }
}

export function createLargeDocument({ contentEl, getSourceText, onDirty, onScroll, onWordsReady }: LargeDocumentDeps) {
  // 大文件状态的声明必须早于模块顶层的 applyModeUI()/renderStatus()——
  // 否则首次初始化时会撞上 `let` 的暂时性死区（ReferenceError），
  // 整个初始化 IIFE 中断，窗口控件与空态都挂不上（真机上就是"右上角按钮消失 + 白屏"）。
  let largeMode = false
  let largeCm: CmHandle | null = null
  // 脏判据只有一个：largeDirty。刻意不保存"载入时的全文快照"——旧实现里那个
  // largeSnapshot 只写不读，留着会让人以为脏是靠它比对出来的。
  let largeDirty = false
  /** 提示条要报的真实体积与行数（载入时算一次）。 */
  let largeBytes = 0
  let largeTotalLines = 0
  /** 后台算出的词数；算完前是 null（状态行不占位）。 */
  let largeWords: number | null = null
  let cancelWordScan: (() => void) | null = null

  /**
   * 大文件模式：不解析、不建块，整篇挂一个裸 CM6 当可编辑缓冲。
   *
   * 为什么不是块 IR：块级 IR 的成本几乎只由**块数**决定。分块解析把缩放拉成了线性，
   * 但编辑档没有屏外跳过，大约一万多块之后滚动和编辑就不可用，状态栏也会一直停在
   * 「解析中」（见 MAX_IR_BLOCKS）。CM6 自带视口虚拟化，装得下整篇、只渲染可见行，
   * 于是「能编辑、能保存」这条死线始终成立。
   * 代价是大文件下没有块级预览渲染（只有带语法高亮的纯文本）——这是刻意的降级。
   *
   * 判据分两步（见 HARD_MAX_BYTES / MAX_BLOCK_RUN / MAX_IR_BLOCKS）：
   *   1. 开解析之前的廉价检查（scanText 一遍）：字节上限 + 最长连续非空行；
   *   2. 首屏解析出前若干块后，按密度投影全文块数（projectBlockCount）。
   *
   * 写盘仍走 applyEncoding：载入时已按 createSourceDocument 归一换行，未编辑时
   * 还原后与原文字节恒等（core 的文件级测试盯着这条）。
   *
   * 状态本体（largeMode / largeCm / largeDirty / largeBytes / largeTotalLines）
   * 声明在文件顶部 session 旁边：模块初始化期 renderStatus 就会读它们。
   */

  /** 开解析前的廉价检查。顺带记下提示条要用的体积与行数。 */
  function configure(text: string, bytes: number): boolean {
    const scan = scanText(text)
    largeBytes = bytes
    largeTotalLines = scan.lines
    largeMode = precheckTooLarge(bytes, scan.longestRun)
    if (largeMode) largeDirty = false
    return largeMode
  }

  /** 首屏解析完后的块数投影检查：超预算则转大文件模式，返回是否已是大文件。 */
  function overBlockBudget(headBlocks: number, headEnd: number, totalLen: number): boolean {
    if (!largeMode && projectedTooLarge(headBlocks, headEnd, totalLen)) {
      largeMode = true
      largeDirty = false
    }
    return largeMode
  }

  /** 大文件模式的常驻提示条（复用既有提示条外观，不新增视觉语言）。 */
  function showLargeFileBar(): void {
    clearLargeFileBar()
    const bar = document.createElement('div')
    bar.className = 'recover-bar large-file-bar'
    bar.setAttribute('role', 'status')
    const text = document.createElement('span')
    text.className = 'recover-text'
    text.textContent = t('largeFileNotice', {
      size: (largeBytes / 1048576).toFixed(1),
      lines: formatCount(largeTotalLines),
    })
    bar.append(text)
    document.body.appendChild(bar)
  }

  function clearLargeFileBar(): void {
    document.querySelector('.large-file-bar')?.remove()
  }

  /** 大文件的可编辑载体：整篇裸 CM6 铺满正文区，自己滚动（视口虚拟化）。
   * 不挂结构键——没有块可拆合，Enter 就是普通换行。
   */
  function mountLargeDocument(): void {
    const host = document.createElement('div')
    host.className = 'large-doc-host'
    contentEl.appendChild(host)
    largeCm = mountEditor(
      host,
      getSourceText(),
      () => {
        /* 大文件不逐键取全文：脏状态由 onDocChanged 驱动 */
      },
      {
        autoCharacterPairs: getSettings().autoCharacterPairs,
        showWhitespace: getSettings().showWhitespace,
        pasteHtmlAsMarkdown: true,
        largeDocument: true,
        onDocChanged: () => {
          largeDirty = true
          onDirty()
        },
        onSelectionChange: (sel) => {
          if (!sel || !largeCm) {
            closeSelectionBubble()
            return
          }
          openSelectionBubble(sel, largeCm.view)
        },
      },
    )
    // CM 自己滚动：#content 不再是滚动容器，顶栏分隔影与阅读位置跟着它的滚动容器走。
    const scroller = largeCm.view.scrollDOM
    scroller.addEventListener(
      'scroll',
      () => {
        document.getElementById('titlebar')?.classList.toggle('scrolled', scroller.scrollTop > 4)
        onScroll()
      },
      { passive: true },
    )
    // 词数后台算一次（分片，不阻塞输入）。算完刷新状态行；换文档时取消。
    cancelWordScan?.()
    largeWords = null
    cancelWordScan = countLargeWords(getSourceText(), (words) => {
      largeWords = words
      cancelWordScan = null
      onWordsReady?.()
    })
  }

  /** 大文件下用于写盘 / 状态 / 复制的全文（只在保存等少数时机取一次）。 */
  function largeText(): string {
    return largeCm ? largeCm.view.state.doc.toString() : (getSourceText())
  }

  function destroy(): void {
    cancelWordScan?.()
    cancelWordScan = null
    largeCm?.destroy()
    largeCm = null
  }

  function deactivate(): void {
    largeMode = false
  }

  /** 保存成功：脏标记归零。载入 / 保存的全文基线由 documentEditor 维护。 */
  function markSaved(): void {
    largeDirty = false
  }

  return {
    configure,
    overBlockBudget,
    destroy,
    deactivate,
    markSaved,
    mountLargeDocument,
    showLargeFileBar,
    clearLargeFileBar,
    largeText,
    isActive: () => largeMode,
    isDirty: () => largeDirty,
    getView: () => largeCm?.view ?? null,
    getInfo: () => ({ bytes: largeBytes, totalLines: largeTotalLines, words: largeWords }),
    revealFind: (hits: FindMatch[], current: number) => largeCm?.applyFind(hits, current),
    clearFind: () => largeCm?.clearFind(),
  }
}
