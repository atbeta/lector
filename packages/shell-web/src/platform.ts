// 平台抽象：壳（Tauri）走自定义 IPC；浏览器（vite dev）退化为 input file / download。
// 契约见 .ai/06-ipc-contract.md。命令名为 Tauri 函数名（无 lector: 前缀）；事件仍用 lector:。

export type Env = 'shell' | 'browser'

export interface OpenPayload {
  path: string
}

export interface ReadResult {
  path: string
  content: string
  mtime_ms: number
}

export interface SaveResult {
  ok: boolean
  conflict?: boolean
  current_mtime_ms?: number
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
  }
}

export function detectEnv(): Env {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ ? 'shell' : 'browser'
}

export interface TauriApi {
  invoke<T>(cmd: string, args?: unknown): Promise<T>
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
}

let apiPromise: Promise<TauriApi> | null = null

async function tauriApi(): Promise<TauriApi> {
  if (!apiPromise) {
    apiPromise = Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]).then(([core, event]) => ({
      invoke: <T>(cmd: string, args?: unknown) => core.invoke<T>(cmd, args as Record<string, unknown>),
      listen: <T>(name: string, handler: (payload: T) => void) =>
        event.listen<T>(name, (e) => handler(e.payload)),
    }))
  }
  return apiPromise
}

/** 从壳打开+读盘（dialog 插件选路径，内容经 Rust read_file）。 */
export async function pickAndRead(): Promise<(OpenPayload & ReadResult) | null> {
  if (detectEnv() === 'shell') {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    })
    if (!picked) return null
    const path = typeof picked === 'string' ? picked : picked[0]!
    return read(path)
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      void file.text().then((content) =>
        resolve({ path: file.name, content, mtime_ms: Date.now() }),
      )
    })
    input.click()
  })
}

/** 另存为：dialog 插件选目标路径，只返回 path；写盘仍走 write_file。 */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (detectEnv() !== 'shell') return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return save({
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  })
}

export async function read(path: string): Promise<ReadResult> {
  if (detectEnv() !== 'shell') {
    throw new Error('read() 仅壳环境可用')
  }
  const { invoke } = await tauriApi()
  return invoke<ReadResult>('read_file', { path })
}

export async function save(
  path: string,
  content: string,
  mtime_ms: number,
  force = false,
): Promise<SaveResult> {
  if (detectEnv() === 'shell') {
    const { invoke } = await tauriApi()
    // 参数名必须 camelCase：Tauri v2 的命令参数默认按 camelCase 反序列化，
    // 传 mtime_ms 会得到「invalid args `mtimeMs` for command `write_file`」——
    // 报错里说的是 Rust 期望的名字（camelCase），所以看到 mtime_ms 反而以为是对的。
    return invoke<SaveResult>('write_file', { path, content, mtimeMs: mtime_ms, force })
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split('/').pop() ?? 'untitled.md'
  a.click()
  URL.revokeObjectURL(url)
  return { ok: true, current_mtime_ms: Date.now() }
}

/**
 * 用系统默认浏览器打开外链。
 * 壳里走 open_url 命令（壳侧再做一次协议白名单，文档内容不可信）；
 * 浏览器预览用 window.open。
 */
export async function openExternal(url: string): Promise<void> {
  if (detectEnv() !== 'shell') {
    window.open(url, '_blank', 'noopener')
    return
  }
  const { invoke } = await tauriApi()
  await invoke('open_url', { url })
}

/** 应用版本：壳里读 tauri.conf.json 的版本（构建期固化）；浏览器预览没有壳，报 'dev'。 */
export async function appVersion(): Promise<string> {
  if (detectEnv() !== 'shell') return 'dev'
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

export async function dirFor(path: string): Promise<string> {
  const { invoke } = await tauriApi()
  const res = await invoke<{ base_dir: string }>('dir_for', { path })
  return res.base_dir
}

export async function watch(path: string): Promise<void> {
  const { invoke } = await tauriApi()
  await invoke('watch', { path })
}

export async function takePendingOpen(): Promise<string | null> {
  if (detectEnv() !== 'shell') return null
  const { invoke } = await tauriApi()
  return invoke<string | null>('take_pending_open')
}

/**
 * 最近打开（新在前）。
 *
 * 非壳环境返回空表——浏览器预览里没有这份数据。
 * 但留了一个**测试缝**：预览里允许测试注入一份，好让空态列表的渲染也能进常态门。
 * 没有这个缝，这条 UI 路径就只有真机能验（而"只有真机能验"的路径已经丢过好几次）。
 */
export async function recentList(): Promise<string[]> {
  if (detectEnv() !== 'shell') {
    const injected = (globalThis as { __lectorTestRecent?: string[] }).__lectorTestRecent
    return Array.isArray(injected) ? injected : []
  }
  const { invoke } = await tauriApi()
  return invoke<string[]>('recent_list')
}

/**
 * 清空「最近打开」。写入只在壳里发生；预览模式没有这份数据，
 * 就把测试注入的那份清掉，让空态的「清空」按钮在浏览器里也能走完整流程。
 */
export async function recentClear(): Promise<void> {
  if (detectEnv() !== 'shell') {
    ;(globalThis as { __lectorTestRecent?: string[] }).__lectorTestRecent = []
    return
  }
  const { invoke } = await tauriApi()
  await invoke('recent_clear')
}

export async function bindDocument(path: string): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('bind_document', { path })
}

export async function saveImage(
  docPath: string,
  filename: string,
  bytesBase64: string,
  subdir?: string | null,
): Promise<{ relative_path: string; abs_path: string | null }> {
  const { invoke } = await tauriApi()
  return invoke<{ relative_path: string; abs_path: string | null }>('save_image', {
    doc_path: docPath,
    filename,
    bytes_base64: bytesBase64,
    subdir: subdir ?? null,
  })
}

export interface ImageCommandOutcome {
  ok: boolean
  url?: string | null
  error?: string | null
  stdout?: string
  stderr?: string
  exit_code?: number | null
}

/** 执行用户配置的图床上传命令：`executable [args…] <image_path>`。 */
export async function runImageCommand(
  executable: string,
  args: string[],
  imagePath: string,
  timeoutMs: number,
): Promise<ImageCommandOutcome> {
  const { invoke } = await tauriApi()
  return invoke<ImageCommandOutcome>('run_image_command', {
    executable,
    args,
    image_path: imagePath,
    timeout_ms: timeoutMs,
  })
}

/** 设置面板「测试命令」：喂一个内置 1×1 PNG，看它吐不吐 URL。 */
export async function testImageCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ImageCommandOutcome> {
  const { invoke } = await tauriApi()
  return invoke<ImageCommandOutcome>('test_image_command', { executable, args, timeout_ms: timeoutMs })
}

const SETTINGS_LS_KEY = 'lector-settings'

export async function loadSettings(): Promise<unknown> {
  if (detectEnv() !== 'shell') {
    try {
      const raw = localStorage.getItem(SETTINGS_LS_KEY)
      return raw ? (JSON.parse(raw) as unknown) : null
    } catch {
      return null
    }
  }
  const { invoke } = await tauriApi()
  return invoke<unknown>('load_settings')
}

export async function saveSettings(settings: unknown): Promise<void> {
  if (detectEnv() !== 'shell') {
    try {
      localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(settings))
    } catch {
      /* 忽略持久化失败 */
    }
    return
  }
  const { invoke } = await tauriApi()
  await invoke('save_settings', { settings })
}

export async function onOpen(handler: (p: OpenPayload) => void): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<OpenPayload>('lector:open', (p) => handler(p))
}

export async function onSaveRequest(handler: (p: OpenPayload) => void): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<OpenPayload>('lector:save-request', (p) => handler(p))
}

export async function onFileChanged(
  handler: (p: { path: string; mtime_ms: number }) => void,
): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<{ path: string; mtime_ms: number }>('lector:file-changed', (p) => handler(p))
}

/** 原生菜单事件（File/Edit/View → web）。 */
export async function onMenu(handler: (action: string) => void): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<{ action: string }>('lector:menu', (p) => handler(p.action))
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
 * 相对图片解析器：shell 下把 baseDir + relative 拼接成 lector-file:///。
 */
export function shellAssetResolver(raw: string, mdPath: string | null): string | null {
  if (detectEnv() !== 'shell') return null
  if (!mdPath) return null
  const baseDir = mdPath.slice(0, Math.max(mdPath.lastIndexOf('/'), mdPath.lastIndexOf('\\')))
  const base = baseDir || mdPath
  return `lector-file:///${base}/${raw.replace(/\\/g, '/')}`
}
