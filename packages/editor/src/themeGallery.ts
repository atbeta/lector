// 阅读主题画廊：6 张预览卡 + 明暗分段，顶栏浮层与设置面板共用同一份 DOM 构建。
//
// 设计要点（也是它和「一列下拉框」的区别）：
//   1. 预览卡自己带 data-reading-theme —— 卡片上的纸墨、字体、排版性格都来自
//      reading-themes.css 里那条主题规则，不是另画一张示意图。卡上是什么样，
//      选中后正文就是什么样，两者不可能对不上。
//   2. 卡片显示「规格行」（字号/行距/栏宽的数字），因为阅读排版这件事，
//      用户能感知的就是这几个数字在变。
//   3. 选中且被逐项微调过时打「已微调」标记：不偷偷把用户改过的数值说成主题值。

import {
  READING_THEMES,
  matchesReadingThemePreset,
  type EditorSettings,
  type ReadingThemeId,
  type ThemeMode,
} from '@lector/core'
import { getLocale, t } from './i18n.ts'
import { Segmented } from './ui.ts'

/** 主题卡上的样例行：一张卡要能同时看出标题、正文、链接、行内码、等宽。 */
interface SampleLine {
  head: string
  body: string
  link: string
  code: string
}
const SAMPLE: { zh: SampleLine; en: SampleLine } = {
  zh: { head: '标题', body: '正文 Aa', link: '链接', code: 'code' },
  en: { head: 'Title', body: 'Body Aa', link: 'link', code: 'code' },
}

function pick<T>(v: { zh: T; en: T }): T {
  return getLocale() === 'en' ? v.en : v.zh
}

/**
 * 一张主题卡。导出的原因是设置面板与浮层都要用它，
 * 且 ui-verify 会按 .theme-preview 断言卡片数量与选中态。
 */
export function themeCard(
  id: ReadingThemeId,
  settings: EditorSettings,
  onPick: (id: ReadingThemeId) => void,
): HTMLButtonElement {
  const theme = READING_THEMES.find((x) => x.id === id)!
  const active = settings.readingTheme === id
  const tweaked = active && !matchesReadingThemePreset(settings)

  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'theme-preview'
  card.dataset.readingTheme = id
  card.setAttribute('aria-pressed', String(active))
  // 预览卡的字体跟着主题走。字体的真身在设置里（--reading-font 由 JS 覆写），
  // 所以这里不能读 CSS 变量，只能按主题标定的 fontFamily 直接指定。
  const serif = theme.preset.fontFamily === 'serif'
  card.style.fontFamily = serif ? 'var(--font-serif)' : 'var(--font-sans)'
  card.title = `${pick(theme.name)} — ${pick(theme.tagline)}`

  const sample = document.createElement('span')
  sample.className = 'theme-preview-sample'
  const s = pick(SAMPLE)
  const head = document.createElement('b')
  head.textContent = s.head
  const body = document.createElement('span')
  body.textContent = s.body
  const link = document.createElement('i')
  link.textContent = s.link
  const code = document.createElement('code')
  code.textContent = s.code
  sample.append(head, body, link, code)

  const nameRow = document.createElement('span')
  nameRow.className = 'theme-preview-name'
  const name = document.createElement('b')
  name.textContent = pick(theme.name)
  const en = document.createElement('span')
  en.className = 'theme-preview-en'
  en.textContent = theme.id === 'default' ? '' : theme.name.en
  const tagline = document.createElement('span')
  tagline.className = 'theme-preview-tagline'
  tagline.textContent = pick(theme.tagline)
  nameRow.append(name, en, tagline)
  if (tweaked) {
    const badge = document.createElement('span')
    badge.className = 'theme-preview-badge'
    badge.textContent = t('themeTweaked')
    badge.dataset.tip = t('themeTweakedTip')
    nameRow.appendChild(badge)
  }

  const spec = document.createElement('span')
  spec.className = 'theme-preview-spec'
  spec.textContent = pick(theme.spec)

  card.append(sample, nameRow, spec)
  card.addEventListener('click', () => onPick(id))
  return card
}

/**
 * 明暗 + 阅读主题。两轴分开呈现，因为它们是正交的：
 * theme 决定「白天还是晚上」，readingTheme 决定「读起来像什么」。
 * 混成一个列表（「米黄夜间」这类组合项）会立刻变成排列组合地狱。
 */
export function appearanceControls(opts: {
  settings: () => EditorSettings
  onThemeMode: (m: ThemeMode) => void
  onReadingTheme: (id: ReadingThemeId) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'appearance'

  const modeRow = document.createElement('div')
  modeRow.className = 'appearance-row'
  const modeLabel = document.createElement('span')
  modeLabel.className = 'appearance-label'
  modeLabel.textContent = t('theme')
  const seg = Segmented(
    opts.settings().theme,
    [
      { v: 'system', label: t('themeSystem') },
      { v: 'light', label: t('themeLight') },
      { v: 'dark', label: t('themeDark') },
    ],
    opts.onThemeMode,
  )
  modeRow.append(modeLabel, seg.root)
  wrap.appendChild(modeRow)

  const themeLabel = document.createElement('div')
  themeLabel.className = 'appearance-group-label'
  themeLabel.textContent = t('readingTheme')
  wrap.appendChild(themeLabel)

  const grid = document.createElement('div')
  grid.className = 'theme-grid'
  for (const th of READING_THEMES) {
    grid.appendChild(themeCard(th.id, opts.settings(), opts.onReadingTheme))
  }
  wrap.appendChild(grid)

  const hint = document.createElement('p')
  hint.className = 'appearance-hint'
  hint.textContent = t('readingThemeHint')
  wrap.appendChild(hint)

  return wrap
}

/**
 * 重建画廊（换主题后要重画选中态与「已微调」标记）。
 *
 * 两种调用方式都支持：
 *   - 直接调用 render()：只在「与画廊有关的东西」真的变了时才重建
 *     （主题 id / 字体 / 字号 / 行距 / 栏宽），拖动滑块时不会每像素重建一次 DOM；
 *   - render(true)：强制重建（首次渲染用）。
 * 返回值就是 render 本身，方便调用方挂在设置变更通知上。
 */
export function mountAppearance(
  host: HTMLElement,
  opts: {
    settings: () => EditorSettings
    onThemeMode: (m: ThemeMode) => void
    onReadingTheme: (id: ReadingThemeId) => void
  },
): (force?: boolean) => void {
  let sig = ''
  const render = (force = false) => {
    const s = opts.settings()
    const next = [s.readingTheme, s.fontFamily, s.fontSize, s.lineHeight, s.readingWidth].join('|')
    if (!force && next === sig) return
    sig = next
    host.replaceChildren(appearanceControls(opts))
  }
  render(true)
  return render
}
