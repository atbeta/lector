// 左侧停靠侧栏：当前文档的目录。
//
// 为什么是停靠而不是浮层：大纲是「这篇文档的目录」，属于文档本身。
// 停靠时正文让位并重新居中；浮层语义是「临时工具」，与目录的地位不符。
// 窗口放不下时也不退化成浮层——浮层会盖住正文，而阅读器里正文是主角；
// 放不下就一起挤（正文列有 max-width，变窄仍可读），或关掉侧栏、拖宽窗口。
//
// 正文在「扣掉侧栏之后的轨道」里 margin:auto 居中。没有额外做屏幕级补偿：
// 主流阅读器（Notion / Obsidian / Bear）都是这样，正文落在视觉重心略偏右的位置，
// 反而比强行对屏幕居中更稳——后者在窗口变窄时会把正文推出右边缘。
//
// 开合状态存 localStorage：这是查看偏好，不是文档内容，不进设置 schema。

import { t } from './i18n.ts'

const LS_KEY = 'lector-sidebar'
/** 侧栏宽度的默认值。必须与 base.css 的 `--sidebar-w` 初值一致。 */
export const SIDEBAR_W = 288
/** 宽度可调区间：窄到 200 还能读标题，宽到 420 之后再宽就只剩空白了。 */
const W_MIN = 200
const W_MAX = 420
const W_KEY = 'lector-sidebar-w'

export type SidebarMode = 'docked' | 'hidden'

export interface Sidebar {
  readonly el: HTMLElement
  readonly body: HTMLElement
  isOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  mode(): SidebarMode
  sync(): void
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

function clampW(n: number): number {
  return Math.min(W_MAX, Math.max(W_MIN, Math.round(n)))
}

function readWidthPref(): number {
  try {
    const v = Number.parseInt(localStorage.getItem(W_KEY) ?? '', 10)
    return Number.isFinite(v) ? clampW(v) : SIDEBAR_W
  } catch {
    return SIDEBAR_W
  }
}

function writeWidthPref(w: number): void {
  try {
    localStorage.setItem(W_KEY, String(w))
  } catch {
    /* 忽略持久化失败 */
  }
}

export function createSidebar(opts: { onToggle?: (open: boolean) => void } = {}): Sidebar {
  const el = document.createElement('aside')
  el.className = 'sidebar'
  el.id = 'sidebar'
  el.setAttribute('aria-label', t('outlineTitle'))

  // 启动期压制网格过渡：body.app 的 grid-template-columns 带过渡，而停靠类与宽度
  // 变量都是本次初始化里首次应用——不压的话开窗会看到侧栏从 0 播一段变宽动画。
  // 首帧直接就位；双 rAF 后移除，之后的开合/拖拽照常过渡。
  const root = document.documentElement
  root.classList.add('sidebar-boot')

  // 初始形态：用户明确选过就听用户的；否则宽窗口默认展开（阅读器里目录默认可见更实用），
  // 窄窗口默认收起——窄窗口里正文与侧栏互相挤，不该自己弹出来抢宽度。
  // 宽度先于下边的把手初始化：把手一建出来就要把当前值写进 aria-valuenow。
  const pref = readPref()
  let width = readWidthPref()
  let open = pref ?? window.innerWidth >= dockMin()

  function applyWidth(w: number): void {
    width = clampW(w)
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
  }
  applyWidth(width)

  /**
   * 停靠所需的最小窗口宽度：侧栏 + 正文列 + 两侧留白。
   *
   * 必须按**当前**侧栏宽算，不能按默认 288 写死：用户把侧栏拖到 420 之后，
   * 900px 的窗口就真的放不下了（正文会被挤到 400px 出头），那时该退化成浮层。
   */
  function dockMin(): number {
    // 正文列宽从 CSS 变量读，而不是写死 640：用户可以把栏宽拖到 1600，
    // 那时「放得下吗」的答案完全变了，写死的阈值会让侧栏在放不下时还硬撑着停靠。
    const reading = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--reading-max-w'),
      10,
    )
    return width + (Number.isFinite(reading) && reading > 0 ? reading : 800) + 150
  }

  function mode(): SidebarMode {
    if (!open) return 'hidden'
    // 不再有「浮层」形态。
    //
    // 旧行为是窗口放不下就浮在正文上——但那会盖住正文，而阅读器里正文是主角：
    // 用户为了看一眼目录，代价是刚才读到的那段被挡住。
    // 现在放不下就一起挤：正文列本来就有 max-width，变窄仍然可读；
    // 真挤到不能看的时候，关掉侧栏或拖宽窗口都在用户手里（宽度也可调）。
    // 「初始要不要默认打开」仍按窗口够不够宽判断（见上面的 dockMin）。
    return 'docked'
  }

  // 不再挂「大纲」标题行。顶栏按钮已经点明这是目录，栏里又只有标题列表，
  // 再印一遍和当初那个「节数」一样，是常驻噪音。aside 的 aria-label 留给读屏。
  const body = document.createElement('div')
  body.className = 'sidebar-body'
  el.append(body)

  // ───────────── 宽度把手 ─────────────
  // 侧栏宽度是「这份文档要看多少目录」的偏好，一个固定值总有一半人嫌宽或嫌窄，
  // 所以做成可拖拽。范围 200–420：再窄标题读不全，再宽正文就被推出去了。
  // 双击复位、方向键微调（键盘可达），宽度存 localStorage。
  const grip = document.createElement('div')
  grip.className = 'sidebar-grip'
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-orientation', 'vertical')
  grip.setAttribute('aria-label', t('sidebarResizeTip'))
  grip.setAttribute('aria-valuemin', String(W_MIN))
  grip.setAttribute('aria-valuemax', String(W_MAX))
  grip.tabIndex = 0
  grip.dataset.tip = t('sidebarResizeTip')
  el.appendChild(grip)

  let dragStartX = 0
  let dragStartW = 0

  const onGripDown = (e: PointerEvent) => {
    dragStartX = e.clientX
    dragStartW = width
    grip.setPointerCapture(e.pointerId)
    document.documentElement.classList.add('sidebar-resizing')
    e.preventDefault()
  }
  const onGripMove = (e: PointerEvent) => {
    if (!grip.hasPointerCapture(e.pointerId)) return
    applyWidth(dragStartW + (e.clientX - dragStartX))
    // 宽度变了，类名与 aria 值跟着同步
    apply()
  }
  const onGripUp = (e: PointerEvent) => {
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId)
    document.documentElement.classList.remove('sidebar-resizing')
    writeWidthPref(width)
    apply()
  }
  const onGripKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0
    if (step === 0) return
    e.preventDefault()
    applyWidth(width + step)
    writeWidthPref(width)
    grip.setAttribute('aria-valuenow', String(width))
    apply()
  }
  const onGripReset = () => {
    applyWidth(SIDEBAR_W)
    writeWidthPref(width)
    grip.setAttribute('aria-valuenow', String(width))
    apply()
  }
  grip.addEventListener('pointerdown', onGripDown)
  grip.addEventListener('pointermove', onGripMove)
  grip.addEventListener('pointerup', onGripUp)
  grip.addEventListener('pointercancel', onGripUp)
  grip.addEventListener('keydown', onGripKey)
  grip.addEventListener('dblclick', onGripReset)
  grip.setAttribute('aria-valuenow', String(width))

  // 插在正文之前：骨架顺序 = 顶栏 / 侧栏 / 正文 / 状态行（见 index.html 注释）
  const content = document.getElementById('content')
  content?.parentElement?.insertBefore(el, content)

  // 初始形态见文件上方（width / open / dockMin 都在 el 建好之后紧跟着算）

  // 关闭时的延迟隐藏定时器：轨道过渡走完才真正 hidden（见 apply）
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  function apply(): void {
    const m = mode()
    const root = document.documentElement
    root.classList.toggle('sidebar-docked', m === 'docked')
    if (open) {
      // 开：立刻显示，内容由变宽的轨道逐步揭示（body 锁宽不重排，见 chrome.css）
      clearTimeout(hideTimer)
      el.removeAttribute('hidden')
      el.setAttribute('aria-hidden', 'false')
    } else {
      el.setAttribute('aria-hidden', 'true')
      // 关：不能立刻 hidden——内容会瞬间消失，只剩一条空轨道在收缩，看着像闪断。
      // 让轨道过渡先把侧栏收进去，走完再真正隐藏。
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (!open) el.setAttribute('hidden', '')
      }, 240)
    }
    grip.setAttribute('aria-valuenow', String(width))
  }

  function setOpen(next: boolean): void {
    if (open === next) return
    open = next
    writePref(open)
    apply()
    opts.onToggle?.(open)

  // 双 rAF：确保带 sidebar-boot 的首帧已经绘制完再恢复过渡。单 rAF 会在同一帧内
  // 加类又删类，过渡抑制可能不生效，动画又回来了。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove('sidebar-boot'))
  })
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
  }
}
