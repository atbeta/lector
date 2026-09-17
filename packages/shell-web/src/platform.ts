import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './platform/core.ts'

// 平台抽象：壳（Tauri）走自定义 IPC；浏览器（vite dev）退化为 input file / download。
// 契约见 .ai/06-ipc-contract.md。命令名为 Tauri 函数名（无 lector: 前缀）；事件仍用 lector:。
//
// 分层：共享内核（类型 / detectEnv / tauriApi）在 ./platform/core.ts，这里 re-export，
// 因此包的对外接口与拆分前完全一致。本文件按域继续往下拆，其余域逐个搬到 ./platform/<域>.ts。

export * from './platform/core.ts'
export * from './platform/fs.ts'
export * from './platform/pdf.ts'
export * from './platform/window.ts'
export * from './platform/events.ts'
export * from './platform/system.ts'
export * from './platform/images.ts'
export * from './platform/settings.ts'
