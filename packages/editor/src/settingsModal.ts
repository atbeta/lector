// 设置弹层。
//
// 结构上分两块，职责不同：
//   - 「阅读主题」画廊：一次点选 = 套用一整套标定排版（字号/行距/栏宽/字体）。
//     画廊自己会重建选中态，见 themeGallery.ts。
//   - 「微调」行：在选定主题的基础上逐个改。改过的值不会再被主题覆盖，
//     只会在卡片上多一个「已微调」标记——用户的调整永远是他自己的。

import { getSettings, resetSettings, setSettings, setReadingTheme, setThemeMode, notify } from './settings.ts'
import type { EditorSettings } from '@lector/core'
import { iconSvg } from './icons.ts'
import { Segmented, Slider, Switch } from './ui.ts'
import { mountAppearance } from './themeGallery.ts'
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

/** 带数值读数的一行（滑块 + 右侧数字）。 */
function cellRow(label: string, slider: { root: HTMLElement; readout: HTMLElement }): HTMLElement {
  const r = h('div', 'settings-row cell')
  r.appendChild(h('span')).textContent = label
  r.firstElementChild!.className = 'row-label'
  r.append(slider.root, slider.readout)
  return r
}

export function closeSettingsModal() {
  root?.remove()
  root = null
}

export function openSettingsModal(onClose?: () => void) {
  if (root) return
  const apply = (fn: (s: EditorSettings) => EditorSettings) => setSettings(fn(getSettings()))

  const backdrop = h('div', 'modal-backdrop')
  const card = h('div', 'modal-card settings-card')

  // 头部
  const header = h('div', 'modal-header')
  const title = h('h2', 'modal-title')
  title.textContent = t('settingsTitle')
  const closeBtn = h('button', 'btn-icon')
  closeBtn.innerHTML = iconSvg('close')
  closeBtn.setAttribute('aria-label', t('close'))
  closeBtn.addEventListener('click', closeSettingsModal)
  header.append(title, closeBtn)
  card.appendChild(header)

  const body = h('div', 'modal-body')
  card.appendChild(body)

  // ── 外观 ──
  const appearance = section(t('appearance'))
  const galleryHost = h('div', 'settings-gallery')
  // 画廊自带明暗分段 + 六张主题卡。设置一变就重画「选中态 / 已微调标记」——
  // 不订阅的话，用户在弹窗里换主题，卡片上的高亮还停在旧的那张。
  const renderGallery = mountAppearance(galleryHost, {
    settings: getSettings,
    onThemeMode: setThemeMode,
    onReadingTheme: setReadingTheme,
  })
  appearance.appendChild(galleryHost)

  // ── 微调：主题给的是标定值，用户想动就动 ──
  const font = Segmented(
    getSettings().fontFamily,
    [
      { v: 'system', label: t('fontSystem') },
      { v: 'serif', label: t('fontSerif') },
    ],
    (v) => apply((s) => ({ ...s, fontFamily: v })),
  )
  appearance.appendChild(row(t('readingFont'), font.root))

  const fontSlider = Slider(
    getSettings().fontSize,
    11,
    32,
    1,
    (v) => apply((s) => ({ ...s, fontSize: v })),
    (n) => `${n}px`,
  )
  appearance.appendChild(cellRow(t('fontSize'), fontSlider))

  const lhSlider = Slider(
    getSettings().lineHeight,
    1.2,
    2.6,
    0.05,
    (v) => apply((s) => ({ ...s, lineHeight: v })),
    (n) => n.toFixed(2),
  )
  appearance.appendChild(cellRow(t('lineHeight'), lhSlider))

  const wSlider = Slider(
    getSettings().readingWidth,
    480,
    1200,
    16,
    (v) => apply((s) => ({ ...s, readingWidth: v })),
    (n) => `${n}px`,
  )
  appearance.appendChild(cellRow(t('readingWidth'), wSlider))
  body.appendChild(appearance)

  // ── 编辑 ──
  const editing = section(t('editing'))
  editing.appendChild(
    row(t('autoPairs'), Switch(getSettings().autoCharacterPairs, (v) => apply((s) => ({ ...s, autoCharacterPairs: v })))),
  )
  editing.appendChild(
    row(
      t('confirmClose'),
      Switch(getSettings().closeAlwaysConfirmsChanges, (v) => apply((s) => ({ ...s, closeAlwaysConfirmsChanges: v }))),
    ),
  )
  editing.appendChild(
    row(t('showWhitespace'), Switch(getSettings().showWhitespace, (v) => apply((s) => ({ ...s, showWhitespace: v })))),
  )
  body.appendChild(editing)

  // 底栏
  const footer = h('div', 'modal-footer')
  const reset = h('button', 'btn')
  reset.textContent = t('resetDefaults')
  reset.addEventListener('click', () => resetSettings())
  const done = h('button', 'btn btn-primary')
  done.textContent = t('done')
  done.addEventListener('click', () => {
    closeSettingsModal()
    onClose?.()
  })
  footer.append(reset, done)
  card.appendChild(footer)

  /**
   * 设置一变就同步「微调」控件的位置。
   *
   * 必须同步而不是整块重建：滑块拖到一半被重建，拖拽就断了（指针捕获跑在
   * 被删掉的 DOM 上）。所以这里只 set()，只动值不动结构。
   */
  // 画廊重建的合并开关（定义在 notify 之前：回调里就用到它）
  let galleryTick = false
  const off = notify((s) => {
    font.set(s.fontFamily)
    fontSlider.set(s.fontSize)
    lhSlider.set(s.lineHeight)
    wSlider.set(s.readingWidth)
    // 用 rAF 合并：拖滑块时 notify 每像素都响，画廊只需要每帧对齐一次
    if (!galleryTick) {
      galleryTick = true
      requestAnimationFrame(() => {
        galleryTick = false
        renderGallery()
      })
    }
  })

  const close = () => {
    off()
    closeSettingsModal()
    document.removeEventListener('keydown', onKey)
  }

  backdrop.appendChild(card)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  document.addEventListener('keydown', onKey)
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }
  document.body.appendChild(backdrop)
  root = backdrop
}
