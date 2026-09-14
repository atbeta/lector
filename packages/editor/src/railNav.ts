// 右侧阅读导航轨：LibreChat 风格——顶/底三角 + 标题刻度 + 视口位置条。
//
// 为什么不做成「另一个滚动条」：原生滚动条已经够了（且现已隐藏按需浮现），
// 这条轨要提供的是「方位感」——余光扫一眼就知道「我在全文的哪里、上下还剩多少」。
// 顶/底三角 = 跳到首/尾；标题刻度 = 跳到对应节；中间圆角条 = 当前视口位置与高度。
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
  /**
   * 移动视口条。
   * @param top 视口顶端在全文中的比例 (0..1)
   * @param ratio 视口高度 / 全文高度 (0..1)
   */
  setPosition(top: number, ratio: number): void
  /** 把轨贴回正文容器右缘（窗口尺寸、侧栏开合后调用）。 */
  place(): void
}

export function createRailNav(opts: {
  content: HTMLElement
  onJump: (id: string) => void
}): RailNav {
  const el = document.createElement('nav')
  el.className = 'reader-rail'
  el.hidden = true

  const upBtn = document.createElement('button')
  upBtn.type = 'button'
  upBtn.className = 'rail-arrow rail-up'
  upBtn.setAttribute('aria-label', '跳到顶部')
  upBtn.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 8 L6 4 L10 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const track = document.createElement('div')
  track.className = 'rail-track'

  const pill = document.createElement('div')
  pill.className = 'rail-pill'
  track.appendChild(pill)

  const downBtn = document.createElement('button')
  downBtn.type = 'button'
  downBtn.className = 'rail-arrow rail-down'
  downBtn.setAttribute('aria-label', '跳到底部')
  downBtn.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4 L6 8 L10 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  el.appendChild(upBtn)
  el.appendChild(track)
  el.appendChild(downBtn)
  document.body.appendChild(el)

  upBtn.addEventListener('click', () => {
    opts.content.scrollTo({ top: 0, behavior: 'smooth' })
  })
  downBtn.addEventListener('click', () => {
    opts.content.scrollTo({ top: opts.content.scrollHeight, behavior: 'smooth' })
  })

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
        tick.dataset.depth = String(Math.min(Math.max(h.depth, 1), 4))
        tick.title = h.text
        tick.setAttribute('aria-label', h.text)
        tick.addEventListener('click', (e) => {
          e.stopPropagation()
          opts.onJump(h.id)
        })
        ticks.set(h.id, tick)
        track.appendChild(tick)
      }
      setActive(activeId)
      place()
    },
    relayout(getTop: (id: string) => number | null, scrollHeight: number): void {
      if (ticks.size === 0) return
      const h = track.clientHeight
      if (h <= 0 || scrollHeight <= 0) return
      for (const [id, tick] of ticks) {
        const top = getTop(id)
        if (top == null) continue
        tick.style.top = `${Math.min(1, Math.max(0, top / scrollHeight)) * h}px`
      }
    },
    setActive,
    setPosition(top: number, ratio: number): void {
      const h = track.clientHeight
      if (h <= 0) {
        pill.style.display = 'none'
        return
      }
      const clampedTop = Math.min(1, Math.max(0, top))
      const clampedRatio = Math.min(1, Math.max(0, ratio))
      const pillH = Math.max(8, clampedRatio * h)
      const maxTop = Math.max(0, h - pillH)
      pill.style.display = ''
      pill.style.height = `${pillH}px`
      pill.style.top = `${clampedTop * maxTop}px`
    },
    place,
  }
}
