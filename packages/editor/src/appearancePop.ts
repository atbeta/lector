// 「外观」浮层：明暗 + 阅读主题 + 两个排版旋钮，点顶栏的 Aa 按钮弹出。
//
// 为什么是一个浮层而不是「点一下换一个主题」的循环按钮：
//   - 循环按钮只能换「下一个」，想跳到某一款得点很多次，还会经过不想看的主题；
//   - 明暗与阅读主题是正交的两轴，各给一排控件比藏在一个按钮里清楚得多。
//
// 为什么不用设置弹窗：换主题是「读着读着顺手换一下」的动作，不该打断阅读
// （弹窗会把正文全遮住），所以要能一边看着正文一边换。
// 栏宽与界面缩放是同一类动作——也要能看着正文调——所以一并放在这里。

import { DEFAULT_SETTINGS, typographyHome } from '@lector/core'
import { getSettings, notify, setReadingTheme, setSettings, setThemeMode } from './settings.ts'
import { appearanceControls } from './themeGallery.ts'
import { Slider } from './ui.ts'
import { t } from './i18n.ts'

let root: HTMLElement | null = null
let dispose: (() => void) | null = null

/** 排版行左侧的标签格（与滑块的三个格子同处一个网格，见 .appearance-quick）。 */
function labelCell(text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'appearance-label'
  el.textContent = text
  return el
}

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

  // 主题那半块随设置重画；排版两个旋钮是常驻 DOM——拖动中途重建元素会直接掐断
  // 这次拖动（指针捕获跑在已被删除的节点上）。
  const themeHost = document.createElement('div')

  const width = Slider(
    getSettings().readingWidth,
    480,
    1600,
    16,
    (v) => setSettings({ ...getSettings(), readingWidth: v }),
    (n) => `${n}px`,
    { home: typographyHome(getSettings()).readingWidth, resetTip: t('sliderResetTip') },
  )
  const zoom = Slider(
    getSettings().uiZoom,
    70,
    160,
    10,
    (v) => setSettings({ ...getSettings(), uiZoom: v }),
    (n) => `${n}%`,
    { home: DEFAULT_SETTINGS.uiZoom, resetTip: t('sliderResetTip') },
  )
  // 三列网格而不是「每行一个 flex」：两行的标签宽度不同，各自 flex 会让两个
  // 滑块的起点错开；同一个网格里列宽才是共享的，也就不会写死 em 去赌文案长度。
  const quick = document.createElement('div')
  quick.className = 'appearance-quick'
  quick.append(labelCell(t('readingWidth')), width.root, width.readout)
  quick.append(labelCell(t('uiZoom')), zoom.root, zoom.readout)

  pop.append(themeHost, quick)

  // 只在「与画廊有关」的字段变化时重建主题块。栏宽也在签名里（换主题会套用它
  // 的标定栏宽，卡片上的「已微调」标记也看它），但拖动滑块只重建主题块，
  // 旋钮本身原地不动。
  let themeSig = ''
  const render = () => {
    const s = getSettings()
    const sig = [s.theme, s.readingTheme, s.fontFamily, s.fontSize, s.lineHeight, s.readingWidth].join('|')
    if (sig === themeSig) {
      place(pop, anchor)
      return
    }
    themeSig = sig
    themeHost.replaceChildren(
      appearanceControls({
        settings: getSettings,
        onThemeMode: setThemeMode,
        onReadingTheme: setReadingTheme,
      }),
    )
    place(pop, anchor)
  }
  render()
  const off = notify((s) => {
    // 换主题会连带改这套排版的字号/行距/栏宽，滑块必须跟着走，否则读数就是说谎
    width.set(s.readingWidth)
    zoom.set(s.uiZoom)
    width.setHome(typographyHome(s).readingWidth)
    zoom.setHome(DEFAULT_SETTINGS.uiZoom)
    render()
  })

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
  // 视口变化时**重新贴回按钮**，而不是关闭：界面缩放走壳的原生 zoom，改缩放会触发
  // resize——若在这里关面板，「调界面缩放」刚一拖面板就没了。窗口真被 resize 时
  // 跟着按钮走也比关掉更合理。
  const onViewport = () => place(pop, anchor)

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
