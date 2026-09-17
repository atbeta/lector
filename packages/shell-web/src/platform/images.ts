// images 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'


export async function saveImage(
  docPath: string,
  filename: string,
  bytesBase64: string,
  subdir?: string | null,
): Promise<{ relative_path: string; abs_path: string | null }> {
  const { invoke } = await tauriApi()
  // 参数名必须 camelCase：Tauri v2 按 camelCase 反序列化命令参数，
  // 传 doc_path 会得到「invalid args `docPath` for command `save_image`」
  // （报错里说的是 Rust 期望的名字，所以看到 doc_path 反而以为是对的）。
  return invoke<{ relative_path: string; abs_path: string | null }>('save_image', {
    docPath,
    filename,
    bytesBase64,
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
    imagePath,
    timeoutMs,
  })
}


/** 设置面板「测试命令」：喂一个内置 1×1 PNG，看它吐不吐 URL。 */
export async function testImageCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ImageCommandOutcome> {
  const { invoke } = await tauriApi()
  return invoke<ImageCommandOutcome>('test_image_command', { executable, args, timeoutMs })
}


/**
 * 相对图片解析器：shell 下把 baseDir + relative 拼成自定义协议的 URL。
 *
 * URL 形态必须按平台来：Windows / Android 是 `http://<scheme>.localhost/<encoded>`，
 * 其余平台是 `<scheme>://localhost/<encoded>`。手写 `lector-file:///…` 在 Windows 上
 * 不会被 WebView2 拦截（它只认 `http://lector-file.localhost`），图片会整片加载不出来。
 * `convertFileSrc` 由壳注入并按平台拼好、还会 percent-encode，交给它最稳。
 */
export function shellAssetResolver(raw: string, mdPath: string | null): string | null {
  if (detectEnv() !== 'shell') return null
  if (!mdPath) return null
  const slash = Math.max(mdPath.lastIndexOf('/'), mdPath.lastIndexOf('\\'))
  // 没有目录部分（未命名占位名）→ 交给调用方走默认兜底，别拿文件名当目录拼
  if (slash < 0) return null
  const base = mdPath.slice(0, slash) || mdPath.slice(0, 1)
  const abs = `${base}/${raw}`
  const convert = window.__TAURI_INTERNALS__?.convertFileSrc
  if (typeof convert === 'function') return convert(abs, 'lector-file')
  // 兜底：壳里理论上一定拿得到 convertFileSrc
  return `lector-file://localhost/${encodeURIComponent(abs)}`
}

