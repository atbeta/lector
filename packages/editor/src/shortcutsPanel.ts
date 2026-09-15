import { t } from './i18n.ts'
import { mod, modShift } from './keys.ts'

// 键盘面板：一份可查的键位清单。
//
// 形态是「悬浮卡」而不是模态弹窗：查键位是「看一眼就走」的动作，
// 模态会把正文整个遮住、还要 Esc/点空白收场，太重。
// 悬停键盘按钮 250ms 即出，移走即收；点击则钉住（键盘用户也能用），
// 再点 / 点别处 / Esc 收起。定位贴按钮下沿，与外观浮层同一套语言。
//
// 提示语（tooltip）不再附带快捷键——这份表是**唯一**面向用户的键位说明。
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
        { keys: mod('W'), label: t('menuCloseFile') },
        { keys: mod('R'), label: t('reloadFile') },
        { keys: mod(','), label: t('settingsAria') },
        { keys: modShift('O'), label: t('outlineAria') },
      ],
    },
    {
      title: t('shortcutGroupView'),
      // 三个视图档各占一行：合并成「⌘1 / ⌘2 / ⌘3 → 阅读/编辑/源码」
      // 读者得自己做两次对应，拆开才是「查表」。
      rows: [
        { keys: mod('1'), label: t('modeLabelRead') },
        { keys: mod('2'), label: t('modeLabelEdit') },
        { keys: mod('3'), label: t('modeLabelSource') },
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

let root: HTMLElement | null = null
let dispose: (() => void) | null = null
let pinned = false
let hoverTimer: ReturnType<typeof setTimeout> | null = null

export function closeShortcutsPanel(): void {
  dispose?.()
  dispose = null
  root?.remove()
  root = null
  pinned = false
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

function buildCard(): HTMLElement {
  const card = document.createElement('div')
  card.className = 'shortcuts-pop'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'false')
  // 面板不印标题：键位表本身就是标题。aria-label 留给读屏。
  card.setAttribute('aria-label', t('shortcutTitle'))
  for (const group of shortcutGroups()) {
    // 每组一列（横向排布）：键位表因此又短又宽，不需要滚动条
    const col = document.createElement('div')
    col.className = 'shortcut-col'
    const h = document.createElement('h3')
    h.className = 'shortcut-group'
    h.textContent = group.title
    col.append(h)
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
      col.append(line)
    }
    card.append(col)
  }
  return card
}

function open(anchor: HTMLElement, pin: boolean): void {
  if (root) {
    pinned = pinned || pin
    return
  }
  pinned = pin
  const pop = buildCard()
  const r = anchor.getBoundingClientRect()
  pop.style.top = `${Math.round(r.bottom + 8)}px`
  pop.style.right = `${Math.round(Math.max(12, window.innerWidth - r.right))}px`

  const onDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('.shortcuts-pop, #keyboard-btn')) return
    closeShortcutsPanel()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeShortcutsPanel()
  }
  const onViewport = () => closeShortcutsPanel()
  // 悬停打开的卡片，指针离开按钮与卡片就收（钉住的不收）
  const onLeave = (e: PointerEvent) => {
    if (pinned) return
    const to = e.relatedTarget as HTMLElement | null
    if (to?.closest('.shortcuts-pop, #keyboard-btn')) return
    closeShortcutsPanel()
  }

  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onViewport)
  pop.addEventListener('pointerleave', onLeave)
  anchor.addEventListener('pointerleave', onLeave)
  anchor.setAttribute('aria-expanded', 'true')

  document.body.appendChild(pop)
  root = pop
  dispose = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onViewport)
    anchor.removeEventListener('pointerleave', onLeave)
    anchor.setAttribute('aria-expanded', 'false')
  }
}

/**
 * 绑定键盘按钮：悬停 250ms 展开（看一眼就走），点击钉住（要照着按）。
 * 已钉住时再点按钮 = 收起（toggle 语义）。
 */
export function bindShortcutsButton(anchor: HTMLElement): void {
  anchor.setAttribute('aria-haspopup', 'dialog')
  anchor.addEventListener('pointerenter', () => {
    if (root) return
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => open(anchor, false), 250)
  })
  anchor.addEventListener('pointerleave', () => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
  })
  anchor.addEventListener('click', () => {
    if (root && pinned) closeShortcutsPanel()
    else open(anchor, true)
  })
}
