/**
 * 正文的三种承载，一张统一的脸。
 *
 * 文档正文可以住在三处：块表（session.blocks）、源码档的整篇 CM
 * （sourceDocument.ts）、大文件档的整篇裸 CM（largeDocument.ts）。
 * 0.39.x 那批 bug（脏标记不翻、查找不高亮、草稿过期、图片写丢）全是同一类：
 * 某个功能忘了其中一个承载。于是所有「读/写正文」的功能操作都收敛到
 * 这个接口——新功能要在这里多一个方法时，三个承载必须各自给出实现，
 * 漏一个就是编译错，而不是又一颗静默的雷。
 *
 * 状态机的进出（ensureSourceView / commitSourceView / render 的早退、
 * 解析暂停、挂载守卫）不归它管：那些本来就只跟某一个承载的生命周期说话。
 */

import type { EditorView } from '@codemirror/view'
import { undo as cmUndo, undoDepth } from '@codemirror/commands'
import type { FindHost } from './findBar.ts'
import type { FindMatch } from './findMatch.ts'

export type SurfaceKind = 'blocks' | 'source' | 'large'

export interface DocumentSurface {
  readonly kind: SurfaceKind
  /** 当前正文，统计 / 复制全文用（allRawText 的现行口径，源码档是 CM 的 LF 文本）。 */
  text(): string
  /** 存盘与恢复草稿要写的正文。没改过必须是磁盘原文（字节级一致）。不得有副作用。 */
  saveText(): string
  isDirty(): boolean
  /** 存盘成功后换基线。 */
  markSaved(normalized: string): void
  /** 整篇 CM 的视图；块档为 null。 */
  wholeView(): EditorView | null
  /** 正文滚动容器。 */
  scroller(): HTMLElement | null
  insertAtCaret(md: string): void
  /** 纯文本替换第一处命中；没命中返回 false。 */
  replaceText(find: string, replacement: string): boolean
  /** 查找栏的接入参数；整篇 CM 还没挂上时返回 null。 */
  findTarget(): FindHost | null
  /** 整篇 CM 自己的撤销历史还有就撤一步并返回 true；块档恒为 false。 */
  undoHistory(): boolean
  /** 切档撤销的落点：把整篇换成 raw。大文件档不支持，返回 false。 */
  restoreWhole(raw: string): boolean
}

/** 整篇 CM 两个承载各自不同的部分；其余操作由工厂写一遍共用。 */
export interface WholeDocumentSurfaceDeps {
  kind: 'source' | 'large'
  view(): EditorView | null
  text(): string
  saveText(): string
  isDirty(): boolean
  markSaved(normalized: string): void
  /** 查找高亮的落地，两个承载各有一份实现。 */
  revealFind(hits: FindMatch[], current: number): void
  clearFind(): void
  /** 切档撤销的落点：源码档 replaceAll，大文件档恒 false。 */
  restoreWhole(raw: string): boolean
}

/**
 * 源码档与大文件档是同一种东西——正文区只有一个整篇 CodeMirror。
 * 插入、替换、查找接入、滚动容器、撤销历史在这里只写一遍；
 * 两个承载各自不同的（正文口径、判脏、基线、换正文）由 deps 传入。
 */
export function createWholeDocumentSurface(deps: WholeDocumentSurfaceDeps): DocumentSurface {
  return {
    kind: deps.kind,
    text: () => deps.text(),
    saveText: () => deps.saveText(),
    isDirty: () => deps.isDirty(),
    markSaved: (normalized) => deps.markSaved(normalized),
    wholeView: () => deps.view(),
    scroller: () => deps.view()?.scrollDOM ?? null,
    insertAtCaret: (md) => {
      const view = deps.view()
      if (!view) return
      const pos = view.state.selection.main.head
      view.dispatch({
        changes: { from: pos, insert: md },
        selection: { anchor: pos + md.length },
        scrollIntoView: true,
      })
    },
    replaceText: (find, replacement) => {
      const view = deps.view()
      if (!view) return false
      const at = view.state.doc.toString().indexOf(find)
      if (at < 0) return false
      view.dispatch({ changes: { from: at, to: at + find.length, insert: replacement } })
      return true
    },
    findTarget: () => {
      const view = deps.view()
      if (!view) return null
      return {
        getBlocks: () => [],
        replaceInBlock: () => {},
        scrollTo: () => {},
        sourceFind: {
          getDoc: () => view.state.doc,
          reveal: (hits, current) => deps.revealFind(hits, current),
          clear: () => deps.clearFind(),
        },
      }
    },
    // CM 自己的历史还有就先走它；见底了才轮到块级操作 / 切档快照。
    undoHistory: () => {
      const view = deps.view()
      return !!view && undoDepth(view.state) > 0 && cmUndo(view)
    },
    restoreWhole: (raw) => deps.restoreWhole(raw),
  }
}
