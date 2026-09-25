// window 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'


/**
 * 上一次应用过的界面缩放（1 = 100%）。
 * 壳侧的原生 zoom 没有 getter；PDF 导出前后要临时复位、之后再还原，所以在这层记住它。
 */
let appliedZoom = 1
let nativeZoomApplied = false

export function currentUiZoom(): number {
  return appliedZoom
}

/**
 * 应用界面缩放。
 *
 * 壳里走 WebView 的**原生 zoom**（壳命令 `set_zoom`）：它改的是布局视口，`100vh`
 * 骨架会跟着窗口重新排版（与浏览器 Ctrl+± 同一套）。**不能**把 CSS `zoom` 打在
 * `<html>` 上——那只缩放绘制、不改布局视口：`100vh` 骨架会被放大到窗口外，而且
 * `getBoundingClientRect()` 与 CSS 长度不再同一坐标系，浮层定位（外观面板等）会跳。
 *
 * 浏览器预览没有原生 zoom，**直接不缩放**（不再退回 CSS zoom，理由同上）；界面缩放
 * 是壳的能力，浏览器里只保留设置链路。
 */
export async function applyUiZoom(scale: number): Promise<void> {
  if (detectEnv() !== 'shell') {
    appliedZoom = scale
    return
  }
  if (scale === appliedZoom && nativeZoomApplied) return
  appliedZoom = scale
  const { invoke } = await tauriApi()
  try {
    await invoke('set_zoom', { scale })
    nativeZoomApplied = true
    await syncMacTitlebarToLights()
  } catch (err) {
    console.error('[lector] set_zoom', err)
  }
}

/** 量原生红绿灯中心，写给 CSS。灯不动，顶栏按钮去就位。 */
async function syncMacTitlebarToLights(): Promise<void> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua) || !/Mac/i.test(ua)) return
  try {
    const { invoke } = await tauriApi()
    const center = await invoke<number>('macos_traffic_light_center')
    if (!Number.isFinite(center)) return
    document.documentElement.style.setProperty(
      '--traffic-light-center',
      `${center / appliedZoom}px`,
    )
  } catch {
    /* 灯组还没建好，或不是 mac 壳 */
  }
}


/**
 * 关闭当前窗口（Ctrl/⌘W 在无文档时的语义 = Windows 上退出应用）。
 * 走 onCloseRequested 的脏检查路径——有未保存改动时 Web 层的确认弹窗仍然生效。
 * 浏览器预览没有窗口可关，空实现。
 */
export async function closeWindow(): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().close().catch((err) => console.error('[lector] close', err))
}


/**
 * 通知壳：本窗口的 WebView 已就绪。壳借此把 snap 覆盖层重新提到 WebView2 之上
 * （WebView2 首帧/可见性切换时会再置顶一次，晚于建窗时的 install——竞态导致
 * 只有部分窗口悬停最大化能弹 Snap 浮窗）。浏览器预览无壳，空操作。
 */
export async function notifyWebviewReady(): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('webview_ready').catch((err) => console.error('[lector] webview_ready', err))
}


/**
 * 同步原生窗口标题与脏状态到壳（标题 + 脏一次更新，避免两次 IPC 之间闪旧值）。
 *
 * - macOS：壳把脏状态画在关闭按钮的原生红点上（NSWindow documentEdited），标题保持干净；
 * - Windows / Linux：没有 document-edited 概念，壳在原生标题前加 "● "（任务栏 / Alt-Tab 可见）。
 * document.title 不在这里写——它由 editor 侧（windowTitle.ts）连同 "— Lector" 后缀一起算。
 * 浏览器 dev 没有原生窗口，整体 no-op（document.title 那半在调用方已经写了）。
 */
export async function syncNativeWindowState(title: string, dirty: boolean): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('set_window_state', { title, dirty }).catch((err) =>
    console.error('[lector] set_window_state', err),
  )
}


/**
 * 无标题栏：在 titlebar 空白处按下即拖动窗口。
 *
 * 双击缩放不在这里做——窗口控件的接管方（editor/chrome.ts）统一处理，
 * 两处都监听会让一次双击触发两次 toggle，窗口原地闪一下。
 */
export function bindTitlebar(dragEl: HTMLElement): void {
  if (detectEnv() !== 'shell') return
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    dragEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('button, a, input, [role="button"]')) return
      void win.startDragging().catch((err) => console.error('[lector] titlebar drag', err))
    })
  })
}


/**
 * 无标题栏窗口：把自绘控件的三个动作接到壳的真实窗口命令上。
 *
 * Windows / Linux 走 decorations:false，最小化、最大化、关闭必须是真窗口操作，
 * 不能只改 DOM。浏览器预览下拿不到壳，回调保持空实现，调用方据此渲染
 * 「在位但不可用」的假控件，保证没有壳的环境也能调版式。
 *
 * 返回清理函数（移除监听的 Promise 落地前调用也安全）。
 */
export function bindWindowControls(opts: {
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
  /** 最大化状态变化回调，用于在「最大化 / 还原」图标之间切换 */
  onMaximizedChange?: (maximized: boolean) => void
}): () => void {
  if (detectEnv() !== 'shell') return () => {}
  let disposed = false
  let unlisten: (() => void) | null = null
  void import('@tauri-apps/api/window')
    .then(async ({ getCurrentWindow }) => {
      if (disposed) return
      const win = getCurrentWindow()
      opts.onMinimize = () => void win.minimize().catch((e) => console.error('[lector] minimize', e))
      opts.onToggleMaximize = () =>
        void win.toggleMaximize().catch((e) => console.error('[lector] maximize', e))
      opts.onClose = () => void win.close().catch((e) => console.error('[lector] close', e))
      const sync = async () => {
        try {
          opts.onMaximizedChange?.(await win.isMaximized())
        } catch {
          /* 窗口已销毁 */
        }
      }
      await sync()
      if (disposed) return
      unlisten = await win.onResized(() => void sync())
    })
    .catch((err) => console.error('[lector] window controls', err))
  return () => {
    disposed = true
    unlisten?.()
  }
}


/**
 * 最大化按钮的悬停进出。
 *
 * Windows 无边框窗口上，Snap Layouts 覆盖层（原生子窗口）接管了那颗按钮的鼠标，
 * webview 收不到 :hover，按钮会「悬停无反馈」。壳在原生侧把进入/离开转成这个事件，
 * 前端据此给按钮补样式。非壳环境是 no-op。
 */
export async function onMaximizeHover(
  handler: (hovering: boolean) => void,
): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<boolean>('lector:win-max-hover', (hovering) => handler(hovering))
}


/**
 * 窗口即将关闭时的拦截。回调返回 'close' 才真正关，'stay' 则留下。
 *
 * 必须用 Tauri 的 `onCloseRequested`，**不能用 `window.beforeunload`**：
 * Tauri 的关闭走原生侧（窗口 X、自绘关闭键、macOS 的 ⌘W 都到这里），
 * WebView2 下 beforeunload 拦不住，脏文档会被静默关掉——这正是之前的问题。
 *
 * 具体要不要弹确认、脏不脏，只有 Web 层知道，所以决策交给回调。
 * 确认关闭时用 `destroy()`：**不能在 CloseRequested 处理器里再调 `close()`**——
 * 窗口已处在"已请求关闭"状态，那次 close 会被吞掉，表现为点「放弃改动」后既不关、
 * 之后点关闭也没反应。destroy 不再走 CloseRequested，直接销毁。
 */
export async function onCloseRequest(
  handler: () => Promise<'close' | 'stay'>,
): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  const unlisten = await win.onCloseRequested(async (event) => {
    event.preventDefault()
    if ((await handler()) === 'close') {
      await win.destroy()
    }
  })
  return unlisten
}

