// 自绘 Tooltip：替代 `title=` 原生提示。
//
// 设计要点：
// - 委托监听 document：任何带 `data-tip="…"` 的元素都自动有 tooltip，
//   不需要每个按钮单独绑定——11+ 个 title= 替换为零散的属性，不增加额外接线。
// - 鼠标：进入 300ms 后显示；同一组件群内上一个关闭后 800ms 窗口内即时出现
//   （横扫一组按钮时无延迟，参考 notefast Tooltip 的「skip-delay」）。
// - 键盘：focus 即时显示（屏幕阅读器/键盘导航可达）；blur 关闭。
// - 定位：上方空间够就放上方，否则翻到下方。水平居中，贴屏幕边缘时夹到 56px 内边距。
// - 单例 tipEl：全局一个浮层，move 时只更新 style，不重建 DOM。
// - 跨域安全：data-tip 是用户/产品文案，不会带 HTML 实体；用 textContent 而非 innerHTML。

let tipEl: HTMLDivElement | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let currentAnchor: HTMLElement | null = null
let lastHideAt = 0

const SHOW_DELAY_MS = 300
const GROUP_WINDOW_MS = 800
const EDGE_PAD = 56

function ensureTip(): HTMLDivElement {
  if (tipEl) return tipEl
  const el = document.createElement('div')
  el.className = 'tip'
  el.setAttribute('role', 'tooltip')
  el.hidden = true
  document.body.appendChild(el)
  tipEl = el
  return el
}

function cancelTimer(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
}

function place(el: HTMLDivElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  const above = r.top >= 40
  el.style.left = `${Math.min(Math.max(r.left + r.width / 2, EDGE_PAD), window.innerWidth - EDGE_PAD)}px`
  el.style.top = above ? `${r.top - 6}px` : `${r.bottom + 6}px`
  el.dataset.side = above ? 'top' : 'bottom'
}

function show(anchor: HTMLElement): void {
  const text = anchor.dataset.tip?.trim()
  if (!text) return
  const el = ensureTip()
  currentAnchor = anchor
  el.textContent = text
  el.hidden = false
  place(el, anchor)
}

function hide(): void {
  cancelTimer()
  if (tipEl) tipEl.hidden = true
  if (currentAnchor) lastHideAt = Date.now()
  currentAnchor = null
}

function scheduleShow(anchor: HTMLElement): void {
  cancelTimer()
  const delay = Date.now() - lastHideAt < GROUP_WINDOW_MS ? 0 : SHOW_DELAY_MS
  showTimer = setTimeout(() => show(anchor), delay)
}

export function mountTip(): () => void {
  const onPointerOver = (e: PointerEvent) => {
    const anchor = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
    if (!anchor) return
    if (anchor === currentAnchor) return
    scheduleShow(anchor)
  }
  const onPointerOut = (e: PointerEvent) => {
    const anchor = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
    if (!anchor) return
    // 只有离开当前 anchor 才关：从一个带 tip 的元素进入另一个也要重排
    const related = (e.relatedTarget as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
    if (related && related !== anchor) {
      scheduleShow(related)
    } else if (!related) {
      hide()
    }
  }
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null
    const anchor = target?.closest<HTMLElement>('[data-tip]')
    if (!anchor) return
    show(anchor)
  }
  const onFocusOut = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null
    const anchor = target?.closest<HTMLElement>('[data-tip]')
    if (!anchor) return
    const next = (e.relatedTarget as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
    if (!next) hide()
  }
  const onWindowChange = () => {
    // 滚动/缩放后位置失效,关掉（用户移回鼠标时会再触发 pointerover）
    if (currentAnchor) hide()
  }

  document.addEventListener('pointerover', onPointerOver)
  document.addEventListener('pointerout', onPointerOut)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  window.addEventListener('scroll', onWindowChange, true)
  window.addEventListener('resize', onWindowChange)

  return () => {
    document.removeEventListener('pointerover', onPointerOver)
    document.removeEventListener('pointerout', onPointerOut)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('scroll', onWindowChange, true)
    window.removeEventListener('resize', onWindowChange)
    if (tipEl) {
      tipEl.remove()
      tipEl = null
    }
  }
}
