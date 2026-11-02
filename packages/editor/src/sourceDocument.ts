import { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import { restoreLineEndings } from '@lector/core'
import { mountEditor, type CmHandle } from './cm.ts'
import { toCmText } from './sourceText.ts'
import type { FindMatch } from './findMatch.ts'
import { getSettings } from './settings.ts'
import { closeSelectionBubble, openSelectionBubble } from './selectionBubble.ts'

interface SourceDocumentDeps {
  contentEl: HTMLElement
  onDocChanged(): void
  onScroll(): void
}

/**
 * 源码档的整篇编辑器。
 *
 * 和 largeDocument 的整篇裸 CM 是同一种东西：正文区只有一个 CodeMirror，
 * 文档就是它的文本，空行、行号、撤销都落在这一份状态上。
 * 差别只在适用面——大文件是「块 IR 装不下」的降级；源码档是普通文档主动切过来看原文。
 * 所以这里保留 Markdown 高亮和阅读字号，不锁死档位，也不挂大文件提示条。
 */
export function createSourceEditor({ contentEl, onDocChanged, onScroll }: SourceDocumentDeps) {
  let cm: CmHandle | null = null
  /** 挂上编辑器时的全文。没改过离开源码档就不必重解析块。 */
  let loaded = ''
  /** 磁盘上的正文（CM 口径）。判脏和写回都以它为基准。 */
  let disk: Text | null = null
  /** 磁盘原文（未归一换行的形态）。写回时用它还原每行的行尾。 */
  let diskRaw = ''
  /** 挂上时的正文（CM 口径）。用来判「进了源码档之后改过没有」。 */
  let mounted: Text | null = null

  /**
   * 挂上整篇编辑器。
   *
   * @param text  正文区要显示的文本（脏文档是块拼出来的，净文档是磁盘原文）
   * @param diskText 磁盘上的原文（判脏与写回的基准）
   */
  function mount(text: string, diskText: string): void {
    destroy()
    loaded = text
    diskRaw = diskText
    disk = toCmText(diskText)
    mounted = toCmText(text)
    contentEl.classList.add('source-doc')
    const host = document.createElement('div')
    host.className = 'source-doc-host'
    contentEl.appendChild(host)
    cm = mountEditor(
      host,
      text,
      () => {
        /* 全文不在每个键上复制；脏标记走 onDocChanged */
      },
      {
        autoCharacterPairs: getSettings().autoCharacterPairs,
        showWhitespace: getSettings().showWhitespace,
        pasteHtmlAsMarkdown: true,
        lineNumbers: true,
        onDocChanged,
        onSelectionChange: (sel) => {
          if (!sel || !cm) {
            closeSelectionBubble()
            return
          }
          openSelectionBubble(sel, cm.view)
        },
      },
    )
    const scroller = cm.view.scrollDOM
    scroller.addEventListener(
      'scroll',
      () => {
        document.getElementById('titlebar')?.classList.toggle('scrolled', scroller.scrollTop > 4)
        onScroll()
      },
      { passive: true },
    )
    cm.view.focus()
  }

  function text(): string {
    return cm ? cm.view.state.doc.toString() : loaded
  }

  /**
   * 正文与磁盘原文相比是不是改过。
   *
   * 按 CM 口径比（CM 里只有 LF，磁盘原文可能是 CRLF / 混合换行）：
   * 直接比字符串会把没动过的 CRLF 文件判成已改，反过来也会漏掉真改动。
   */
  function isDirty(): boolean {
    if (!cm || !disk) return false
    return !cm.view.state.doc.eq(disk)
  }

  /** 进了源码档之后正文有没有被改过（按 CM 口径比）。 */
  function changedSinceMount(): boolean {
    if (!cm || !mounted) return false
    return !cm.view.state.doc.eq(mounted)
  }

  /**
   * 现在的正文（按原文的行尾还原）。
   *
   * CM 里只有 LF 形态，磁盘原文可能是 CRLF / 混合换行：直接交出 CM 的文本，
   * 没动过的行会只因换行写法变了就改字节。
   */
  function editedText(): string {
    if (!cm) return diskRaw
    return restoreLineEndings(cm.view.state.doc.toString(), diskRaw)
  }

  /**
   * 存盘要写出去的正文。
   *
   * 没改过就写磁盘原文（字节级一致，产品红线）；改过才写当前正文。
   */
  function saveText(): string {
    if (!cm) return diskRaw
    if (!isDirty()) return diskRaw
    return editedText()
  }

  /** 存盘成功：磁盘基线换成刚写下去的内容。 */
  function markSaved(saved: string): void {
    diskRaw = saved
    disk = toCmText(saved)
  }

  function destroy(): void {
    cm?.destroy()
    cm = null
    disk = null
    mounted = null
    contentEl.classList.remove('source-doc')
    contentEl.querySelector(':scope > .source-doc-host')?.remove()
  }

  function reveal(pos: number): void {
    const view = cm?.view
    if (!view) return
    const at = Math.max(0, Math.min(pos, view.state.doc.length))
    view.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: 'start' }),
    })
    view.focus()
  }

  return {
    mount,
    destroy,
    text,
    isDirty,
    changedSinceMount,
    editedText,
    saveText,
    markSaved,
    isActive: () => cm !== null,
    getView: () => cm?.view ?? null,
    reveal,
    revealFind: (hits: FindMatch[], current: number) => cm?.applyFind(hits, current),
    clearFind: () => cm?.clearFind(),
  }
}
