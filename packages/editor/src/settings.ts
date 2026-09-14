import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  withReadingTheme,
  type EditorSettings,
  type ReadingThemeId,
  type ThemeMode,
} from '@lector/core'
import { loadSettings, saveSettings } from '@lector/shell-web'

let current: EditorSettings = DEFAULT_SETTINGS
const listeners = new Set<(s: EditorSettings) => void>()
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function applyTheme(theme: ThemeMode) {
  const resolved = theme === 'system' ? (mq?.matches ? 'dark' : 'light') : theme
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-theme-mode', theme)
}

/**
 * 自定义样式的容器：永远建在 <head> 末尾。
 *
 * 放末尾而不是中间，是为了让「用户想覆盖哪条规则都能覆盖」——同权重下后者胜出，
 * 就不用为了一行改色去写 !important 军备竞赛。Typora / Obsidian / VS Code
 * 开放自定义 CSS 也都是这个做法。
 */
let customStyleEl: HTMLStyleElement | null = null

function applyCustomCss(css: string): void {
  if (!customStyleEl) {
    customStyleEl = document.createElement('style')
    customStyleEl.id = 'lector-custom-css'
    document.head.appendChild(customStyleEl)
  }
  if (customStyleEl.textContent !== css) customStyleEl.textContent = css
}

function applyVars(s: EditorSettings) {
  const root = document.documentElement
  root.style.setProperty('--reading-font-size', `${s.fontSize}px`)
  root.style.setProperty('--reading-line-height', `${s.lineHeight}`)
  root.style.setProperty('--reading-max-w', `${s.readingWidth}px`)
  // 界面缩放：整页等比。
  // 用 CSS zoom 而不是 transform: scale —— zoom 参与布局，顶栏/状态行/浮层/命中区
  // 一起等比变化，不会出现「看得见但点不到」；transform 只做视觉缩放，命中区还在原位。
  // Chromium（WebView2）与 WebKit（WKWebView）都支持。
  root.style.setProperty('zoom', String(s.uiZoom / 100))
  root.classList.toggle('font-serif', s.fontFamily === 'serif')
  // 阅读主题：纸墨与排版性格全在 CSS 里按这个属性生效（reading-themes.css）。
  // data-theme 与它是正交的两轴——theme 管明暗，readingTheme 管「读起来像什么」。
  root.setAttribute('data-reading-theme', s.readingTheme)
  applyCustomCss(s.customCss ?? '')
}

export function notify(handler: (s: EditorSettings) => void): () => void {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

export function getSettings(): EditorSettings {
  return { ...current }
}

export function setSettings(next: EditorSettings, persist = true) {
  current = normalizeSettings(next)
  applyTheme(current.theme)
  applyVars(current)
  listeners.forEach((fn) => fn(current))
  if (persist) {
    void saveSettings(current)
  }
}

export function resetSettings() {
  setSettings(DEFAULT_SETTINGS, true)
}

/**
 * 选一款阅读主题：套用它的标定排版 + 切纸墨。
 *
 * 用户之后动字号/行距/栏宽仍然有效——那些改动只改设置值，不动 readingTheme，
 * 所以画廊里那张卡依然亮着（设置面板会给它标一句「已微调」）。
 */
export function setReadingTheme(id: ReadingThemeId) {
  setSettings(withReadingTheme(current, id))
}

/** 在当前明暗下切换明暗（顶栏浮层与菜单共用）。 */
export function setThemeMode(mode: ThemeMode) {
  setSettings({ ...current, theme: mode })
}

/**
 * 字号步进：菜单里的「增大/减小字号」。
 * 复用设置里的 fontSize（clamp 11–32 已在 core 里做），不另开一套缩放比例——
 * 两套缩放会互相打架，用户也会分不清哪个在生效。
 */
export function stepFontSize(delta: number) {
  setSettings({ ...current, fontSize: current.fontSize + delta })
}

export function resetFontSize() {
  setSettings({ ...current, fontSize: DEFAULT_SETTINGS.fontSize })
}

/** 界面缩放的档位：演示时常用 125/150，两个端点之间不留太多空档 */
const UI_ZOOM_STEPS = [70, 80, 90, 100, 110, 125, 150]

/** 步进一档界面缩放（方向键/快捷键用）。 */
export function stepUiZoom(delta: number) {
  const cur = getSettings().uiZoom
  const i = UI_ZOOM_STEPS.findIndex((v) => v >= cur)
  const at = i < 0 ? UI_ZOOM_STEPS.length - 1 : i
  const next = UI_ZOOM_STEPS[Math.min(UI_ZOOM_STEPS.length - 1, Math.max(0, at + delta))]!
  setSettings({ ...getSettings(), uiZoom: next })
}

/** 界面缩放回到 100%。 */
export function resetUiZoom() {
  setSettings({ ...getSettings(), uiZoom: 100 })
}

export function toggleTheme() {
  const resolved = current.theme === 'system' ? (mq?.matches ? 'dark' : 'light') : current.theme
  setSettings({ ...current, theme: resolved === 'dark' ? 'light' : 'dark' })
}

export async function initSettings() {
  const raw = await loadSettings().catch(() => null)
  current = normalizeSettings(raw)
  applyTheme(current.theme)
  applyVars(current)
  mq?.addEventListener('change', () => {
    if (current.theme === 'system') {
      applyTheme('system')
    }
  })
  listeners.forEach((fn) => fn(current))
  return current
}
