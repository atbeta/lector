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
  /**
   * 会改动文档的动作。
   *
   * 只读档（阅读）不给这类项——规矩与过滤都在 documentMenus 的 forMode()：
   * 菜单是阅读档与编辑档唯一共用的入口，漏一个「编辑表格」就等于阅读档能改文档。
   * 只做复制、打开链接、查看原图这类不动内容的项不要标。
   */
  mutates?: boolean
  run?: () => void
}

let panel: HTMLElement | null = null
let detach: (() => void) | null = null
let anchorEl: HTMLElement | null = null

export function hideContextMenu(): void {
  if (!panel) return
  panel.hidden = true
  panel.replaceChildren()
  detach?.()
  detach = null
  anchorEl = null
}

/** 菜单是否正由这个按钮开着：给「点同一个按钮 = 收起」的 toggle 用。 */
export function isContextMenuOpenFor(anchor: HTMLElement): boolean {
  return panel !== null && anchorEl === anchor
}

/**
 * 在 (x, y) 弹出菜单。
 * items 里 `run` 缺省或 disabled 的项显示为不可点。
 *
 * `anchor` 是可选的「触发按钮」：点它会先被关闭监听看到。若不排除，
 * 再点一次按钮会变成「先关、click 里又开」，看起来永远收不起来（toggle 失效）。
 * 传入 anchor 后，落在它上面的 mousedown 不关菜单，由调用方在 click 里做 toggle。
 */
export function showContextMenu(
  items: ContextMenuItem[],
  x: number,
  y: number,
  anchor?: HTMLElement,
): void {
  hideContextMenu()
  if (items.length === 0) return
  anchorEl = anchor ?? null

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

  // 有选区时**不抢焦点**。
  //
  // 焦点一离开正文，浏览器就不再绘制选区高亮——选区本身还在（getSelection() 照样有
  // 内容、⌘C 也复制得到），但那块灰底没了。用户刚选好一段文字、右键想在菜单里点
  // 「复制选中的文字」，看到的是「选中的字突然没选上」：看不到选了什么，就没法确认。
  // 这也正是菜单里那条「复制选中的文字」最需要选区的时刻。
  //
  // 没有选区时照旧接管焦点：键盘导航（方向键在项之间走）与读屏都靠它。
  const hasSelection = (window.getSelection()?.toString() ?? '').length > 0
  if (!hasSelection) el.focus()

  // ── 关闭路径 ──
  const onDown = (e: MouseEvent) => {
    // e.target 不一定是 Element（偶尔是 Document / 文本节点），没有 closest——
    // 直接调会抛错，菜单反而关不掉。这里只对 Element 判断是否点在菜单里。
    const el = e.target as Element | null
    const inMenu = !!el && typeof el.closest === 'function' && el.closest('.context-menu')
    // 点在触发按钮上不关：由按钮自己的 click 做 toggle（见 showContextMenu 的 anchor）
    const inAnchor = !!el && typeof el.closest === 'function' && !!anchorEl?.contains(el)
    if (!inMenu && !inAnchor) hideContextMenu()
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
      return
    }
    // 焦点没被接管时（就是上面有选区那条路），按键会照常落进正文：第一下按键只负责
    // 收菜单并吃掉这一次，别让它改动文档——原生右键菜单就是这个行为。
    // 修饰键组合（⌘C 之类）放行：那是用户明确想要的。
    if (document.activeElement !== el) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      hideContextMenu()
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
