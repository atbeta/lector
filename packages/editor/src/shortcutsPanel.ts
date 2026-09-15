import { t } from './i18n.ts'
import { mod, modShift } from './keys.ts'

// 键盘面板：一份可查的键位清单。
//
// 为什么要有它：提示语（tooltip）不再附带快捷键——用户要查键位时不该把鼠标停在
// 每个按钮上逐个收集。这份表是**唯一**面向用户的键位说明。
//
// ⚠ 这份表必须与 main.ts 的 keydown 处理、cm.ts 的键位映射保持一致：
//   两边改动要同时改。面板与实际按键不一致，比没有面板更糟——
//   用户会照着按，然后以为功能坏了。
export interface ShortcutGroup {
  title: string
  rows: Array<{ keys: string; label: string }>
}

export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: t('shortcutGroupDoc'),
      rows: [
        { keys: mod('O'), label: t('openAria') },
        { keys: mod('S'), label: t('saveAria') },
        { keys: mod('R'), label: t('reloadFile') },
        { keys: mod(','), label: t('settingsAria') },
        { keys: modShift('O'), label: t('outlineAria') },
      ],
    },
    {
      title: t('shortcutGroupView'),
      rows: [
        { keys: `${mod('1')} / ${mod('2')} / ${mod('3')}`, label: t('shortcutModes') },
        { keys: 'Esc', label: t('shortcutLeaveEdit') },
      ],
    },
    {
      title: t('shortcutGroupEdit'),
      rows: [
        { keys: mod('F'), label: t('findAria') },
        { keys: mod('B'), label: t('fmtBold') },
        { keys: mod('I'), label: t('fmtItalic') },
        { keys: mod('K'), label: t('fmtLink') },
        { keys: mod('Z'), label: t('menuUndo') },
      ],
    },
  ]
}

/** 打开键盘面板。外观复用既有 modal 卡片，不新增一套浮层样式。 */
export function openShortcutsPanel(): void {
  const card = document.createElement('div')
  card.className = 'modal-card shortcuts-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  const head = document.createElement('div')
  head.className = 'shortcuts-head'
  const title = document.createElement('h2')
  title.textContent = t('shortcutTitle')
  head.append(title)

  const body = document.createElement('div')
  body.className = 'shortcuts-body'
  for (const group of shortcutGroups()) {
    const h = document.createElement('h3')
    h.className = 'shortcut-group'
    h.textContent = group.title
    body.append(h)
    for (const row of group.rows) {
      const line = document.createElement('div')
      line.className = 'shortcut-row'
      const keys = document.createElement('kbd')
      keys.className = 'shortcut-keys'
      keys.textContent = row.keys
      const label = document.createElement('span')
      label.className = 'shortcut-label'
      label.textContent = row.label
      line.append(keys, label)
      body.append(line)
    }
  }

  card.append(head, body)
  const host = document.createElement('div')
  host.className = 'modal-backdrop'
  host.append(card)
  const dismiss = (): void => {
    host.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
    }
  }
  host.addEventListener('click', (e) => {
    if (e.target === host) dismiss()
  })
  document.addEventListener('keydown', onKey, true)
  document.body.append(host)
}
