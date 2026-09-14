// 右侧阅读导航轨：标题刻度 + 当前位置点。
//
// 为什么大纲之外还要一条轨：大纲给「结构」，这条轨给「方位」。
// 刻度的长短表达层级（h1 最长），纵向位置表达它在文档里的位置；
// 阅读时余光扫一眼就知道「我在全文的哪里」，点一下刻度就跳到那一节。
// 它不说话、不抢焦点，静止时半隐——但一直在那里。
//
// 几何：轨贴正文容器右缘（32px 右内边距里，滚动条内侧），
// 顶底与正文容器对齐，所以窗口/侧栏/平台外框变化时只要重读 content 的 rect。

export interface RailHeading {
  id: string
  depth: number
  text: string
}

export interface RailNav {
  readonly el: HTMLElement
  /** 重建刻度（标题集合变化时调用）。 */
  render(headings: RailHeading[]): void
  /** 按文档实际布局重算刻度纵坐标（render 后、布局变化后调用）。 */
  relayout(getTop: (id: string) => number | null, scrollHeight: number): void
  /** 高亮当前小节对应的刻度。 */
  setActive(id: string | null): void
  /** 移动当前位置点（0..1，视口中心在全文中的比例）。 */
  setPosition(fraction: number): void
  /** 把轨贴回正文容器右缘（窗口尺寸、侧栏开合后调用）。 */
  place(): void
}

export function createRailNav(opts: {
  content: HTMLElement
  onJump: (id: string) => void
}): RailNav {
  const el = document.createElement('nav')
  el.className = 'rail-nav'
  el.hidden = true

  const dot = document.createElement('div')
  dot.className = 'rail-dot'
  el.appendChild(dot)
  document.body.appendChild(el)

  const ticks = new Map<string, HTMLButtonElement>()
  let activeId: string | null = null

  function place(): void {
    const rect = opts.content.getBoundingClientRect()
    el.style.top = `${rect.top + 8}px`
    el.style.height = `${Math.max(0, rect.height - 16)}px`
    el.style.left = `${rect.right - 34}px`
  }

  function setActive(id: string | null): void {
    activeId = id
    for (const [tickId, tick] of ticks) {
      tick.classList.toggle('active', tickId === id)
    }
  }

  return {
    el,
    render(headings: RailHeading[]): void {
      for (const tick of ticks.values()) tick.remove()
      ticks.clear()
      el.hidden = headings.length === 0
      for (const h of headings) {
        const tick = document.createElement('button')
        tick.type = 'button'
        tick.className = 'rail-tick'
        // 层级只分四档线长：h4 以下再细分就没人分得清了
        tick.dataset.depth = String(Math.min(Math.max(h.depth, 1), 4))
        tick.title = h.text
        tick.setAttribute('aria-label', h.text)
        tick.addEventListener('click', () => opts.onJump(h.id))
        ticks.set(h.id, tick)
        el.appendChild(tick)
      }
      setActive(activeId)
      place()
    },
    relayout(getTop: (id: string) => number | null, scrollHeight: number): void {
      if (ticks.size === 0) return
      const h = el.clientHeight
      if (h <= 0 || scrollHeight <= 0) return
      for (const [id, tick] of ticks) {
        const top = getTop(id)
        if (top == null) continue
        tick.style.top = `${Math.min(1, Math.max(0, top / scrollHeight)) * h}px`
      }
    },
    setActive,
    setPosition(fraction: number): void {
      const h = el.clientHeight
      if (h <= 0) return
      dot.style.top = `${Math.min(1, Math.max(0, fraction)) * h}px`
    },
    place,
  }
}
