// events 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'


/** 壳事件订阅（lector:*）。浏览器 dev 无壳可听，返回空取消函数。 */
export async function listenShell<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<T>(event, handler)
}


export async function onOpen(handler: (p: OpenPayload) => void): Promise<() => void> {
  if (detectEnv() !== 'shell') return () => {}
  const { listen } = await tauriApi()
  return listen<OpenPayload>('lector:open', (p) => handler(p))
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

