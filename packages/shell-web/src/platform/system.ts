// system 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

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


/** 用系统默认应用打开文件（联动其他编辑器；壳侧校验必须是绝对路径）。 */
export async function openWithDefault(path: string): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('open_with_default', { path })
}

/** 用设置里指定的外部应用打开文件（可执行文件 + 参数，文件路径由壳追加在最后）。 */
export async function openWithApp(path: string, app: string, args: string[]): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('open_with_app', { path, app, args })
}


/** 在系统文件管理器中显示文件。 */
export async function revealInFolder(path: string): Promise<void> {
  if (detectEnv() !== 'shell') return
  const { invoke } = await tauriApi()
  await invoke('reveal_in_folder', { path })
}


/**
 * 打开文档里的本地链接：同一文件已打开就聚焦那个窗口，否则开一个新窗口。
 *
 * Web 层只传「当前文档路径 + 链接原文」——相对路径怎么解析、允不允许，
 * **全在壳侧**（paths.ts 顶上那句「真正的路径权威在壳侧」就是这条）。
 * 链接是文档内容，属不可信输入，所以判定必须待在能看清真实文件系统的那一层。
 * 失败原因是壳给的短码（missing / not_text / scheme / bad_href），由调用方翻成人话。
 */
export async function openLink(docPath: string, href: string): Promise<void> {
  if (detectEnv() !== 'shell') throw new Error('openLink() 仅壳环境可用')
  const { invoke } = await tauriApi()
  // 参数名必须 camelCase：Tauri v2 按 camelCase 反序列化命令参数（同 save_image 的 docPath）
  await invoke('open_link', { docPath, href })
}


/**
 * 读系统剪贴板（右键菜单的「粘贴」用）。
 *
 * 壳里走自定义命令 read_clipboard。**不能直接用 navigator.clipboard.readText()**：
 * Tauri v2 把剪贴板挪进了独立插件，壳没把它开放给 web 层，于是在 macOS 的 WKWebView 里
 * 这个调用一律被拒——菜单里那一项以前永远失败，只能弹「请用 ⌘V」。
 * 浏览器预览（vite dev）里没有壳，退回 navigator.clipboard，那条路本来就是通的。
 *
 * 注意它**只读**：复制/剪切仍走 navigator.clipboard.writeText / execCommand，
 * 那两条路在 webview 里一直好用，不需要多开一条能力。
 */
export async function readClipboard(): Promise<string> {
  if (detectEnv() !== 'shell') return navigator.clipboard.readText()
  const { invoke } = await tauriApi()
  return invoke<string>('read_clipboard')
}


/** 应用版本：壳里读 tauri.conf.json 的版本（构建期固化）；浏览器预览没有壳，报 'dev'。 */
export async function appVersion(): Promise<string> {
  if (detectEnv() !== 'shell') return 'dev'
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

