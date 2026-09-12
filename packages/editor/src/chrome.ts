// 窗口外框：平台判定 + Windows 自绘窗口控件。
//
// 现代无标题栏：正文从第一行就是内容，没有原生标题栏那条灰带。
//
//  - Windows / Linux：tauri.conf.json 里 decorations:false，整条顶栏可拖拽，
//    右侧三个自绘按钮（最小化 / 最大化还原 / 关闭）。这三个是系统级动作，
//    经 @lector/shell-web 的 bindWindowControls 走壳的真实窗口命令。
//  - macOS：titleBarStyle: Overlay，原生红绿灯浮在内容上，只让位不自绘。
//    红绿灯是 mac 用户的肌肉记忆，自绘会立刻显得「不是 mac 应用」。
//  - 浏览器预览：按 UA 预演对应平台版式（按钮在位但 disabled），
//    方便在没有壳的环境里调样式。

import { bindWindowControls, detectEnv } from '@lector/shell-web'
import { windowGlyph } from './icons.ts'

export type ShellPlatform = 'macos' | 'windows' | 'web'

/** 判定平台：壳里同样用 UA，红绿灯只有 mac 有，其余按 Windows 版式处理。 */
export function detectShellPlatform(): ShellPlatform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  // 顺序要紧：Windows 的 UA 里带着「Windows NT」但没有 Mac；
  // 反过来 Chrome 在 mac 上跑 Windows 版式预览时，若先判 Mac 就会永远走不到 Windows。
  if (/Windows|Win32|Win64/i.test(ua)) return 'windows'
  if (/Mac|iPhone|iPad/i.test(ua)) return 'macos'
  return detectEnv() === 'shell' ? 'windows' : 'web'
}

interface WinButton {
  el: HTMLButtonElement
  setGlyph: (name: string, label: string) => void
}

function makeWinButton(label: string, glyph: string, onClick: () => void): WinButton {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'win-btn'
  const setGlyph = (name: string, text: string) => {
    el.innerHTML = windowGlyph(name)
    el.title = text
    el.setAttribute('aria-label', text)
  }
  setGlyph(glyph, label)
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return { el, setGlyph }
}

/**
 * 挂载窗口外框：设 html[data-shell]，Windows 下画出三个窗口控件。
 * 浏览器预览时按 UA 决定版式，所以「Windows 长什么样」在没有壳的机器上也能看。
 */
export function mountWindowControls(): () => void {
  const platform = detectShellPlatform()
  document.documentElement.setAttribute('data-shell', platform)
  if (platform !== 'windows' && platform !== 'web') return () => {}

  const host = document.querySelector<HTMLElement>('.window-controls')
  if (!host) return () => {}

  // 这些字段会被 bindWindowControls 就地替换成真实的壳调用，
  // 所以按钮必须读同一个对象（不能把 actions 拷一份出去）。
  const handlers = {
    onMinimize: () => {},
    onToggleMaximize: () => {},
    onClose: () => {},
    onMaximizedChange: (maximized: boolean) =>
      maxBtn.setGlyph(maximized ? 'restore' : 'maximize', maximized ? '向下还原' : '最大化'),
  }

  const minBtn = makeWinButton('最小化', 'minimize', () => handlers.onMinimize())
  const maxBtn = makeWinButton('最大化', 'maximize', () => handlers.onToggleMaximize())
  const closeBtn = makeWinButton('关闭', 'close', () => handlers.onClose())
  host.replaceChildren(minBtn.el, maxBtn.el, closeBtn.el)

  // 浏览器预览：按钮在位但不可用，只用于看版式
  if (detectEnv() !== 'shell') {
    for (const b of [minBtn.el, maxBtn.el, closeBtn.el]) {
      b.disabled = true
      b.tabIndex = -1
      b.title = `${b.title}（浏览器预览不可用）`
    }
    return () => host.replaceChildren()
  }

  const dispose = bindWindowControls(handlers)

  // 双击顶栏切换最大化：Windows 肌肉记忆，无边框窗口必须自己补。
  // 顶栏自身已是拖拽区（-webkit-app-region / data-tauri-drag-region），
  // 这里只补双击语义。
  const bar = document.getElementById('titlebar')
  const onDblClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement | null)?.closest('button, input, a')) return
    handlers.onToggleMaximize()
  }
  bar?.addEventListener('dblclick', onDblClick)

  return () => {
    dispose()
    bar?.removeEventListener('dblclick', onDblClick)
    host.replaceChildren()
  }
}

/**
 * 顶栏的两处几何，统一在这里量，写进 CSS 变量。
 *
 * 1. 标题夹取区间的左端 = 正文列的左沿 + 导航区宽。
 *    标题必须在**正文列**上居中，不是在整个窗口上居中——有侧栏时两者差侧栏宽的
 *    一半（实测偏 120px）。夹取区间要和正文列完全重合，才能做到真正对齐。
 *
 * 2. 顶栏左内边距（导航的位置）**故意不等于**正文列左沿。
 *    试过让它对齐正文列：窗口宽到一定程度正文列会在 560px 开外，两个图标跟着
 *    推进去就孤零零悬在顶栏中段，比「左边留白大」更难看。
 *    所以导航回到窗口左边缘的克制留白（mac 上红绿灯之后），
 *    靠一条发丝分区线说明「这里是壳、右边是内容」。
 */
export function syncTitlebarInset(): void {
  const bar = document.getElementById('titlebar')
  const content = document.getElementById('content')
  if (!bar || !content) return

  const cs = getComputedStyle(content)
  const cb = content.getBoundingClientRect()
  const padL = Number.parseFloat(cs.paddingLeft) || 0
  const padR = Number.parseFloat(cs.paddingRight) || 0
  const textLeft = Math.round(cb.x + padL)
  const textRight = Math.round(cb.right - padR)
  const barRight = Math.round(bar.getBoundingClientRect().right)

  // 标题夹取区间 = 正文文字的左右沿，标题因此精确居中于正文列。
  bar.style.setProperty('--titlebar-clamp-left', `${textLeft}px`)
  bar.style.setProperty('--titlebar-clamp-right', `${barRight - textRight}px`)

  // 壳两侧（顶栏导航、状态行文字）与正文共用一个左边缘。
  //
  // 之前是三套：状态行贴窗口边（14px）、导航固定 80px、正文随窗口居中（130→600px）。
  // 同一屏里三条竖线，眼睛立刻觉得「没对齐」。
  //
  // 一条规则贯彻到底：壳的左右边缘 = 正文文字的左右沿。
  // 试过封顶在侧栏宽度（那样宽窗口下导航落在内容区轨道左沿），但正文在轨道内居中，
  // 两者会错开 160px——用户看到的就是「没对齐」。macOS 的红绿灯避让由 CSS 的
  // max(80px, …) 负责，不在这里掺进来。
  document.documentElement.style.setProperty('--band-inset', `${Math.max(14, textLeft)}px`)

  // 状态行右端与正文列右沿对齐，让状态行和正文列完全重合（左统计、右状态）。
  const status = document.getElementById('statusbar')
  if (status) {
    status.style.setProperty('--band-inset-right', `${barRight - textRight}px`)
  }

  // 右侧操作区宽（含呼吸），供标题夹取区间右端使用；顶栏右端的按钮贴窗口边
  const actions = bar.querySelector<HTMLElement>('.titlebar-actions')
  if (actions) {
    bar.style.setProperty(
      '--titlebar-actions-w',
      `${Math.round(actions.getBoundingClientRect().width) + 22}px`,
    )
  }
}

export function mountTitlebarInset(): () => void {
  const bar = document.getElementById('titlebar')
  const content = document.getElementById('content')
  if (!bar || !content) return () => {}
  const sync = syncTitlebarInset
  const schedule = () => requestAnimationFrame(sync)

  // 自己校正，而不是在每个可能改变布局的地方补一次调用。
  //
  // 两个观察点，缺一不可：
  //  - 窗口缩放：ResizeObserver 盯正文容器（宽度会变）
  //  - 侧栏开合：**容器尺寸不变**（变的是网格轨道，正文本就固定 640px 宽），
  //    所以 ResizeObserver 收不到。这时只有 class 会变，用 MutationObserver 盯它。
  //    早期版本只盯容器，结果侧栏一开一合，标题夹取区间还是旧值（实测偏 131px）。
  const ro = new ResizeObserver(schedule)
  ro.observe(content)
  const mo = new MutationObserver(schedule)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('lector:doc-changed', schedule as EventListener)
  // grid 轨道有过渡：动画结束后再校一次，拿到的是终值而不是中间值
  const settle = window.setTimeout(schedule, 360)
  sync()
  return () => {
    ro.disconnect()
    mo.disconnect()
    window.clearTimeout(settle)
    window.removeEventListener('lector:doc-changed', schedule as EventListener)
  }
}

/**
 * 顶栏分隔只在滚动后出现：静止时留白更干净，滚动时才需要告诉用户
 * 「内容正从下面穿过」。
 *
 * 监听的是 #content 而不是 window：骨架改成「滚动发生在正文里、顶栏与状态行常驻」
 * 之后，window 永远不滚（domScrolls=false），挂在 window 上等于失效。
 */
export function mountHeaderScrollState(): () => void {
  const bar = document.getElementById('titlebar')
  if (!bar) return () => {}
  const scroller = document.getElementById('content')
  if (!scroller) return () => {}
  let ticking = false
  const update = () => {
    ticking = false
    bar.classList.toggle('scrolled', scroller.scrollTop > 4)
  }
  const onScroll = () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(update)
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  // 换文档后滚动位置归零，状态要跟着复位
  window.addEventListener('lector:doc-changed', update as EventListener)
  update()
  return () => {
    scroller.removeEventListener('scroll', onScroll)
    window.removeEventListener('lector:doc-changed', update as EventListener)
  }
}
