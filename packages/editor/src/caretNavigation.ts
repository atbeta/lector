import type { EditorView } from '@codemirror/view'

/** 点击或方向键跨块后，光标要落到哪里。 */
export type CaretIntent =
  | { mode: 'coords'; x: number; y: number }
  | { mode: 'start'; x?: number }
  | { mode: 'end'; x?: number }
  /** 落到块内某个字符偏移（图片动作「编辑源码」用：把光标放到图片语法上）。 */
  | { mode: 'pos'; pos: number }

export function placeCaret(view: EditorView, intent: CaretIntent) {
  const doc = view.state.doc
  let pos: number | null = null
  if (intent.mode === 'coords') {
    pos = view.posAtCoords({ x: intent.x, y: intent.y })
  } else if (intent.mode === 'pos') {
    pos = Math.max(0, Math.min(doc.length, intent.pos))
  } else if (intent.mode === 'start') {
    if (intent.x == null) pos = 0
    else {
      const line = doc.line(1)
      const c = view.coordsAtPos(line.from)
      pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : 0
    }
  } else if (intent.x == null) {
    pos = doc.length
  } else {
    const line = doc.line(doc.lines)
    const c = view.coordsAtPos(line.to)
    pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : doc.length
  }
  if (pos == null) pos = intent.mode === 'end' ? doc.length : 0
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
}

export function caretX(view: EditorView): number | undefined {
  return view.coordsAtPos(view.state.selection.main.head)?.left
}

export function atVisualVerticalEdge(view: EditorView, down: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const moved = view.moveVertically(sel, down)
  if (moved.head === sel.head) return true
  // 单行块上 moveVertically 常把光标挪到行尾，head 变了但还在同一视觉行
  const a = view.coordsAtPos(sel.head)
  const b = view.coordsAtPos(moved.head)
  if (!a || !b) return true
  return a.top < b.bottom && b.top < a.bottom
}

export function atHorizontalEdge(view: EditorView, right: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  return right ? sel.head === view.state.doc.length : sel.head === 0
}
