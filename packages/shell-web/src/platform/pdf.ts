// pdf 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'
import { save } from './fs.ts'
import { applyUiZoom, currentUiZoom } from './window.ts'

/**
 * 壳里的静默 PDF 导出（PrintToPdf）只接了 WebView2，macOS 没有对等的静默分页 API。
 * 这只决定**走哪条导出路径**：Windows 壳静默出文件，其余（macOS 壳 / 浏览器预览）
 * 退化到系统打印对话框（自带「存为 PDF」）。入口的显隐不再用它——所有平台都有入口。
 */
export function shellSupportsPdfExport(userAgent: string): boolean {
  return !/Mac|iPhone|iPad/i.test(userAgent)
}

/**
 * PDF 存盘对话框。纯原生窗口，不碰页面——调用方先问路径、后做任何视觉变化
 * （翻主题、摊平布局都在用户确认路径之后，0.26.7 教训：翻转在对话框前执行，
 * 用户看到的是「点导出→界面变白」）。浏览器环境返回 null（调用方走 window.print）。
 */
export async function savePdfDialog(defaultName: string): Promise<string | null> {
  if (detectEnv() !== 'shell') return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  const target = await save({
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  return target ?? null
}


/**
 * 对已选定的路径执行导出：主窗口挂 .printing（打印样式，app.css）后交给壳层
 * PrintToPdf。遮罩（.pdf-exporting）盖满**导出全程**（翻主题、等 mermaid、
 * 摊平、捕获）——打印管线会应用 @media print（沙箱探针实验验证：隐藏规则
 * 生效时探针不进 PDF，摘掉规则就进），.pdf-exporting 在 PDF 输出里被
 * display:none，不会进纸。0.26.5 的「整本 spinner」是因为当时没有这条隐藏
 * 规则，不是「捕获=屏幕截图」。主题翻转是调用方的职责（editorChrome 走
 * setThemeMode 正规管道，mermaid 的重画挂在设置通知上）。
 */
export async function exportPdfTo(
  path: string,
  busyTitle?: string,
  prepare?: () => Promise<void>,
): Promise<'saved'> {
  const root = document.documentElement
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
    })
  const overlay = document.createElement('div')
  overlay.className = 'pdf-exporting'
  document.body.appendChild(overlay)
  // 任务栏进度（Windows 图标脉冲 / macOS Dock）：不进 PDF 的反馈通道，
  // 从准备阶段一直亮到捕获结束。
  const { getCurrentWindow, ProgressBarStatus } = await import('@tauri-apps/api/window')
  await getCurrentWindow()
    .setProgressBar({ status: ProgressBarStatus.Indeterminate })
    .catch(() => {})

  try {
    // 准备阶段（翻主题、等 mermaid 重画）在遮罩下进行——用户看到的是
    // 「正在生成」，而不是应用自己变了颜色（0.26.8 教训：翻转在遮罩前，
    // 遮罩又只盖两帧，全程等于没有 loading）。
    await prepare?.()
    // 导出固定按 100% 排：用户可能开着 150% 界面缩放，打印管线带着缩放会改变分页。
    // 复位放在 prepare 之后——prepare 里的 setThemeMode 会走 setSettings → applyVars
    // 再按用户档位缩放一次，放在前面会被它覆盖。
    const prevZoom = currentUiZoom()
    await applyUiZoom(1)
    try {
      root.classList.add('printing')
      await nextFrame()
      // 遮罩不摘，盖满捕获全程（见函数头注释：@media print 让它不进 PDF）。
      // 捕获期反馈：遮罩 spinner + 忙光标 + 窗口标题 + 任务栏进度。
      const prevTitle = document.title
      if (busyTitle) document.title = busyTitle
      root.classList.add('pdf-busy')
      try {
        const { invoke } = await tauriApi()
        await invoke('print_to_pdf', { path })
      } finally {
        root.classList.remove('pdf-busy')
        document.title = prevTitle
      }
    } finally {
      await applyUiZoom(prevZoom)
    }
    return 'saved'
  } finally {
    root.classList.remove('printing')
    overlay.remove()
    await getCurrentWindow().setProgressBar({ status: ProgressBarStatus.None }).catch(() => {})
  }
}


/**
 * 浏览器（vite 预览）退化路径：系统打印对话框。打印样式挂在 html.printing
 * 类上（app.css，不用 @media print——WebView2 按屏幕媒体渲染）。
 */
export async function exportPdf(defaultName: string): Promise<'print'> {
  const root = document.documentElement
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
    })
  // 系统打印同样按 100%：浏览器预览的 CSS zoom 会带着缩放一起进打印预览。
  const prevZoom = currentUiZoom()
  await applyUiZoom(1)
  root.classList.add('printing')
  try {
    await nextFrame()
    window.print()
  } finally {
    root.classList.remove('printing')
    await applyUiZoom(prevZoom)
  }
  return 'print'
}

