// 平台抽象：壳（Tauri）用 IPC，浏览器（vite dev / 打包预览）退化为 input file / download。
// 契约见 .ai/06-ipc-contract.md。

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

/** 从壳打开+读盘（shell 用 dialog 插件 open() + read_file；browser 走 input file）。 */
export async function pickAndRead(): Promise<OpenPayload & ReadResult | null> {
  if (detectEnv() === 'shell') {
    const { invoke } = await tauriApi()
    const { open } = await import('@tauri-apps/plugin-dialog')
    // 不吞错：取消返回 null；权限/命令错误则抛出，由调用方提示
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    })
    if (!picked) return null
    const res = await invoke<ReadResult>('lector:read_file', { path: picked }).catch((err) => {
      console.error('[lector] read_file failed', err)
      throw new Error('无法读取文件')
    })
    return { path: res.path, content: res.content, mtime_ms: res.mtime_ms }
  }
  // browser 后退：input file
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

export async function read(path: string): Promise<ReadResult> {
  const { invoke } = await tauriApi()
  return invoke<ReadResult>('lector:read_file', { path })
}

export async function save(path: string, content: string, mtime_ms: number): Promise<SaveResult> {
  if (detectEnv() === 'shell') {
    const { invoke } = await tauriApi()
    const res = await invoke<SaveResult>('lector:write_file', { path, content, mtime_ms })
    return res ?? { ok: true }
  }
  // browser 后退：下载
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split('/').pop() ?? 'untitled.md'
  a.click()
  URL.revokeObjectURL(url)
  return { ok: true }
}

export async function dirFor(path: string): Promise<string> {
  const { invoke } = await tauriApi()
  const res = await invoke<{ base_dir: string }>('lector:dir_for', { path })
  return res.base_dir
}

export async function watch(path: string): Promise<void> {
  const { invoke } = await tauriApi()
  await invoke('lector:watch', { path })
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
  return invoke<unknown>('lector:load_settings')
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
  await invoke('lector:save_settings', { settings })
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
 * 相对图片解析器：shell 下把 baseDir + relative 拼接成 lector-file:/// 绝对路径；
 * 否则返回 null（editor 走 dev 回退到 origin）。
 */
export function shellAssetResolver(raw: string, mdPath: string | null): string | null {
  if (detectEnv() !== 'shell') return null
  if (!mdPath) return null
  const baseDir = mdPath.slice(0, Math.max(mdPath.lastIndexOf('/'), mdPath.lastIndexOf('\\')))
  const base = baseDir || mdPath
  return `lector-file:///${base}/${raw.replace(/\\/g, '/')}`
}
