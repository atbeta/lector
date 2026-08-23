import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type EditorSettings,
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
