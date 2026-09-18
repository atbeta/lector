// 自绘控件（无 React 依赖，Radix/Linear 观感，使用我们的 token）。
// 滑块 / 开关 / 分段选择器，均为受控组件。

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

/**
 * 滑块：自绘 track/fill/thumb，支持拖拽与键盘步进。
 *
 * 返回 { root, readout, set }：set 用于程序化改值（切主题会把标定值写回设置），
 * 拖拽期间不会被外部调用打断——拖动中的 thumb 属于用户，谁都不能抢。
 */
export function Slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (n: number) => string = (n) => String(n),
): { root: HTMLElement; readout: HTMLElement; set: (v: number) => void } {
  const wrap = el('div', 'slider')
  const readout = el('span', 'slider-value')
  const track = el('div', 'slider-track')
  const fill = el('div', 'slider-fill')
  const thumb = el('div', 'slider-thumb')
  track.append(fill, thumb)
  wrap.appendChild(track)
  wrap.setAttribute('role', 'slider')
  wrap.setAttribute('aria-valuemin', String(min))
  wrap.setAttribute('aria-valuemax', String(max))
  wrap.tabIndex = 0

  let dragging = false

  function render(v: number) {
    const pct = ((v - min) / (max - min)) * 100
    fill.style.width = `${pct}%`
    thumb.style.left = `${pct}%`
    readout.textContent = format(v)
    wrap.setAttribute('aria-valuenow', String(v))
  }

  function set(v: number) {
    if (dragging) return
    render(clamp(v, min, max))
  }

  function setFrom(clientX: number) {
    const rect = track.getBoundingClientRect()
    const pos = clamp((clientX - rect.left) / rect.width, 0, 1)
    const raw = min + pos * (max - min)
    const stepped = Math.round(raw / step) * step
    const v = clamp(stepped, min, max)
    render(v)
    onChange(v)
  }

  track.addEventListener('pointerdown', (e) => {
    dragging = true
    setFrom(e.clientX)
    track.setPointerCapture(e.pointerId)
  })
  track.addEventListener('pointermove', (e) => {
    if (dragging) setFrom(e.clientX)
  })
  track.addEventListener('pointerup', () => (dragging = false))
  track.addEventListener('pointercancel', () => (dragging = false))
  wrap.addEventListener('keydown', (e) => {
    let v = parseFloat(wrap.getAttribute('aria-valuenow') ?? String(value))
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = clamp(v + step, min, max)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = clamp(v - step, min, max)
    else return
    e.preventDefault()
    render(v)
    onChange(v)
  })

  render(value)
  return { root: wrap, readout, set }
}
