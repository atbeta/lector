import { EditorView } from '@codemirror/view'
import { mountEditor, type CmHandle } from './cm.ts'
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

  function mount(text: string): void {
    destroy()
    loaded = text
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

  function destroy(): void {
    cm?.destroy()
    cm = null
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
    loadedText: () => loaded,
    isActive: () => cm !== null,
    getView: () => cm?.view ?? null,
    reveal,
    revealFind: (hits: FindMatch[], current: number) => cm?.applyFind(hits, current),
    clearFind: () => cm?.clearFind(),
  }
}
