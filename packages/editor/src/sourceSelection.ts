import type { BlockView } from '@lector/core'
import type { EditorView } from '@codemirror/view'
import { coveredSource, type SpanPoint } from './sourceSpan.ts'

export interface MappedSourceSpan {
  startId: string
  startOffset: number
  endId: string
  endOffset: number
  /** 端点之间的原文，含中间的空白缝。 */
  text: string
}

export type SourceKeyAction = { kind: 'replace'; text: string } | { kind: 'ignore' }

/** 源码档跨块选区上，这一键要不要换成一段文字。组合输入、带修饰键的快捷键都不碰。 */
export function sourceKeyAction(key: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing: boolean
}): SourceKeyAction {
  if (key.isComposing || key.key === 'Process') return { kind: 'ignore' }
  if (key.metaKey || key.ctrlKey || key.altKey) return { kind: 'ignore' }
  if (key.key === 'Backspace' || key.key === 'Delete') return { kind: 'replace', text: '' }
  if (key.key === 'Enter') return { kind: 'replace', text: '\n' }
  if (key.key.length === 1) return { kind: 'replace', text: key.key }
  return { kind: 'ignore' }
}

/** 事件目标是输入框或别的可编辑控件时，选区编辑不能把键抢走。聚焦块里的 CM 除外。 */
export function isForeignEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select')) return true
  const editable = target.closest('[contenteditable="true"]')
  if (!editable) return false
  return editable.closest('.cm-host') == null
}

function blockOf(node: Node): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement
  return el?.closest<HTMLElement>('.block[data-block-id]') ?? null
}

function textOffset(root: Node, node: Node, offset: number): number | null {
  if (node === root) {
    let acc = 0
    const children = root.childNodes
    for (let i = 0; i < offset && i < children.length; i++) acc += children[i]!.textContent?.length ?? 0
    return acc
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    const data = current.textContent ?? ''
    if (current === node) {
      if (offset < 0 || offset > data.length) return null
      return acc + offset
    }
    acc += data.length
  }
  return null
}

/**
 * 把选区的一端映射到块 raw 的偏移。
 * 对不上（不是源码文本、和 raw 不一致、落在把手上）就返回 null，调用方必须放弃这次编辑。
 */
function pointInBlock(
  node: Node,
  offset: number,
  blocks: readonly BlockView[],
  cm: EditorView | null,
  focusedId: string | null,
): { id: string; offset: number } | null {
  const blockEl = blockOf(node)
  if (!blockEl) return null
  const id = blockEl.dataset.blockId
  if (!id) return null
  const block = blocks.find((item) => item.id === id)
  if (!block) return null

  const host = (node instanceof Element ? node : node.parentElement)?.closest('.cm-host')
  if (host && blockEl.contains(host)) {
    if (!cm || focusedId !== id || !cm.contentDOM.contains(node)) return null
    if (cm.state.doc.toString() !== block.raw) return null
    const pos = cm.posAtDOM(node, offset)
    if (pos < 0 || pos > block.raw.length) return null
    return { id, offset: pos }
  }

  const code = blockEl.querySelector(':scope > .source-view > code')
  if (!(code instanceof HTMLElement) || code.textContent !== block.raw) return null
  const pre = code.parentElement
  if (node === pre) return { id, offset: offset <= 0 ? 0 : block.raw.length }
  if (node === blockEl) {
    const child = blockEl.childNodes[offset]
    if (!child || child === pre || (pre != null && child.contains(pre))) return { id, offset: 0 }
    return { id, offset: block.raw.length }
  }
  if (!code.contains(node) && node !== code) return null
  const rawOffset = textOffset(code, node, offset)
  if (rawOffset == null || rawOffset < 0 || rawOffset > block.raw.length) return null
  return { id, offset: rawOffset }
}

/** 选区有一端落在聚焦块的编辑器里，写回 raw 之后偏移才对得上。整段都在里面时不必写回。 */
export function selectionTouchesCodeMirror(sel: Selection): boolean {
  const range = sel.getRangeAt(0)
  const touches = (node: Node) => {
    const el = node instanceof Element ? node : node.parentElement
    return el?.closest('.cm-host') != null
  }
  return touches(range.startContainer) || touches(range.endContainer)
}

/** 选区整段落在当前这一块的编辑器里：删除、复制都该留给它，不要再走跨块拼接。 */
export function selectionHandledByFocusedEditor(sel: Selection | null, contentRoot: HTMLElement): boolean {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!contentRoot.contains(range.startContainer) || !contentRoot.contains(range.endContainer)) return false
  return insideOneCm(range)
}

function insideOneCm(range: Range): boolean {
  const start = blockOf(range.startContainer)
  const end = blockOf(range.endContainer)
  if (!start || start !== end) return false
  const host = start.querySelector('.cm-host')
  if (!host) return false
  return host.contains(range.startContainer) && host.contains(range.endContainer)
}

/**
 * 源码档里一段非折叠选区对应的原文区间。
 * 整段都在当前聚焦块的编辑器里时返回 null，删除交给那一个 CM。
 */
export function mapSourceSelection(
  sel: Selection | null,
  blocks: readonly BlockView[],
  contentRoot: HTMLElement,
  cm: EditorView | null,
  focusedId: string | null,
): MappedSourceSpan | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!contentRoot.contains(range.startContainer) || !contentRoot.contains(range.endContainer)) return null
  if (insideOneCm(range)) return null
  const start = pointInBlock(range.startContainer, range.startOffset, blocks, cm, focusedId)
  const end = pointInBlock(range.endContainer, range.endOffset, blocks, cm, focusedId)
  if (!start || !end) return null
  const startIndex = blocks.findIndex((block) => block.id === start.id)
  const endIndex = blocks.findIndex((block) => block.id === end.id)
  if (startIndex < 0 || endIndex < 0) return null
  const a: SpanPoint = { index: startIndex, offset: start.offset }
  const b: SpanPoint = { index: endIndex, offset: end.offset }
  const text = coveredSource(blocks, a, b)
  if (!text) return null
  const forward = startIndex < endIndex || (startIndex === endIndex && start.offset <= end.offset)
  const from = forward ? start : end
  const to = forward ? end : start
  return {
    startId: from.id,
    startOffset: from.offset,
    endId: to.id,
    endOffset: to.offset,
    text,
  }
}
