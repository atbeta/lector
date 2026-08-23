import { getSettings, resetSettings, setSettings } from './settings.ts'
import type { EditorSettings } from '@lector/core'

let root: HTMLElement | null = null

function h(tag: string, cls = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

function section(label: string): HTMLElement {
  const wrap = h('section', 'settings-section')
  wrap.appendChild(h('h3', 'settings-row-label', label))
  return wrap
}

function row(label: string, control: HTMLElement): HTMLElement {
  const row = h('div', 'settings-row')
  row.append(h('span', 'row-label', label), control)
  return row
}

function segmented<T extends string>(
  value: T,
  options: Array<{ v: T; label: string }>,
  onChange: (v: T) => void,
): HTMLElement {
  const box = h('div', 'segmented')
  for (const opt of options) {
    const btn = h('button', 'seg-item' + (opt.v === value ? ' active' : ''), opt.label)
    btn.dataset.v = opt.v
    btn.addEventListener('click', () => {
      box.querySelectorAll('.seg-item').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      onChange(opt.v)
    })
    box.appendChild(btn)
  }
  return box
}

function range(
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  fmt: (n: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = h('div', 'range-row')
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  const out = h('span', 'range-value', `${fmt(value)}${unit}`)
  input.addEventListener('input', () => {
    const v = Number(input.value)
    out.textContent = `${fmt(v)}${unit}`
    onChange(v)
  })
  wrap.append(input, out)
  return wrap
}

function toggle(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const box = h('label', 'toggle')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  const track = h('span', 'toggle-track')
  box.append(input, track)
  input.addEventListener('change', () => onChange(input.checked))
  return box
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

  const header = h('div', 'modal-header')
  header.append(h('h2', 'modal-title', '设置'))
  const closeBtn = h('button', 'btn-icon', '✕')
  closeBtn.addEventListener('click', closeSettingsModal)
  header.appendChild(closeBtn)
  card.appendChild(header)

  const appearance = section('外观')
  appearance.appendChild(
    row('主题', segmented(live.theme,
      [{ v: 'system', label: '跟随系统' }, { v: 'light', label: '浅色' }, { v: 'dark', label: '深色' }],
      (v) => apply((s) => ({ ...s, theme: v })))),
  )
  appearance.appendChild(
    row('阅读字体', segmented(live.fontFamily,
      [{ v: 'system', label: '系统' }, { v: 'serif', label: '衬线' }],
      (v) => apply((s) => ({ ...s, fontFamily: v })))),
  )
  appearance.appendChild(
    row('正文字号', range(live.fontSize, 11, 32, 1, 'px', (n) => String(n), (v) => apply((s) => ({ ...s, fontSize: v })))),
  )
  appearance.appendChild(
    row('行高', range(live.lineHeight, 1.2, 2.6, 0.05, '', (n) => n.toFixed(2), (v) => apply((s) => ({ ...s, lineHeight: v })))),
  )
  appearance.appendChild(
    row('阅读列宽', range(live.readingWidth, 480, 1200, 16, 'px', (n) => String(n), (v) => apply((s) => ({ ...s, readingWidth: v })))),
  )
  card.appendChild(appearance)

  const editing = section('编辑')
  editing.appendChild(row('自生成对符号', toggle(live.autoCharacterPairs, (v) => apply((s) => ({ ...s, autoCharacterPairs: v })))))
  editing.appendChild(row('关闭脏文档前确认', toggle(live.closeAlwaysConfirmsChanges, (v) => apply((s) => ({ ...s, closeAlwaysConfirmsChanges: v })))))
  editing.appendChild(row('显示空白字符', toggle(live.showWhitespace, (v) => apply((s) => ({ ...s, showWhitespace: v })))))
  card.appendChild(editing)

  const footer = h('div', 'modal-footer')
  const reset = h('button', 'btn', '恢复默认')
  reset.addEventListener('click', () => {
    resetSettings()
    closeSettingsModal()
    openSettingsModal(onClose)
  })
  const done = h('button', 'btn btn-primary', '完成')
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
  document.body.appendChild(backdrop)
  root = backdrop
}
