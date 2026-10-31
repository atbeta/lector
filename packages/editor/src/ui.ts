// 自绘控件（无 React 依赖，Radix/Linear 观感，使用我们的 token）。
// 滑块 / 开关 / 分段选择器，均为受控组件。

import { uiZoomPointerScale } from '@lector/shell-web'

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = className
  return e
}

/**
 * 分段选择器：滑块指示器跟随选中项。
 *
 * 返回 { root, set }：set 用于**程序化**改值（切换阅读主题会把字体档位一起换掉，
 * 分段控件必须跟着走），否则用户会看到「主题说用衬线，控件还亮着系统」。
 */
export function Segmented<T extends string>(
  value: T,
  options: Array<{ v: T; label: string }>,
  onChange: (v: T) => void,
): { root: HTMLElement; set: (v: T) => void } {
  const box = el('div', 'segmented')
  const indicator = el('span', 'seg-indicator')
  box.appendChild(indicator)
  const refs = new Map<string, HTMLButtonElement>()

  function placeIndicator() {
    const active = box.querySelector<HTMLButtonElement>('.seg-item.active')
    if (active) {
      indicator.style.left = `${active.offsetLeft}px`
      indicator.style.width = `${active.offsetWidth}px`
    }
  }

  function mark(v: T) {
    box.querySelectorAll('.seg-item').forEach((b) => b.classList.remove('active'))
    refs.get(v)?.classList.add('active')
    placeIndicator()
  }

  for (const opt of options) {
    const btn = el('button', 'seg-item' + (opt.v === value ? ' active' : '')) as HTMLButtonElement
    btn.textContent = opt.label
    btn.dataset.v = opt.v
    btn.addEventListener('click', () => {
      mark(opt.v)
      onChange(opt.v)
    })
    refs.set(opt.v, btn)
    box.appendChild(btn)
  }
  placeIndicator()
  new ResizeObserver(placeIndicator).observe(box)
  return { root: box, set: mark }
}

/**
 * 开关。返回值除了是元素本身，还带两个方法：
 * - `set(v)`：**程序化**改值。别的设置项（比如上传命令）一变，开关的可用性跟着变，
 *   不同步的话面板会显示一个和实际行为不符的状态；
 * - `setDisabled(v)`：不可用态。图片设置里有些开关是被另一根轴锁住的
 *   （没有上传命令就不能关掉本地副本），锁住时也要看得见它的值。
 */
export type SwitchEl = HTMLElement & {
  set: (v: boolean) => void
  setDisabled: (v: boolean) => void
}

export function Switch(
  checked: boolean,
  onChange: (v: boolean) => void,
  opts: { disabled?: boolean } = {},
): SwitchEl {
  const box = el('label', 'switch')
  const track = el('span', 'switch-track')
  box.appendChild(track)
  box.setAttribute('role', 'switch')
  box.tabIndex = 0
  let disabled = opts.disabled ?? false

  function set(v: boolean) {
    track.classList.toggle('on', v)
    box.setAttribute('aria-checked', String(v))
  }

  function setDisabled(v: boolean) {
    disabled = v
    box.classList.toggle('is-disabled', v)
    box.setAttribute('aria-disabled', String(v))
  }

  function toggle() {
    if (disabled) return
    const next = !track.classList.contains('on')
    set(next)
    onChange(next)
  }

  box.addEventListener('click', (e) => {
    e.preventDefault()
    toggle()
  })
  // 开关能聚焦就要能用键盘拨（role="switch" 的约定是 Space / Enter）。
  // 只加 tabIndex 不给按键，等于多一个拨不动的焦点站。
  box.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    toggle()
  })
  set(checked)
  setDisabled(disabled)
  return Object.assign(box, { set, setDisabled })
}

export interface SliderOptions {
  /** 「家」的位置：轨道上打刻度，双击弹回这里。不传就不画、也不响应双击。 */
  home?: number
  /** 双击复位的提示（写在 title 上，侧栏宽度已经用过同一句）。 */
  resetTip?: string
  /**
   * 离散档。给出后轨道按档等分：点击、拖动、方向键都进最近的一档，不再按 step 线性取整。
   * 档与档的数值间距可以不等（界面缩放的 125 与 150），等分是为了每一档一样好点。
   */
  stops?: readonly number[]
}

/**
 * 把 0–1 的轨道位置收成最近的一档。各档沿轨道等分。
 * 半档边界用四舍五入，靠右的那一档胜出。
 */
export function sliderStopAt(stops: readonly number[], pos: number): number {
  if (stops.length === 0) return 0
  if (stops.length === 1) return stops[0]!
  const p = clamp(pos, 0, 1)
  const idx = Math.round(p * (stops.length - 1))
  return stops[Math.min(stops.length - 1, Math.max(0, idx))]!
}

/**
 * 数值在等分档上的位置（0–1）。
 * 刚好落在某一档上时对准该档；落在两档之间时按数值比例插在这两档中间。超出两端则贴边。
 */
export function sliderStopPos(stops: readonly number[], value: number): number {
  const last = stops.length - 1
  if (last <= 0) return 0
  if (value <= stops[0]!) return 0
  if (value >= stops[last]!) return 1
  let i = 0
  while (i < last - 1 && stops[i + 1]! <= value) i++
  const a = stops[i]!
  const b = stops[i + 1]!
  const t = b === a ? 0 : (value - a) / (b - a)
  return (i + t) / last
}

/**
 * 拖动中的指针，换算回按下时的 clientX。
 *
 * 界面缩放走原生 zoom，一改缩放，clientX 和按下时的轨道矩形就不再是同一套数：
 * 点在 110% 上，缩放生效后同一只鼠标被算成相邻那一档，于是两档来回切换，界面一直闪。
 * screenX 不跟 zoom 走。按下时记下倍率，之后只累加「屏幕位移 / 按下时的倍率」。
 */
export function sliderDragX(
  origin: { clientX: number; screenX: number; zoom: number },
  screenX: number,
): number {
  const zoom = origin.zoom > 0 && Number.isFinite(origin.zoom) ? origin.zoom : 1
  return origin.clientX + (screenX - origin.screenX) / zoom
}

/** 方向键：走向比当前值更高或更低的相邻一档。 */
function adjacentStop(stops: readonly number[], current: number, delta: number): number {
  if (delta > 0) {
    const i = stops.findIndex((v) => v > current)
    return i < 0 ? stops[stops.length - 1]! : stops[i]!
  }
  if (delta < 0) {
    for (let i = stops.length - 1; i >= 0; i--) {
      if (stops[i]! < current) return stops[i]!
    }
    return stops[0]!
  }
  return current
}

/**
 * 滑块：自绘 track/fill/thumb，支持拖拽与键盘步进。
 *
 * 返回 { root, readout, set, setHome }：set 用于程序化改值（切主题会把标定值写回设置），
 * 拖拽期间不会被外部调用打断——拖动中的 thumb 属于用户，谁都不能抢。
 * setHome 换主题时跟着走：家是当前主题的标定，不是写死的 17px。
 */
export function Slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (n: number) => string = (n) => String(n),
  opts: SliderOptions = {},
): { root: HTMLElement; readout: HTMLElement; set: (v: number) => void; setHome: (home: number | undefined) => void } {
  const wrap = el('div', 'slider')
  const readout = el('span', 'slider-value')
  const track = el('div', 'slider-track')
  const fill = el('div', 'slider-fill')
  const homeTick = el('div', 'slider-home')
  const thumb = el('div', 'slider-thumb')
  track.append(fill, homeTick, thumb)
  wrap.appendChild(track)
  wrap.setAttribute('role', 'slider')
  wrap.setAttribute('aria-valuemin', String(min))
  wrap.setAttribute('aria-valuemax', String(max))
  wrap.tabIndex = 0

  const stops = opts.stops && opts.stops.length >= 2 ? opts.stops : null
  let dragging = false
  let home = opts.home
  // 按下时的轨道，以及当时的指针。松手之前都用这份，不要重新 getBoundingClientRect：
  // 界面缩放会改视口，浮层跟着去贴按钮，轨道在指针底下挪走；clientX 也会变成新坐标系。
  let dragOrigin: { rectLeft: number; rectWidth: number; clientX: number; screenX: number; zoom: number } | null = null
  // 已经提交给 onChange 的值。同一档上的指针移动不要反复写设置——
  // 写一次就会改缩放、挪轨道，拖动中等于自己把下一帧的落点打偏。
  let committed = value

  function placeHome() {
    if (home == null || !Number.isFinite(home)) {
      homeTick.hidden = true
      wrap.removeAttribute('title')
      return
    }
    const pct = stops ? sliderStopPos(stops, home) * 100 : ((clamp(home, min, max) - min) / (max - min)) * 100
    homeTick.style.left = `${pct}%`
    homeTick.hidden = false
    if (opts.resetTip) wrap.title = opts.resetTip
  }

  function render(v: number) {
    const pct = stops ? sliderStopPos(stops, v) * 100 : ((v - min) / (max - min)) * 100
    fill.style.width = `${pct}%`
    thumb.style.left = `${pct}%`
    readout.textContent = format(v)
    wrap.setAttribute('aria-valuenow', String(v))
  }

  function set(v: number) {
    if (dragging) return
    const next = clamp(v, min, max)
    committed = next
    render(next)
  }

  function setHome(next: number | undefined) {
    home = next
    placeHome()
  }

  function commit(v: number) {
    render(v)
    if (v === committed) return
    committed = v
    onChange(v)
  }

  function snapHome() {
    if (home == null || !Number.isFinite(home)) return
    commit(clamp(home, min, max))
  }

  function valueAt(clientX: number, screenX: number): number {
    const origin = dragOrigin
    const x = origin ? sliderDragX(origin, screenX) : clientX
    const left = origin ? origin.rectLeft : track.getBoundingClientRect().left
    const width = origin ? origin.rectWidth : track.getBoundingClientRect().width
    const span = width > 0 ? width : 1
    const pos = clamp((x - left) / span, 0, 1)
    if (stops) return sliderStopAt(stops, pos)
    const raw = min + pos * (max - min)
    return clamp(Math.round(raw / step) * step, min, max)
  }

  function setFrom(e: { clientX: number; screenX: number }) {
    commit(valueAt(e.clientX, e.screenX))
  }

  function beginDrag(e: { clientX: number; screenX: number }) {
    const rect = track.getBoundingClientRect()
    dragOrigin = {
      rectLeft: rect.left,
      rectWidth: rect.width > 0 ? rect.width : 1,
      clientX: e.clientX,
      screenX: e.screenX,
      zoom: uiZoomPointerScale(),
    }
    dragging = true
    setFrom(e)
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    track.setPointerCapture(e.pointerId)
    // 鼠标的第几击写在随后的 mousedown.detail 上；pointerdown.detail 按规范是 0，不能用来认双击。
    // 触摸没有这下 mousedown 的计数，按下即拖。
    if (e.pointerType !== 'mouse') beginDrag(e)
  })
  track.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    // 双击复位的第二下留给 dblclick 回家，不要按新位置再改一档。
    if (e.detail > 1) return
    beginDrag(e)
  })
  track.addEventListener('pointermove', (e) => {
    if (dragging) setFrom(e)
  })
  const endDrag = () => {
    dragging = false
    dragOrigin = null
  }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)
  // 双击回家：第一下已经落到点击处，这里弹回。第二下不再改值，所以中间只跳一次。
  wrap.addEventListener('dblclick', (e) => {
    e.preventDefault()
    endDrag()
    snapHome()
  })
  wrap.addEventListener('keydown', (e) => {
    let v = parseFloat(wrap.getAttribute('aria-valuenow') ?? String(value))
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      v = stops ? adjacentStop(stops, v, 1) : clamp(v + step, min, max)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      v = stops ? adjacentStop(stops, v, -1) : clamp(v - step, min, max)
    } else if (e.key === 'Home' && home != null) {
      e.preventDefault()
      snapHome()
      return
    } else return
    e.preventDefault()
    commit(v)
  })

  render(value)
  placeHome()
  return { root: wrap, readout, set, setHome }
}
