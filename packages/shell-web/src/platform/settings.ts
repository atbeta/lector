// settings 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'


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

