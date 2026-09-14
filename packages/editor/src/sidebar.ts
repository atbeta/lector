// 左侧停靠侧栏：当前文档的目录。
//
// 为什么是停靠而不是浮层：大纲是「这篇文档的目录」，属于文档本身。
// 停靠时正文让位并重新居中；浮层语义是「临时工具」，与目录的地位不符。
// 只有窗口放不下「正文 640 + 侧栏 + 留白」时才退化成浮层——那时候盖住一点，
// 好过把正文挤到 400px 宽。
//
// 正文在「扣掉侧栏之后的轨道」里 margin:auto 居中。没有额外做屏幕级补偿：
// 主流阅读器（Notion / Obsidian / Bear）都是这样，正文落在视觉重心略偏右的位置，
// 反而比强行对屏幕居中更稳——后者在窗口变窄时会把正文推出右边缘。
//
// 开合状态存 localStorage：这是查看偏好，不是文档内容，不进设置 schema。

import { t } from './i18n.ts'

const LS_KEY = 'lector-sidebar'
/** 侧栏宽度。grid 轨道与 .sidebar 的宽都要与它一致（见 app.css）。 */
export const SIDEBAR_W = 288
/** 低于这个宽度就退化成浮层：侧栏 + 正文 + 两侧留白 */
const DOCK_MIN = SIDEBAR_W + 640 + 150

export type SidebarMode = 'docked' | 'overlay' | 'hidden'

export interface Sidebar {
  readonly el: HTMLElement
  readonly body: HTMLElement
  isOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  mode(): SidebarMode
  sync(): void
  /** 侧栏标题右侧的小节计数（0 时留空，不显示「0 节」这种废话）。 */
  setCount(n: number): void
}

function readPref(): boolean | null {
  try {
    const v = localStorage.getItem(LS_KEY)
    return v === null ? null : v === 'open'
  } catch {
    return null
  }
}

function writePref(open: boolean): void {
  try {
    localStorage.setItem(LS_KEY, open ? 'open' : 'closed')
  } catch {
    /* 忽略持久化失败 */
  }
}

export function createSidebar(opts: { onToggle?: (open: boolean) => void } = {}): Sidebar {
  const el = document.createElement('aside')
  el.className = 'sidebar'
  el.id = 'sidebar'
  el.setAttribute('aria-label', '大纲')

  // 标题行：一列目录要有名字。初版直接从条目开始，288px 的白栏看起来像没加载完。
  const head = document.createElement('div')
  head.className = 'sidebar-head'
  const headLabel = document.createElement('span')
  headLabel.textContent = t('outlineTitle')
  const headCount = document.createElement('span')
  headCount.className = 'sidebar-count'
  head.append(headLabel, headCount)

  const body = document.createElement('div')
  body.className = 'sidebar-body'
  el.append(head, body)

  // 插在正文之前：骨架顺序 = 顶栏 / 侧栏 / 正文 / 状态行（见 index.html 注释）
  const content = document.getElementById('content')
  content?.parentElement?.insertBefore(el, content)

  // 初始形态：用户明确选过就听用户的；否则宽窗口默认展开（阅读器里目录默认可见更实用），
  // 窄窗口默认收起——窄窗口下它是要盖住正文的浮层，不该自己弹出来。
  const pref = readPref()
  let open = pref ?? window.innerWidth >= DOCK_MIN

  function mode(): SidebarMode {
    if (!open) return 'hidden'
    return window.innerWidth >= DOCK_MIN ? 'docked' : 'overlay'
  }

  /** 浮层模式的「点外关闭 / Esc 关闭」解绑句柄 */
  let detachOverlay: (() => void) | null = null

  function applyOverlayClose(active: boolean): void {
    if (active === (detachOverlay !== null)) return
    if (!active) {
      detachOverlay?.()
      detachOverlay = null
      return
    }
    // 浮层必须能被随手关掉，否则用户会以为它是常驻侧栏又找不到关闭入口
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.sidebar, #outline-btn')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    detachOverlay = () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }

  function apply(): void {
    const m = mode()
    const root = document.documentElement
    root.classList.toggle('sidebar-docked', m === 'docked')
    root.classList.toggle('sidebar-overlay', m === 'overlay')
    el.toggleAttribute('hidden', !open)
    el.setAttribute('aria-hidden', String(!open))
    applyOverlayClose(m === 'overlay')
  }

  function setOpen(next: boolean): void {
    if (open === next) return
    open = next
    writePref(open)
    apply()
    opts.onToggle?.(open)
  }

  apply()
  // 初始状态也要通知一次，否则按钮的亮/灭与实际不符
  opts.onToggle?.(open)

  return {
    el,
    body,
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    mode,
    sync: apply,
    setCount: (n) => {
      headCount.textContent = n > 0 ? String(n) : ''
    },
  }
}
