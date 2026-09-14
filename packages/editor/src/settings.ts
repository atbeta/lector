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

function applyVars(s: EditorSettings) {
  const root = document.documentElement
  root.style.setProperty('--reading-font-size', `${s.fontSize}px`)
  root.style.setProperty('--reading-line-height', `${s.lineHeight}`)
  root.style.setProperty('--reading-max-w', `${s.readingWidth}px`)
  root.classList.toggle('font-serif', s.fontFamily === 'serif')
  // 阅读主题：纸墨与排版性格全在 CSS 里按这个属性生效（reading-themes.css）。
  // data-theme 与它是正交的两轴——theme 管明暗，readingTheme 管「读起来像什么」。
  root.setAttribute('data-reading-theme', s.readingTheme)
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
