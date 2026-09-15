// 图片 / mermaid 图放大查看（lightbox）。
//
// 阅读技术文档时，架构图、截图、表格图经常需要放大看细节；正文列再宽也装不下
// 一张图的细节（图上往往还有大量小字），放大是读图的基本动作。
// 阅读页任意图片点击即全屏查看，而不是让用户去系统里打开原图。
//
// 放大不是「撑到最大」就完了：打开时先适配视口（第一眼看全），再支持缩放 + 平移
// （看细节）。手势模型与 notefast 的灯箱一致，画布本身在 zoomView.ts。
//
// 边界都要处理干净，否则「浮层关不掉」比没有这个功能更糟：
// - Esc / 点击空白 / 点关闭按钮，三条路都能关
// - 打开时锁住正文滚动（背景不该跟着滚）
// - 关闭后焦点还给正文，不然键盘用户卡在浮层里，下一步按什么都没反应
//
// 为什么整篇文档只挂一个浮层：图可以有很多张，但同一时刻只会看一张。
// 每张图一个浮层会让 DOM、事件绑与「当前打开的是哪张」的同步都变成 N 份。

import { createZoomView, type ZoomView } from './zoomView.ts'
import { t } from './i18n.ts'
import { mod } from './keys.ts'

let overlay: HTMLElement | null = null
let zoom: ZoomView | null = null
let closeBtn: HTMLButtonElement | null = null
let open = false
/** 关闭后要把焦点还给谁（打开前的 activeElement） */
let restoreFocus: HTMLElement | null = null

function build(): void {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  zoom = createZoomView({
    // 点空白（不是图本身、也没拖动过）关闭
    onBackgroundClick: () => hideLightbox(),
    labels: {
      hint: `${mod('')}滚轮缩放 · 拖动平移`,
      fit: t('zoomFit'),
      zoomIn: t('zoomIn'),
      zoomOut: t('zoomOut'),
    },
  })

  closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'lightbox-close'
  closeBtn.setAttribute('aria-label', t('lightboxClose'))
  closeBtn.dataset.tip = t('lightboxClose')
  closeBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    hideLightbox()
  })

  overlay.append(zoom.root, closeBtn)
  document.body.appendChild(overlay)
}

export function showInLightbox(src: string, alt: string): void {
  openLightbox((z) => z.show(src, alt))
}

/**
 * 图表（mermaid）放大：内联 SVG 标记，不转 data URL。
 * 转成 <img src="data:image/svg+xml,..."> 看着等价，实则差一层：
 * SVG 没有固有尺寸时 <img> 只能猜（浏览器会退到 300×150 那一档），
 * 内联的 SVG 才能按 viewBox 精确适配，也才谈得上缩放。
 */
export function showSvgInLightbox(markup: string, label: string): void {
  openLightbox((z) => z.showSvg(markup, label))
}

function openLightbox(paint: (z: ZoomView) => void): void {
  build()
  if (!overlay || !zoom || open) return
  open = true
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  paint(zoom)
  overlay.hidden = false
  // 锁滚动：浮层是模态的，背景跟着滚会让人失去位置感
  document.documentElement.classList.add('lightbox-open')
  closeBtn?.focus?.()
}

export function hideLightbox(): void {
  if (!overlay || !open) return
  open = false
  overlay.hidden = true
  zoom?.clear()
  document.documentElement.classList.remove('lightbox-open')
  // 关闭后焦点归还正文，不然键盘用户卡在 hidden 的浮层里
  restoreFocus?.focus?.()
  restoreFocus = null
}

/**
 * 挂载灯箱：建浮层 + 绑定 Esc / 缩放键。
 *
 * 正文图片的点击不再直接开灯箱——点击给的是「针对这一张图」的动作菜单
 * （查看原图 / 编辑源码 / 复制路径 / 图床…），开灯箱降为菜单里的第一项。
 * 菜单在 main.ts 里（要读 session 才能定位到块），这里只提供 showInLightbox。
 */
export function mountLightbox(): () => void {
  build()

  // 捕获阶段：抢在编辑器 / 大纲的 Esc 处理之前关掉浮层
  document.addEventListener('keydown', onKey, true)

  return () => {
    document.removeEventListener('keydown', onKey, true)
    overlay?.remove()
    overlay = null
    zoom = null
    closeBtn = null
    open = false
  }
}

/** 键盘：Esc 关闭，0 复位到适配，+/- 缩放 */
function onKey(e: KeyboardEvent): void {
  if (!open || !zoom) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    hideLightbox()
    return
  }
  if (e.key === '0') {
    e.preventDefault()
    zoom.reset()
    return
  }
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    zoom.zoomBy(1)
    return
  }
  if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    zoom.zoomBy(-1)
  }
}

// 浮层内的右键不弹应用菜单：正在看图，菜单只会挡视线。
// 捕获阶段拦，先于正文的 contextmenu 处理——否则会弹出一份「在下方插入段落」。
document.addEventListener(
  'contextmenu',
  (e) => {
    if (overlay && !overlay.hidden && overlay.contains(e.target as Node)) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true,
)
