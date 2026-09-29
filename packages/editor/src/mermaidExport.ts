// 把一张 Mermaid 图带走：复制成图片，或另存为 SVG / PNG / JPEG。
//
// 屏上那张图会被栏宽裁切，截图只能拍到窗口里的一块。这里按 SVG 自己的尺寸出整张。
// 栅格化不拿屏上的 SVG：流程图文字在 foreignObject 里，画进画布会丢字。
// 导出另渲一版纯文字，并由 mermaid.ts 的队列保证不和屏上的渲染抢全局配置。
//
// 栅格化的两条坑，都只影响 PNG / JPEG / 复制（SVG 只写文本，不栅格化）：
//   1. 壳的 CSP img-src 原先不放行 blob:，`<img src=blob:…>` 一律被拦 → 所有图都失败。
//      现在 CSP 也放行 blob: 兜底，但栅格化统一走 data URL（svgDataUrl），不依赖 CSP。
//   2. 少数图（如 journey）不认 htmlLabels，硬把标签塞进 foreignObject；这种 SVG
//      画进画布会把 canvas 标成 tainted，toBlob/toDataURL 直接抛错。
//      mermaid 给它们配了 <switch> + <text> 回退，导出前摘掉 foreignObject 即可
//      （stripForeignObjects）。

import { saveBinaryFile, writeClipboardImage } from '@lector/shell-web'
import { hideContextMenu, isContextMenuOpenFor, showContextMenu } from './contextMenu.ts'
import { showToast } from './feedback.ts'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { mermaidExportFontStack, renderMermaidExportSvg } from './mermaid.ts'

export const MAX_EXPORT_EDGE = 8192

export type MermaidExportKind = 'clipboard' | 'svg' | 'png' | 'jpeg'

export function svgHasForeignObject(svg: string): boolean {
  return /<foreignObject[\s>/]/i.test(svg)
}

/**
 * 摘掉导出 SVG 里的 foreignObject。
 *
 * foreignObject 里的 HTML 会污染 canvas（drawImage 后 toBlob/toDataURL 抛 tainted），
 * journey 这类不认 htmlLabels 的图就卡在这里。mermaid 把它们包在
 * `<switch><foreignObject/><text/></switch>` 里，foreignObject 一摘，switch 自动落到
 * 同位置同字号的 `<text>` 上，字形与布局不变。自闭合的 foreignObject 一并处理。
 */
export function stripForeignObjects(svg: string): string {
  return svg
    .replace(/<foreignObject\b[^<>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
}

/** 读 viewBox（优先）或 width/height。百分比宽度不算尺寸。 */
export function readSvgSize(svg: string): { width: number; height: number } | null {
  const vb = svg.match(/viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/)
  if (vb) {
    const width = Number(vb[1])
    const height = Number(vb[2])
    if (width > 0 && height > 0) return { width, height }
  }
  const width = Number(svg.match(/\bwidth="([\d.]+)"/)?.[1])
  const height = Number(svg.match(/\bheight="([\d.]+)"/)?.[1])
  if (width > 0 && height > 0) return { width, height }
  return null
}

/** 2 倍清晰度，长边不超过 MAX_EXPORT_EDGE。图比上限还大时整图缩小，不裁切。 */
export function exportPixelSize(
  width: number,
  height: number,
  scale = 2,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 }
  const long = Math.max(width, height)
  const factor = Math.min(scale, MAX_EXPORT_EDGE / long)
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  }
}

/** 写成可脱离页面打开的 SVG：像素宽高、去掉 max-width，并写上带中文的字体。 */
export function prepareExportSvg(svg: string): string {
  const size = readSvgSize(svg)
  let out = stripForeignObjects(svg)
  if (size) {
    out = out.replace(/<svg\b([^>]*)>/, (_match, attrs: string) => {
      let next = attrs
      if (/\bwidth="/.test(next)) next = next.replace(/\bwidth="[^"]*"/, `width="${size.width}"`)
      else next += ` width="${size.width}"`
      if (/\bheight="/.test(next)) next = next.replace(/\bheight="[^"]*"/, `height="${size.height}"`)
      else next += ` height="${size.height}"`
      next = next.replace(/\sstyle="[^"]*"/, '')
      return `<svg${next}>`
    })
  }
  if (out.includes('lector-export-font')) return out
  const font = mermaidExportFontStack('Inter, ui-sans-serif, system-ui')
  const style = `<style data-lector="export-font">/* lector-export-font */ text,tspan,span,p,div{font-family:${font} !important}</style>`
  return out.replace(/<svg\b[^>]*>/, (open) => `${open}${style}`)
}

function paperColor(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--card').trim()
  return raw ? `rgb(${raw})` : '#ffffff'
}

/**
 * 把 SVG 文本变成 `<img>` 能加载的 data URL。
 *
 * 用 data URL 而不是 blob URL：不受壳的 CSP 约束，浏览器预览与壳里行为一致。
 * （tauri.conf.json 的 img-src 现已放行 blob: 作兜底，但这里不依赖它。）
 */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

export async function rasterizeSvg(
  svg: string,
  mime: 'image/png' | 'image/jpeg',
  background: string,
): Promise<Blob> {
  const prepared = prepareExportSvg(svg)
  // prepareExportSvg 已摘掉 foreignObject；万一还剩（没有 <text> 回退的图），
  // 画进画布会污染 canvas，这里提前报出来，别等 toBlob 抛一个看不懂的错。
  if (svgHasForeignObject(prepared)) throw new Error('foreignObject')
  const size = readSvgSize(prepared)
  if (!size) throw new Error('svg size')
  const px = exportPixelSize(size.width, size.height)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('svg image'))
    img.src = svgDataUrl(prepared)
  })
  const canvas = document.createElement('canvas')
  canvas.width = px.width
  canvas.height = px.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  if (mime === 'image/jpeg') {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, px.width, px.height)
  }
  ctx.drawImage(img, 0, 0, px.width, px.height)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mime, mime === 'image/jpeg' ? 0.92 : undefined)
  })
  if (!blob) throw new Error('encode')
  return blob
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read blob'))
    reader.readAsDataURL(blob)
  })
}

async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(await blob.arrayBuffer())
  return out
}

/** 复制进剪贴板，或弹出保存对话框。取消保存返回 cancelled，不提示失败。 */
export async function exportMermaidDiagram(
  kind: MermaidExportKind,
  code: string,
  columnWidth?: number,
): Promise<'copied' | 'saved' | 'cancelled'> {
  const source = code.trim()
  if (!source) throw new Error('empty diagram')
  const theme: 'light' | 'dark' =
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  const svg = await renderMermaidExportSvg(source, theme, columnWidth)
  if (kind === 'svg') {
    const prepared = prepareExportSvg(svg)
    const ok = await saveBinaryFile('diagram.svg', new TextEncoder().encode(prepared), [
      { name: 'SVG', extensions: ['svg'] },
    ])
    return ok ? 'saved' : 'cancelled'
  }
  const mime = kind === 'jpeg' ? 'image/jpeg' : 'image/png'
  const blob = await rasterizeSvg(svg, mime, paperColor())
  if (kind === 'clipboard') {
    await writeClipboardImage(await blobToDataUrl(blob))
    return 'copied'
  }
  const ext = kind === 'jpeg' ? 'jpg' : 'png'
  const label = kind === 'jpeg' ? 'JPEG' : 'PNG'
  const ok = await saveBinaryFile(`diagram.${ext}`, await bytesOf(blob), [
    { name: label, extensions: [ext] },
  ])
  return ok ? 'saved' : 'cancelled'
}

/** 图卡 / 实时预览共用的导出按钮。菜单：复制为图片，另存为 SVG / PNG / JPEG。 */
export function mountMermaidExportButton(
  getCode: () => string,
  getWidth: () => number | undefined,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mermaid-export'
  btn.innerHTML = iconSvg('fileOutput', 14)
  btn.setAttribute('aria-label', t('mermaidExport'))
  btn.dataset.tip = t('mermaidExport')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (btn.disabled) return
    if (isContextMenuOpenFor(btn)) {
      hideContextMenu()
      return
    }
    const r = btn.getBoundingClientRect()
    const run = (kind: MermaidExportKind) => {
      void (async () => {
        btn.disabled = true
        try {
          const status = await exportMermaidDiagram(kind, getCode(), getWidth())
          if (status === 'copied') showToast(t('menuCopied'))
          else if (status === 'saved') showToast(t('mermaidSaved'))
        } catch (err) {
          console.error('[lector] mermaid export', err)
          showToast(t('mermaidExportFailed'))
        } finally {
          btn.disabled = false
        }
      })()
    }
    showContextMenu(
      [
        { label: t('mermaidCopyImage'), run: () => run('clipboard') },
        { separatorBefore: true, label: t('mermaidSaveSvg'), run: () => run('svg') },
        { label: t('mermaidSavePng'), run: () => run('png') },
        { label: t('mermaidSaveJpeg'), run: () => run('jpeg') },
      ],
      Math.round(r.left),
      Math.round(r.bottom + 6),
      btn,
    )
  })
  return btn
}
