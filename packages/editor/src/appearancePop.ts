// 「外观」浮层：明暗 + 阅读主题，点顶栏的 Aa 按钮弹出。
//
// 为什么是一个浮层而不是「点一下换一个主题」的循环按钮：
//   - 循环按钮只能换「下一个」，想跳到某一款得点很多次，还会经过不想看的主题；
//   - 明暗与阅读主题是正交的两轴，各给一排控件比藏在一个按钮里清楚得多。
//
// 为什么不用设置弹窗：换主题是「读着读着顺手换一下」的动作，不该打断阅读
// （弹窗会把正文全遮住），所以要能一边看着正文一边换。

import { getSettings, notify, setReadingTheme, setThemeMode } from './settings.ts'
import { appearanceControls } from './themeGallery.ts'

let root: HTMLElement | null = null
let dispose: (() => void) | null = null

export function closeAppearancePop(): void {
  dispose?.()
  dispose = null
  root?.remove()
  root = null
}

/** 打开（已开则关闭，即按钮上的 toggle 语义）。 */
export function openAppearancePop(anchor: HTMLElement): void {
  if (root) {
    closeAppearancePop()
    return
  }

  const pop = document.createElement('div')
  pop.className = 'appearance-pop'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-modal', 'false')

  // 每次设置变化都重画：选中态、「已微调」标记、明暗分段的指示器都要跟着走。
  // 重画整块而不是局部打补丁——这块面板很小，重画比维护增量更新便宜。
  const render = () => {
    pop.replaceChildren(
      appearanceControls({
        settings: getSettings,
        onThemeMode: setThemeMode,
        onReadingTheme: setReadingTheme,
      }),
    )
    place(pop, anchor)
  }
  render()
  const off = notify(render)

  // 定位：贴着按钮的下沿，右对齐——顶栏按钮在右边，面板往左展开才不会出屏。
  function place(el: HTMLElement, at: HTMLElement): void {
    const r = at.getBoundingClientRect()
    el.style.top = `${Math.round(r.bottom + 8)}px`
    el.style.right = `${Math.round(Math.max(12, window.innerWidth - r.right))}px`
  }

  const onDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('.appearance-pop, #appearance-btn')) return
    closeAppearancePop()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeAppearancePop()
  }
  const onViewport = () => closeAppearancePop()

  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onViewport)
  // 正文滚动时不关：面板是浮在正文之上的，滚动是读者的动作，不该惩罚他
  anchor.setAttribute('aria-expanded', 'true')

  document.body.appendChild(pop)
  root = pop
  dispose = () => {
    off()
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onViewport)
    anchor.setAttribute('aria-expanded', 'false')
  }

  // 打开时聚焦当前主题卡：键盘用户 Tab 进来就在正确的位置上
  pop.querySelector<HTMLElement>('.theme-preview[aria-pressed="true"]')?.focus()
}
