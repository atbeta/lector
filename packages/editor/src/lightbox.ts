// 图片放大查看（lightbox）。
//
// 阅读技术文档时，架构图、截图、表格图经常需要放大看细节；正文列再宽也装不下
// 一张图的细节（而且图上往往有大量小字），放大是读图的基本动作。
// 阅读页任意图片点击即全屏查看，而不是让用户去系统里打开原图。
//
// 边界都要处理干净，否则「浮层关不掉」比没有这个功能更糟：
// - Esc / 点击背景 / 点关闭按钮，三条路都能关
// - 打开时锁住正文滚动（背景不该跟着滚）
// - 关闭后把焦点还给原来的图片
// - 图片本身不触发点击关闭（看细节时误点不该退出）
//
// 同时复用为 mermaid / 其他 SVG 放大：调用方把 SVG 序列化为 data URL 传进来。

let open = false
let lastFocus: HTMLElement | null = null


/**
 * 在 lightbox 中显示一张可加载的图（普通 URL 或 data:image/...）。
 * 供 mermaid 等其他来源复用。
 */
export function showInLightbox(src: string, alt: string): void {
  if (open) return
  if (!currentShow) return
  currentShow(src, alt)
}

let currentShow: ((src: string, alt: string) => void) | null = null
let onClickRef: ((e: MouseEvent) => void) | null = null

export function mountLightbox(): () => void {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  const img = document.createElement('img')
  img.className = 'lightbox-img'
  img.alt = ''

  // 舞台：图外面垫一层「纸」，并决定「多大算合适」。
  // 不垫纸的话，mermaid 的 SVG 本身没有背景矩形，放大后就是一张浮在半透明遮罩上的
  // 线条图——看着像背景丢了。垫一层随主题走的纸，浅色是白、深色是深灰，
  // 既补上背景，也顺手给照片一个画框。
  const stage = document.createElement('div')
  stage.className = 'lightbox-stage'
  stage.appendChild(img)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'lightbox-close'
  close.setAttribute('aria-label', '关闭')
  close.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

  overlay.append(stage, close)
  document.body.appendChild(overlay)

  function show(src: string, alt: string): void {
    if (open) return
    open = true
    lastFocus = document.activeElement as HTMLElement | null
    img.src = src
    img.alt = alt
    // 矢量与位图分开摆：
    //  - 矢量（mermaid 渲染出的 SVG）没有「自然尺寸」的概念，按屏幕大小铺开最好看；
    //  - 位图有自然像素，放大只会糊，所以只缩不放。
    // 早前只有一套规则，结果小图放大后线条糊、大图又撑出屏幕。
    overlay.dataset.kind = /^data:image\/svg\+xml/.test(src) ? 'vector' : 'raster'
    overlay.hidden = false
    // 锁滚动：浮层是模态的，背景跟着滚会让人失去位置感
    document.documentElement.classList.add('lightbox-open')
    close.focus()
  }
  currentShow = show

  function hide(): void {
    if (!open) return
    open = false
    overlay.hidden = true
    img.removeAttribute('src')
    document.documentElement.classList.remove('lightbox-open')
    lastFocus?.focus?.()
    lastFocus = null
  }

  // 正文里的图片：点击放大。用事件委托，块重建后依然有效。
  onClickRef = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target || target.tagName !== 'IMG') return
    if (!target.closest('.reading-prose')) return
    e.preventDefault()
    e.stopPropagation()
    show((target as HTMLImageElement).src, (target as HTMLImageElement).alt)
  }

  // 点背景关闭；点图片本身不关（正在看细节）。舞台也算背景——
  // 图外面那圈「纸」是画框，不是内容，点它该关。
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === overlay || e.target === stage) hide()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
  }

  document.addEventListener('click', onClickRef, true)
  overlay.addEventListener('click', onOverlayClick)
  close.addEventListener('click', hide)
  // 捕获阶段：抢在编辑器/大纲的 Esc 处理之前关掉浮层
  document.addEventListener('keydown', onKey, true)

  return () => {
    document.removeEventListener('click', onClickRef as (e: MouseEvent) => void, true)
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    currentShow = null
    onClickRef = null
  }
}
