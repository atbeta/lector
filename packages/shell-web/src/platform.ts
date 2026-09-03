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
    return invoke<SaveResult>('write_file', { path, content, mtime_ms, force })
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

export async function bindDocument(path: string): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('bind_document', { path })
}

export async function saveImage(
  docPath: string,
  filename: string,
  bytesBase64: string,
): Promise<{ relative_path: string }> {
  const { invoke } = await tauriApi()
  return invoke<{ relative_path: string }>('save_image', {
    doc_path: docPath,
    filename,
    bytes_base64: bytesBase64,
  })
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
 * Overlay 标题栏：空白处拖窗口，双击缩放。
 */
export function bindTitlebar(dragEl: HTMLElement): void {
  if (detectEnv() !== 'shell') return
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow()
    dragEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('button, a, input, [role="button"]')) return
      if (e.detail === 2) void win.toggleMaximize().catch((err) => console.error('[lector] titlebar zoom', err))
      else void win.startDragging().catch((err) => console.error('[lector] titlebar drag', err))
    })
  })
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
