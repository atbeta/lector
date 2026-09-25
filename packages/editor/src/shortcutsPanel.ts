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
// ⚠ 这份表必须与 shortcutDispatch.ts 的判定表、cm.ts 的键位映射保持一致：
//   两处改动要同时改。面板与实际按键不一致，比没有面板更糟——
//   用户会照着按，然后以为功能坏了。
//   唯一有意的例外：界面缩放/字号那 6 个键不列在这儿（判定表仍保留），
//   原因见下面「编辑与查找」组前的注释。
export interface ShortcutGroup {
  title: string
  rows: Array<{ keys: string; label: string }>
}

export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: t('shortcutGroupDoc'),
      rows: [
        { keys: mod('N'), label: t('newFile') },
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
        // 面板自己也要能被查出来
        { keys: mod('/'), label: t('shortcutTitle') },
      ],
    },
    {
      // 界面缩放 / 字号那 6 个快捷键（⌘=/-/0、⇧⌘=/-/0）**故意不列在这里**：
      // 它们在壳里不可靠——macOS 菜单把 ⇧⌘0 判给了 ⌘0，Windows 的 WebView2 又会
      // 先吃掉一部分缩放组合键。判定表仍保留（键还能按），但不再向用户宣传，
      // 免得照着按然后以为坏了。缩放/字号从菜单项与设置里调。
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

export function closeShortcutsPanel(): void {
  dispose?.()
  dispose = null
  root?.remove()
  root = null
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

/**
 * 打开键位表；已经开着就收起（toggle）。⌘/ 与 ? 都走这里。
 *
 * 常驻按钮已经拿掉：键位表是**参考资料**，业界惯例是快捷键呼出（Gmail / GitHub /
 * Slack / VS Code 都没有常驻图标）。anchor 只在「设置里点查看」时传，面板贴到
 * 那个按钮下方；否则贴右上角（原来按钮所在的角落）。打开即钉住——没有按钮就没有
 * 「移开即收」可言，关闭靠 Esc、点外面、再按一次快捷键。
 */
export function openShortcutsPanel(anchor?: HTMLElement): void {
  if (root) {
    closeShortcutsPanel()
    return
  }
  const pop = buildCard()
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    pop.style.top = `${Math.round(r.bottom + 8)}px`
    pop.style.right = `${Math.round(Math.max(12, window.innerWidth - r.right))}px`
  } else {
    const bar = document.getElementById('titlebar')
    const top = bar ? bar.getBoundingClientRect().bottom + 8 : 54
    pop.style.top = `${Math.round(top)}px`
    pop.style.right = '14px'
  }

  const onDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('.shortcuts-pop')) return
    closeShortcutsPanel()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeShortcutsPanel()
  }
  const onViewport = () => closeShortcutsPanel()

  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onViewport)

  document.body.appendChild(pop)
  root = pop
  dispose = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onViewport)
  }
}
