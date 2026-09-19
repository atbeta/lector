// fs 域。拆自 platform.ts（见 platform.ts 文件头说明层与域）。

import {
  detectEnv,
  tauriApi,
  type Env,
  type OpenPayload,
  type ReadResult,
  type SaveResult,
  type TauriApi,
} from './core.ts'


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
        resolve({ path: file.name, content, mtime_ms: Date.now(), byte_len: file.size }),
      )
    })
    input.click()
  })
}


const IMAGE_OPEN_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] as const

/**
 * 选一张或多张图片。壳里走系统文件对话框；浏览器预览退回 `<input type=file>`。
 * 取消选择返回空数组（不是 null）——调用方按「没选」处理即可。
 */
export async function pickImageFiles(multiple = true): Promise<File[]> {
  if (detectEnv() === 'shell') {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({
      multiple,
      directory: false,
      filters: [{ name: 'Images', extensions: [...IMAGE_OPEN_EXTS] }],
    })
    if (!picked) return []
    const paths = typeof picked === 'string' ? [picked] : picked
    const files: File[] = []
    for (const p of paths) {
      const bytes = await readBytes(p)
      const name = p.split(/[\\/]/).pop() ?? 'image'
      files.push(new File([bytes], name))
    }
    return files
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = multiple
    const finish = (files: File[]) => resolve(files)
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    input.click()
  })
}


/** 选一个外部应用（可执行文件）。壳里走系统文件对话框；预览环境返回 null（没有这个能力）。 */
export async function pickAppPath(): Promise<string | null> {
  if (detectEnv() !== 'shell') return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const picked = await open({
    multiple: false,
    directory: false,
    // macOS 的可执行体是 .app 包（壳会解析包内二进制）；Windows 上可执行文件扩展名很杂，
    // 只给 .exe 会选不到 .cmd/.bat 包装器。
    filters: isMac
      ? [{ name: 'Application', extensions: ['app'] }]
      : [{ name: 'Executable', extensions: ['exe', 'cmd', 'bat', 'com'] }],
  })
  if (!picked) return null
  return typeof picked === 'string' ? picked : (picked[0] ?? null)
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


/** 拖入图片的字节读取（read_file 是文本读，图片要原始字节）。 */
export async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  if (detectEnv() !== 'shell') {
    throw new Error('readBytes() 仅壳环境可用')
  }
  const { invoke } = await tauriApi()
  const bytes = await invoke<number[]>('read_file_bytes', { path })
  // 拷进定长缓冲：new Uint8Array(n) 的类型是 Uint8Array<ArrayBuffer>，
  // 才能直接当 BlobPart 传给 File 构造器（invoke 返回的泛型视图不行）。
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
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

