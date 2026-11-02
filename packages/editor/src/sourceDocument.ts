import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import type { EditorState, Text } from '@codemirror/state'
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
  /**
   * CM 自己的历史见底时往外交（块级撤销 / 切档撤销）。
   *
   * 整篇 CM 的撤销链只有它自己那份 EditorState：切档前在别的编辑面里做的改动，
   * 它一无所知。历史走完还没撤到东西，就轮到边界上存的那条快照（见 undoModeSwitch）。
   */
  onUndoFallback(): boolean
}

/**
 * 源码档的整篇编辑器。
 *
 * 和 largeDocument 的整篇裸 CM 是同一种东西：正文区只有一个 CodeMirror，
 * 文档就是它的文本，空行、行号、撤销都落在这一份状态上。
 * 差别只在适用面——大文件是「块 IR 装不下」的降级；源码档是普通文档主动切过来看原文。
 * 所以这里保留 Markdown 高亮和阅读字号，不锁死档位，也不挂大文件提示条。
 */
export function createSourceEditor({
  contentEl,
  onDocChanged,
  onScroll,
  onUndoFallback,
}: SourceDocumentDeps) {
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
   * 上一次卸载时留下的状态（撤销栈就在里面）。
   *
   * 切档会 destroy 掉 CM，历史跟着走。用户的心智是「我刚删了东西，切个档
   * 再按 ⌘Z 应该能撤回」——所以只要正文没被别人改动过，就把这份状态接回去，
   * 和块档的 blockHistory 是同一套做法。
   */
  let savedState: EditorState | null = null

  /**
   * 挂上整篇编辑器。
   *
   * @param text  正文区要显示的文本（脏文档是块拼出来的，净文档是磁盘原文）
   * @param diskText 磁盘上的原文（判脏与写回的基准）
   */
  function mount(text: string, diskText: string): void {
    // 挂载前的卸载是「切档往返」语义：savedState 要留下来给本次挂载接回
    destroy(true)
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
        // 整篇一份 CM：查找高亮这类「整篇才做得了」的能力挂这个标记。
        wholeDocument: true,
        // 正文没变过就接回上次的撤销栈（见 savedState）。
        ...(savedState ? { initialState: savedState } : {}),
        onUndoFallback,
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
   * 用整篇正文替换编辑器内容（撤销「切档前那一版」用）。
   *
   * 不进撤销链：这一下本身就是「撤销」的结果，再让它可撤销会变成
   * 撤一次多一步的套娃。
   */
  function replaceAll(raw: string): void {
    if (!cm) return
    const view = cm.view
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: raw.replace(/\r\n?/g, '\n') },
      annotations: Transaction.addToHistory.of(false),
    })
  }

  /**
   * 挂上编辑器时的那份正文（原文形态，带原行尾）。
   *
   * 「这次编辑是从哪开始的」——切档时用它压一条撤销项：用户在源码档里改了一堆，
   * 离开后按 ⌘Z 应该回到刚进源码档的样子，而不是回到某个中间态。
   */
  function mountedText(): string {
    return loaded
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

  /**
   * 卸载编辑器。
   *
   * @param keepHistory true = 切档：收下 EditorState，下次挂载接回撤销栈；
   *                    false = 换文档 / 关文档：连同 savedState 一起丢掉，
   *                    旧文档的撤销历史绝不能流进下一篇。
   */
  function destroy(keepHistory: boolean): void {
    // 先收下状态再拆：撤销栈只存在于这份 EditorState 里。
    // 记的是「卸载那一刻的正文」，下次挂载若还是同一份正文才接得回去
    // （正文被别人改过却接回旧历史，撤销会跳到不存在的文本上）。
    if (keepHistory && cm) savedState = cm.view.state
    else if (!keepHistory) savedState = null
    cm?.destroy()
    cm = null
    disk = null
    mounted = null
    contentEl.classList.remove('source-doc')
    contentEl.querySelector(':scope > .source-doc-host')?.remove()
  }

  return {
    mount,
    destroy,
    text,
    mountedText,
    replaceAll,
    isDirty,
    changedSinceMount,
    editedText,
    saveText,
    markSaved,
    isActive: () => cm !== null,
    getView: () => cm?.view ?? null,
    revealFind: (hits: FindMatch[], current: number) => cm?.applyFind(hits, current),
    clearFind: () => cm?.clearFind(),
  }
}
