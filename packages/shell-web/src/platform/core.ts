// 平台抽象的**共享内核**：环境判定、类型、以及唯一一处动态 import Tauri 的地方。
//
// 为什么单独一个文件：别的域模块都要用 detectEnv / tauriApi / 这几个类型，把它们留在
// 入口文件里，域模块就会反过来 import 入口，形成环。core 不 import 任何同级模块。
//
// 对外接口不变：类型与 detectEnv 由 platform.ts（包的入口）re-export 出去。
export type Env = 'shell' | 'browser'

export interface OpenPayload {
  path: string
}

export interface ReadResult {
  path: string
  content: string
  mtime_ms: number
  /** 磁盘字节数（浏览器预览里是 Blob 大小）。大文件判定用它，不用字符数。 */
  byte_len: number
}

export interface SaveResult {
  ok: boolean
  conflict?: boolean
  current_mtime_ms?: number
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown) => Promise<unknown>
      convertFileSrc?: (filePath: string, protocol: string) => string
    }
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

export async function tauriApi(): Promise<TauriApi> {
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

