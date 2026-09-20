import { mountEditor, type CmHandle } from './cm.ts'
import type { FindMatch } from './findMatch.ts'
import { getSettings } from './settings.ts'
import { closeSelectionBubble, openSelectionBubble } from './selectionBubble.ts'
import { formatCount } from '@lector/core'
import { t } from './i18n.ts'

interface LargeDocumentDeps {
  contentEl: HTMLElement
  getSourceText(): string
  onDirty(): void
  onScroll(): void
}

export function createLargeDocument({ contentEl, getSourceText, onDirty, onScroll }: LargeDocumentDeps) {
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

  /**
   * 大文件模式：不解析、不建块，整篇挂一个裸 CM6 当可编辑缓冲。
   *
   * 为什么不是块 IR：整篇 mdast 解析是超线性的（实测 1MB≈1.1s、3MB≈4.2s、10MB≈31s），
   * 几十 MB 的文件根本解析不完；块级 DOM 也会把浏览器压死。而 CM6 自带视口虚拟化，
   * 装得下整篇、只渲染可见行，于是「能编辑、能保存」这条死线成立。
   * 代价是大文件下没有块级预览渲染（只有带语法高亮的纯文本）——这是刻意的降级。
   * 可编辑的窗口化 IR 是后续独立排期的方向。
   *
   * 写盘仍走 applyEncoding：载入时已按 createSourceDocument 归一换行，未编辑时
   * 还原后与原文字节恒等（core 的文件级测试盯着这条）。
   *
   * 状态本体（largeMode / largeCm / largeDirty / largeBytes / largeTotalLines）
   * 声明在文件顶部 session 旁边：模块初始化期 renderStatus 就会读它们。
   */
  const LARGE_FILE_BYTES = 3 * 1024 * 1024
  const LARGE_FILE_LINES = 40_000

  function countLines(text: string): number {
    let n = 0
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) n++
    }
    return n
  }

  /**
   * 大文件判据：真实字节数 OR 行数。
   * 字节优先命中就不必再扫行数；用字节而不是 `text.length`，因为后者是 UTF-16 码元，
   * 会把中文文档的阈值抬高约 3 倍，也和用户在资源管理器里看到的大小对不上。
   */
  function isLargeDocument(bytes: number, text: string): boolean {
    if (bytes > LARGE_FILE_BYTES) return true
    return countLines(text) > LARGE_FILE_LINES
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

  /**
   * 大文件的可编辑载体：整篇裸 CM6 铺满正文区，自己滚动（视口虚拟化）。
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
  }

  /** 大文件下用于写盘 / 状态 / 复制的全文（只在保存等少数时机取一次）。 */
  function largeText(): string {
    return largeCm ? largeCm.view.state.doc.toString() : (getSourceText())
  }

  function configure(text: string, bytes: number): boolean {
    largeMode = isLargeDocument(bytes, text)
    if (largeMode) {
      largeDirty = false
      largeBytes = bytes
      largeTotalLines = countLines(text)
    }
    return largeMode
  }

  function destroy(): void {
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
    getInfo: () => ({ bytes: largeBytes, totalLines: largeTotalLines }),
    revealFind: (hits: FindMatch[], current: number) => largeCm?.applyFind(hits, current),
    clearFind: () => largeCm?.clearFind(),
  }
}
