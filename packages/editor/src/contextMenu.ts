// 右键菜单。
//
// 为什么需要它：AGENTS.md 写着「阅读优先，编辑做到顺手能改即可」。
// 功能不做进常驻 UI，正是靠右键菜单承接——不占版面，但随时可得。
// 这也是常驻工具栏（Typora 底部那排）的替代方案：需要时出现，不需要时不存在。
//
// 关闭路径必须齐全：选中一项、点外面、Esc、滚动、窗口失焦。
// 「菜单关不掉」比没有菜单更让人恼火。

export interface ContextMenuItem {
  /** 分隔线（在这一项之前画一条） */
  separatorBefore?: boolean
  label?: string
  /** 右侧灰字提示，如快捷键 */
  hint?: string
  /** 危险动作（删除类）用红色文字 */
  danger?: boolean
  disabled?: boolean
  run?: () => void
}

let panel: HTMLElement | null = null
let detach: (() => void) | null = null

/** 菜单是否打开。 */
export function contextMenuOpen(): boolean {
  return panel !== null && !panel.hidden
}

export function hideContextMenu(): void {
  if (!panel) return
  panel.hidden = true
  panel.replaceChildren()
  detach?.()
  detach = null
}

/**
 * 在 (x, y) 弹出菜单。
 * items 里 `run` 缺省或 disabled 的项显示为不可点。
 */
export function showContextMenu(items: ContextMenuItem[], x: number, y: number): void {
  hideContextMenu()
  if (items.length === 0) return

  const el = document.createElement('div')
  el.className = 'context-menu'
  el.setAttribute('role', 'menu')
  el.tabIndex = -1

  const buttons: HTMLButtonElement[] = []
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement('div')
      sep.className = 'context-sep'
      el.appendChild(sep)
    }
    if (!item.label) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'context-item'
    btn.setAttribute('role', 'menuitem')
    if (item.danger) btn.dataset.danger = 'true'
    const label = document.createElement('span')
    label.textContent = item.label
    btn.appendChild(label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'context-hint'
      hint.textContent = item.hint
      btn.appendChild(hint)
    }
    if (item.disabled || !item.run) {
      btn.disabled = true
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        hideContextMenu()
        item.run?.()
      })
      buttons.push(btn)
    }
    el.appendChild(btn)
  }

  document.body.appendChild(el)
  panel = el

  // 定位：先在视口外量尺寸，再夹到视口内（右下角右键时不能溢出屏幕）
  el.style.left = '-9999px'
  el.style.top = '-9999px'
  const rect = el.getBoundingClientRect()
  const margin = 8
  const left = Math.min(Math.max(margin, x), window.innerWidth - rect.width - margin)
  const top = Math.min(Math.max(margin, y), window.innerHeight - rect.height - margin)
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
  el.focus()

  // ── 关闭路径 ──
  const onDown = (e: MouseEvent) => {
    if (!(e.target as HTMLElement | null)?.closest('.context-menu')) hideContextMenu()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      hideContextMenu()
      return
    }
    // 方向键在菜单项之间移动，Enter 触发——右键菜单是键盘可达的
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1
      const target = buttons[(next + buttons.length) % buttons.length]
      target?.focus()
    }
  }
  const onScroll = () => hideContextMenu()
  const onBlur = () => hideContextMenu()

  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  window.addEventListener('blur', onBlur)
  detach = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onScroll)
    window.removeEventListener('blur', onBlur)
    panel?.remove()
    panel = null
  }
}
