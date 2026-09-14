/**
 * 编辑态的选区浮条：选中一段文字后，在选区上方浮出「加粗 / 斜体 / 行内代码 / 链接」。
 *
 * 为什么是「选中才出现」而不是常驻工具栏：
 *   - 阅读优先的产品里，常驻工具条会一直占着一行，且只对编辑的那一小段时间有用；
 *   - 键盘已有 ⌘B/⌘I/⌘E/⌘K，右键里也有这些项，缺的只是「选中之后那一眼看得见」。
 *     浮条正好补这个缺口，代价是零常驻像素。
 *
 * 三条必须做对的细节（都是从 notefast 的同类实现里学到的坑）：
 *
 * 1. **面板 mousedown 要 preventDefault**。否则点击按钮的瞬间编辑器失焦、选区塌陷，
 *    回调收到 null 把面板收起来——click 根本没机会触发，表现是「按钮点不动」。
 * 2. 位置：选区上方居中；上方放不下就翻到下方；两边都 clamp 在视口内 8px。
 * 3. 选区一变就要么跟着走、要么收起：空选区/失焦/滚动/Resize 都收起，
 *    绝不让它悬在一个已经不存在的位置上。
 */

import type { EditorView } from '@codemirror/view'
import { t } from './i18n.ts'
import { iconSvg } from './icons.ts'
import { formatSelection } from './cm.ts'

export interface BubbleSelection {
  text: string
  from: number
  to: number
  rect: DOMRect
}

let panel: HTMLElement | null = null
let view: EditorView | null = null
let current: BubbleSelection | null = null
let detach: (() => void) | null = null

const KIND_ICON = { bold: 'bold', italic: 'italic', code: 'code', link: 'link' } as const
type Kind = keyof typeof KIND_ICON

function kindLabel(kind: Kind): string {
  return kind === 'bold'
    ? t('fmtBold')
    : kind === 'italic'
      ? t('fmtItalic')
      : kind === 'code'
        ? t('fmtCode')
        : t('fmtLink')
}

function build(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'selection-bubble'
  el.setAttribute('role', 'toolbar')
  el.setAttribute('aria-label', t('fmtToolbar'))
  // 见文件头第 1 条：没有这一行，按钮会「点不动」
  el.addEventListener('mousedown', (e) => e.preventDefault())
  for (const kind of Object.keys(KIND_ICON) as Kind[]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'selection-bubble-btn'
    btn.dataset.kind = kind
    btn.dataset.tip = kindLabel(kind)
    btn.setAttribute('aria-label', kindLabel(kind))
    btn.innerHTML = iconSvg(KIND_ICON[kind], 15)
    btn.addEventListener('click', () => {
      if (view) formatSelection(view, kind)
      close()
    })
    el.appendChild(btn)
  }
  return el
}

function place(rect: DOMRect): void {
  if (!panel) return
  const pad = 8
  const gap = 8
  const w = panel.offsetWidth
  const h = panel.offsetHeight
  const cx = rect.left + rect.width / 2
  const left = Math.max(pad, Math.min(cx - w / 2, window.innerWidth - w - pad))
  // 默认在选区上方；贴到顶边就翻到下方（翻转比裁掉好，也比重叠在文字上强）
  let top = rect.top - h - gap
  if (top < pad) top = Math.min(rect.bottom + gap, window.innerHeight - h - pad)
  panel.style.left = `${Math.round(left)}px`
  panel.style.top = `${Math.round(top)}px`
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
/** 滚动/改窗口尺寸都会让浮条的位置失效，直接收起（比跟着飘更干净） */
const onUnstable = () => close()

function close(): void {
  if (!panel) return
  panel.hidden = true
  current = null
  view = null
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('scroll', onUnstable, true)
  window.removeEventListener('resize', onUnstable)
  document.removeEventListener('mousedown', onOutside, true)
}

function onOutside(e: MouseEvent): void {
  if (panel && e.target instanceof Node && panel.contains(e.target)) return
  close()
}

/** 每次收到新的非空选区都重开一次监听，保证收起后不留悬挂的全局监听 */
function arm(): void {
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', onUnstable, true)
  window.addEventListener('resize', onUnstable)
  document.addEventListener('mousedown', onOutside, true)
}

export function openSelectionBubble(sel: BubbleSelection, editor: EditorView): void {
  if (!panel) {
    panel = build()
    document.body.appendChild(panel)
    detach = () => {
      close()
      panel?.remove()
      panel = null
      detach = null
    }
  }
  // 选区没变就不重排（CM 的每次按键都会推一次 update，避免浮条抖）
  const same =
    current !== null && current.from === sel.from && current.to === sel.to && !panel.hidden
  current = sel
  view = editor
  panel.hidden = false
  if (!same) {
    place(sel.rect)
    arm()
  }
}

export function closeSelectionBubble(): void {
  close()
}

/** 退出编辑态/换块时把浮条收干净（调用一次，返回解绑） */
export function mountSelectionBubble(): () => void {
  return () => detach?.()
}
