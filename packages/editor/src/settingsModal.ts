import { getSettings, resetSettings, setSettings } from './settings.ts'
import type { EditorSettings } from '@lector/core'
import { iconSvg } from './icons.ts'
import { Segmented, Slider, Switch } from './ui.ts'
import { t } from './i18n.ts'

let root: HTMLElement | null = null

function h(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

function section(label: string): HTMLElement {
  const wrap = h('section', 'settings-section')
  wrap.appendChild(h('h3')).textContent = label
  wrap.firstElementChild!.className = 'settings-row-label'
  return wrap
}

function row(label: string, control: HTMLElement): HTMLElement {
  const row = h('div', 'settings-row')
  row.appendChild(h('span')).textContent = label
  row.firstElementChild!.className = 'row-label'
  row.appendChild(control)
  return row
}

export function closeSettingsModal() {
  root?.remove()
  root = null
}

export function openSettingsModal(onClose?: () => void) {
  if (root) return
  let live: EditorSettings = getSettings()
  const apply = (fn: (s: EditorSettings) => EditorSettings) => {
    live = fn(live)
    setSettings(live)
  }

  const backdrop = h('div', 'modal-backdrop')
  const card = h('div', 'modal-card')

  // 头部
  const header = h('div', 'modal-header')
  const title = h('h2', 'modal-title')
  title.textContent = t('settingsTitle')
  const closeBtn = h('button', 'btn-icon')
  closeBtn.innerHTML = iconSvg('close')
  closeBtn.addEventListener('click', closeSettingsModal)
  header.append(title, closeBtn)
  card.appendChild(header)

  // 外观
  const appearance = section(t('appearance'))
  const theme = Segmented(live.theme,
    [{ v: 'system', label: t('themeSystem') }, { v: 'light', label: t('themeLight') }, { v: 'dark', label: t('themeDark') }],
    (v) => apply((s) => ({ ...s, theme: v })))
  appearance.appendChild(row(t('theme'), theme))

  const font = Segmented(live.fontFamily,
    [{ v: 'system', label: t('fontSystem') }, { v: 'serif', label: t('fontSerif') }],
    (v) => apply((s) => ({ ...s, fontFamily: v })))
  appearance.appendChild(row(t('readingFont'), font))

  const fontSlider = Slider(live.fontSize, 11, 32, 1, (v) => apply((s) => ({ ...s, fontSize: v })), (n) => `${n}px`)
  const fRow = h('div', 'settings-row cell')
  fRow.appendChild(h('span')).textContent = t('fontSize')
  fRow.firstElementChild!.className = 'row-label'
  fRow.append(fontSlider.root, fontSlider.readout)
  appearance.appendChild(fRow)

  const lhSlider = Slider(live.lineHeight, 1.2, 2.6, 0.05, (v) => apply((s) => ({ ...s, lineHeight: v })), (n) => n.toFixed(2))
  const lhRow = h('div', 'settings-row cell')
  lhRow.appendChild(h('span')).textContent = t('lineHeight')
  lhRow.firstElementChild!.className = 'row-label'
  lhRow.append(lhSlider.root, lhSlider.readout)
  appearance.appendChild(lhRow)

  const wSlider = Slider(live.readingWidth, 480, 1200, 16, (v) => apply((s) => ({ ...s, readingWidth: v })), (n) => `${n}px`)
  const wRow = h('div', 'settings-row cell')
  wRow.appendChild(h('span')).textContent = t('readingWidth')
  wRow.firstElementChild!.className = 'row-label'
  wRow.append(wSlider.root, wSlider.readout)
  appearance.appendChild(wRow)
  card.appendChild(appearance)

  // 编辑
  const editing = section(t('editing'))
  editing.appendChild(row(t('autoPairs'), Switch(live.autoCharacterPairs, (v) => apply((s) => ({ ...s, autoCharacterPairs: v })))))
  editing.appendChild(row(t('confirmClose'), Switch(live.closeAlwaysConfirmsChanges, (v) => apply((s) => ({ ...s, closeAlwaysConfirmsChanges: v })))))
  editing.appendChild(row(t('showWhitespace'), Switch(live.showWhitespace, (v) => apply((s) => ({ ...s, showWhitespace: v })))))
  card.appendChild(editing)

  // 底部
  const footer = h('div', 'modal-footer')
  const reset = h('button', 'btn')
  reset.textContent = t('resetDefaults')
  reset.addEventListener('click', () => {
    resetSettings()
    closeSettingsModal()
    openSettingsModal(onClose)
  })
  const done = h('button', 'btn btn-primary')
  done.textContent = t('done')
  done.addEventListener('click', () => {
    closeSettingsModal()
    onClose?.()
  })
  footer.append(reset, done)
  card.appendChild(footer)

  backdrop.appendChild(card)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSettingsModal()
  })
  document.addEventListener('keydown', onKey)
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      closeSettingsModal()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.body.appendChild(backdrop)
  root = backdrop
}
