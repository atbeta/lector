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

/** 分段选择器：滑块指示器跟随选中项。 */
export function Segmented<T extends string>(
  value: T,
  options: Array<{ v: T; label: string }>,
  onChange: (v: T) => void,
): HTMLElement {
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

  for (const opt of options) {
    const btn = el('button', 'seg-item' + (opt.v === value ? ' active' : '')) as HTMLButtonElement
    btn.textContent = opt.label
    btn.dataset.v = opt.v
    btn.addEventListener('click', () => {
      box.querySelectorAll('.seg-item').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      placeIndicator()
      onChange(opt.v)
    })
    refs.set(opt.v, btn)
    box.appendChild(btn)
  }
  placeIndicator()
  new ResizeObserver(placeIndicator).observe(box)
  return box
}

/** 开关。 */
export function Switch(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const box = el('label', 'switch')
  const track = el('span', 'switch-track')
  box.appendChild(track)
  box.setAttribute('role', 'switch')
  box.setAttribute('aria-checked', String(checked))
  track.classList.toggle('on', checked)
  box.addEventListener('click', (e) => {
    e.preventDefault()
    const next = !track.classList.contains('on')
    track.classList.toggle('on', next)
    box.setAttribute('aria-checked', String(next))
    onChange(next)
  })
  return box
}

/** 滑块：自绘 track/fill/thumb，支持拖拽与键盘步进。 */
export function Slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (n: number) => string = (n) => String(n),
): { root: HTMLElement; readout: HTMLElement } {
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
  return { root: wrap, readout }
}
