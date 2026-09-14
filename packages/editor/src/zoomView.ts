/**
 * 灯箱里的缩放画布：先「适配视口」，再 Ctrl/⌘ + 滚轮缩放、按住拖动平移。
 *
 * 与 notefast 的 MediaZoomView 同一套手势模型（图片与 mermaid SVG 共用，
 * 不要图片一套、图一套）：滚轮缩放要按修饰键，拖动平移，点空白关闭。
 *
 * 两个关键取舍：
 *
 * 1. 用「滚动容器 + 显式尺寸外框」而不是 transform 矩阵。
 *    平移就是 scrollLeft/scrollTop——缩放时不需要自己维护偏移量，
 *    也不会在缩放之后把光标位置算丢；而且内容没超出时容器自动居中（flex），
 *    「小图居中、大图可拖」是同一段 CSS 的结果，不用分两套逻辑。
 *
 * 2. 默认是「铺满」而不是「100%」。
 *    mermaid SVG 的设计尺寸常常只有一两百 px，把 base 卡在 1× 的灯箱会小得没法看；
 *    灯箱打开的第一眼就该是「看全」，再让用户自己决定放大到多少。
 *    所以 base = 适配倍率（允许 > 1），用户倍率 zoom 在它之上叠加，1.0 = 适配。
 */

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 8
export const ZOOM_STEP = 0.25
/** 适配时留出的边距比例：0.88 让图与屏幕边缘之间永远有一圈呼吸 */
export const VIEWPORT_FILL = 0.88

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** 把自然尺寸适配进视口：小图放大、大图缩小。 */
export function fitScale(natW: number, natH: number, viewW: number, viewH: number, fill = VIEWPORT_FILL): number {
  if (natW <= 0 || natH <= 0 || viewW <= 0 || viewH <= 0) return 1
  return clampZoom(Math.min((viewW * fill) / natW, (viewH * fill) / natH))
}

/** data URL 的正文（非 base64 时要做 percent 解码，否则找不到 <svg）。 */
function decodeDataUrl(src: string): string {
  const comma = src.indexOf(',')
  if (comma < 0) return src
  const meta = src.slice(0, comma)
  const body = src.slice(comma + 1)
  if (meta.includes('base64')) {
    try {
      return atob(body)
    } catch {
      return ''
    }
  }
  try {
    return decodeURIComponent(body)
  } catch {
    return body
  }
}

/**
 * 从 SVG 源码里读「设计尺寸」。
 * 优先 viewBox——mermaid 的 svg 常常写 width="100%"，那是容器撑出来的，
 * 拿它当自然尺寸会让「适配」算出一个毫无意义的倍率。
 */
export function svgNaturalSizeFromSource(src: string): { w: number; h: number } | null {
  const text = src.startsWith('data:') ? decodeDataUrl(src) : src
  if (!text.includes('<svg')) return null
  const head = text.slice(0, 4000)
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(head)
  if (vb) {
    const parts = vb[1]!.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) return { w: parts[2]!, h: parts[3]! }
  }
  const w = /\swidth\s*=\s*["'](\d+(?:\.\d+)?)["']/i.exec(head)
  const h = /\sheight\s*=\s*["'](\d+(?:\.\d+)?)["']/i.exec(head)
  if (w && h) return { w: Number(w[1]), h: Number(h[1]) }
  return null
}

export interface ZoomViewOptions {
  /** 点空白处（不是媒体本身，且没拖动过）时回调——灯箱据此关闭 */
  onBackgroundClick: () => void
  /** 文案由调用方给（i18n 在本模块之外） */
  labels: { hint: string; fit: string; zoomIn: string; zoomOut: string }
}

export interface ZoomView {
  readonly root: HTMLElement
  show(src: string, alt: string): void
  /** 复位到「适配视口」（用户倍率 1.0） */
  reset(): void
  /** 关闭时清掉 src 并复位 */
  clear(): void
  zoomBy(steps: number): void
  zoomed(): boolean
}

export function createZoomView(opts: ZoomViewOptions): ZoomView {
  const root = document.createElement('div')
  root.className = 'lb-canvas'

  const pad = document.createElement('div')
  pad.className = 'lb-pad'

  const media = document.createElement('div')
  media.className = 'lb-media'
  const img = document.createElement('img')
  img.className = 'lb-img'
  img.alt = ''
  img.draggable = false
  media.appendChild(img)
  pad.appendChild(media)
  root.appendChild(pad)

  // ── 工具条：左上角读数 + 右下角控制 ──
  const hud = document.createElement('div')
  hud.className = 'lb-hud'
  const readout = document.createElement('span')
  readout.className = 'lb-zoom-readout'
  const hint = document.createElement('span')
  hint.className = 'lb-zoom-hint'
  hint.textContent = opts.labels.hint
  hud.append(readout, hint)

  const tools = document.createElement('div')
  tools.className = 'lb-tools'
  const mkBtn = (label: string, text: string, cls: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `lb-tool ${cls}`
    b.setAttribute('aria-label', label)
    b.dataset.tip = label
    b.innerHTML = text
    return b
  }
  const btnOut = mkBtn(opts.labels.zoomOut, '&minus;', 'lb-tool--icon')
  const btnFit = mkBtn(opts.labels.fit, '', 'lb-tool--fit')
  const btnIn = mkBtn(opts.labels.zoomIn, '+', 'lb-tool--icon')
  btnFit.innerHTML = `<span class="lb-tool-label">${opts.labels.fit}</span>`
  tools.append(btnOut, btnFit, btnIn)

  root.append(hud, tools)

  let natural: { w: number; h: number } | null = null
  let base = 1
  let zoom = 1

  const displayScale = () => base * zoom

  function apply(): void {
    if (natural) {
      const s = displayScale()
      media.classList.remove('lb-media--auto')
      media.style.width = `${Math.round(natural.w * s)}px`
      media.style.height = `${Math.round(natural.h * s)}px`
    } else {
      // 量不出自然尺寸（少见：图片解码失败）时退化成「撑满画布」，至少还能看
      media.classList.add('lb-media--auto')
      media.style.width = ''
      media.style.height = ''
    }
    readout.textContent = `${Math.round(zoom * 100)}%`
    const isZoomed = Math.abs(zoom - 1) > 0.001
    btnFit.hidden = !isZoomed
    root.dataset.zoomed = String(isZoomed)
  }

  /** 重新测自然尺寸并重算适配倍率。开箱、换图、容器尺寸变化都要走一遍。 */
  function measure(): void {
    const fromSource = svgNaturalSizeFromSource(img.src)
    if (fromSource) {
      natural = fromSource
      base = fitScale(natural.w, natural.h, root.clientWidth, root.clientHeight)
      apply()
      return
    }
    const done = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        natural = { w: img.naturalWidth, h: img.naturalHeight }
      } else {
        const r = img.getBoundingClientRect()
        natural = r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null
      }
      base = natural ? fitScale(natural.w, natural.h, root.clientWidth, root.clientHeight) : 1
      apply()
    }
    if (img.complete && img.naturalWidth > 0) done()
    else {
      natural = null
      apply()
      img.addEventListener('load', done, { once: true })
      img.addEventListener(
        'error',
        () => {
          natural = null
          apply()
        },
        { once: true },
      )
    }
  }

  const ro = new ResizeObserver(() => {
    if (!natural) return
    base = fitScale(natural.w, natural.h, root.clientWidth, root.clientHeight)
    apply()
  })
  ro.observe(root)

  // ── 滚轮缩放（按修饰键，普通滚轮留给画布滚动）──
  root.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return // 不按修饰键 = 滚动容器自己的事
      e.preventDefault()
      zoomBy(e.deltaY > 0 ? -1 : 1)
    },
    { passive: false },
  )

  // ── 拖动平移 ──
  let drag: { x: number; y: number; sl: number; st: number; onMedia: boolean } | null = null
  root.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    root.setPointerCapture(e.pointerId)
    const box = media.getBoundingClientRect()
    drag = {
      x: e.clientX,
      y: e.clientY,
      sl: root.scrollLeft,
      st: root.scrollTop,
      onMedia:
        e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom,
    }
    root.classList.add('lb-grabbing')
  })
  root.addEventListener('pointermove', (e) => {
    if (!drag) return
    root.scrollLeft = drag.sl - (e.clientX - drag.x)
    root.scrollTop = drag.st - (e.clientY - drag.y)
  })
  const endDrag = (e: PointerEvent) => {
    if (!drag) return
    const d = drag
    drag = null
    root.classList.remove('lb-grabbing')
    if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId)
    // 点空白关闭：只有「没拖动」且「没点在媒体上」才算点击，否则每次拖完都会误关
    if (!d.onMedia && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) opts.onBackgroundClick()
  }
  root.addEventListener('pointerup', endDrag)
  root.addEventListener('pointercancel', endDrag)

  function zoomBy(steps: number): void {
    zoom = clampZoom(zoom + steps * ZOOM_STEP)
    apply()
  }

  btnIn.addEventListener('click', () => zoomBy(1))
  btnOut.addEventListener('click', () => zoomBy(-1))
  btnFit.addEventListener('click', () => {
    zoom = 1
    apply()
  })

  /** 复位到「适配视口」（用户倍率 1.0，不是 100% 像素） */
  function reset(): void {
    zoom = 1
    apply()
  }

  /** 关闭时清掉 src：data URL 可能是几百 KB 的 SVG 文本，留在 DOM 里没必要 */
  function clear(): void {
    img.removeAttribute('src')
    natural = null
    zoom = 1
    root.scrollTop = 0
    root.scrollLeft = 0
    apply()
  }

  return {
    root,
    show(src, alt) {
      zoom = 1
      natural = null
      img.alt = alt
      img.src = src
      measure()
      apply()
      root.scrollTop = 0
      root.scrollLeft = 0
    },
    reset,
    clear,
    zoomBy,
    zoomed: () => Math.abs(zoom - 1) > 0.001,
  }
}
