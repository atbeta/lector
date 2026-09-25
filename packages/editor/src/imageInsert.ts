import type { ImagePipeline } from '@lector/core'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

// 内容哈希去重缓存：粘贴同一张图多次只占一份磁盘。
// 跨会话的 map 会重置——未持久化；设计上有意以此为限：手动管理文件的用户
// 不会惊讶被「跨重启合并」。想要跨会话的下一轮再加 image manifest。
const contentHashCache = new Map<string, string>() // dedup key → 写进正文的 src

/**
 * 去重键 = 内容哈希 + 当前图片管线。
 *
 * 只看内容会把「换个写法」当成同一件事：先只复制、后来改成自动上传，
 * 同一张图第二次粘贴会直接复用上次的相对路径，命令根本不跑。
 * 反过来，同一张图在同一管线下粘 N 次只跑一次命令/写一份文件。
 */
export function imageDedupKey(hash: string, plan: ImagePipeline): string {
  return `${hash}|${plan.upload}|${plan.copy ? plan.copyDir : '-'}`
}

/** SHA-256 前 6 字节（12 hex 字符），用作去重 key。够用、不算长。 */
export async function imageContentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let s = ''
  for (let i = 0; i < 6; i++) s += view[i]!.toString(16).padStart(2, '0')
  return s
}

export function findDedupImage(key: string): string | null {
  return contentHashCache.get(key) ?? null
}

export function rememberImage(key: string, src: string): void {
  contentHashCache.set(key, src)
}

export function _resetDedupForTests(): void {
  contentHashCache.clear()
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export function isImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_EXT, mime.toLowerCase())
}

export function extFromMime(mime: string): string | null {
  return MIME_EXT[mime.toLowerCase()] ?? null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区 YYYYMMDD-HHMMSS。 */
export function formatStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function pastedFileName(d: Date, mime: string): string | null {
  const ext = extFromMime(mime)
  if (!ext) return null
  return `pasted-${formatStamp(d)}.${ext}`
}

export function sidecarRelPath(fileName: string): string {
  return `images/${fileName}`
}

/**
 * 展开图片目录模板为「相对文档目录」的一块路径（单段，无分隔符）。
 * 支持 `{filename}`（文档基名去扩展名）；其余原样保留。
 * 模板非法（空/含路径分隔/穿越段/纯 `{filename}` 展开后为空）→ null，调用方回退 images/。
 */
export function expandImageDir(
  template: string,
  mdStem: string | null,
): string | null {
  const t = template?.trim() ?? ''
  if (t === '' || t.includes('..') || /[\\/]/.test(t)) return null
  const expanded = t
    .replace(/\{filename\}/g, mdStem?.trim() ? mdStem.trim() : 'untitled')
    .replace(/[^ \w.\u4e00-\u9fff-]+/gu, '')
  if (expanded.trim() === '' || expanded.includes('..') || /[\\/]/.test(expanded)) return null
  return expanded
}

/**
 * 引号感知地拆分用户填的「完整命令」：`picgo upload` 或 `"D:\My Tools\x.exe" -d`。
 * 返回可执行名 + 前置参数（图片路径由调用方追加在最后）。
 */
export function splitUploadCommand(input: string): { command: string; preArgs: string[] } {
  const trimmed = input.trim()
  if (!trimmed) return { command: '', preArgs: [] }
  const parts: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of trimmed) {
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (ch === ' ' && !inQuote) {
      if (cur) {
        parts.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) parts.push(cur)
  if (parts.length === 0) return { command: '', preArgs: [] }
  return { command: parts[0] as string, preArgs: parts.slice(1) }
}

/**
 * 上传中占位的伪协议：粘贴/拖入后 imageController 先落 `![](lector-upload://<token>)`，
 * 异步管线（落盘 + 可能上传）跑完再把 token 文本替换成最终 src。
 * 渲染层（mdastHtml）认这个前缀画占位框；它永远不会成为真实的图片地址。
 */
export const IMAGE_PENDING_SCHEME = 'lector-upload://'

export function imageMarkdown(relPath: string, alt = ''): string {
  // 目录模板可能含空格（`My Notes.assets`），CommonMark 的 []() 目标遇空格会错位，
  // 这里统一把空格百分号编码（协议侧会解码回去），中文/其他字符原样保留。
  return `![${alt}](${relPath.replace(/ /g, '%20')})`
}

/**
 * 插图要用的四个外部动作。真实实现走壳（save_image / stage_image / run_image_command /
 * discard_staged_image），测试里换成假的——这样「哪一种组合走哪条路」能直接断言，
 * 不必搭一台浏览器、更不必真去传一次图。
 */
export interface ImageEffects {
  /** 落一份本地副本，返回正斜杠相对路径与绝对路径（上传命令吃后者）。 */
  copy(name: string, base64: string): Promise<{ relative_path: string; abs_path: string | null }>
  /** 暂存成系统临时文件；壳里没有这条命令（旧版本）时给 null。 */
  stage(name: string, base64: string): Promise<string | null>
  /** 跑上传命令：成功给 URL，失败给原因。 */
  upload(absPath: string | null): Promise<{ url: string | null; error: string | null }>
  /** 删掉暂存文件。 */
  discard(absPath: string): Promise<void>
}

export interface ImageIngestResult {
  /** 写进正文的 src：本地相对路径，或图床 URL。 */
  src: string
  /** 上传成功了吗。 */
  uploaded: boolean
  /** 这次之后磁盘上有没有这份图的本地副本。 */
  copied: boolean
  /** 上传失败的原因（成功或没走上传时为 null）。 */
  error: string | null
}

/**
 * 「要不要复制 × 要不要上传」合成的四种走法，只在这里实现一次。
 *
 * 调用方（imageController）负责拿字节、查去重、把结果写进正文与出提示；
 * 这里只回答一件事：**这次插入到底做了什么**。
 *
 * 一条红线：上传失败也绝不丢图——留副本的走法退回那份副本，不留副本的走法
 * 补落一份副本（用户选了「不复制」，但一次粘贴白做比多一个文件更糟）。
 */
export async function runImageIngest(
  plan: ImagePipeline,
  name: string,
  base64: string,
  fx: ImageEffects,
): Promise<ImageIngestResult> {
  // 不上传 / 只手动上传：先把副本放好，正文写相对路径（手动传以后再从图片菜单走）。
  if (plan.upload !== 'auto') {
    const local = await fx.copy(name, base64)
    return { src: local.relative_path, uploaded: false, copied: true, error: null }
  }

  // 复制 + 自动上传：本地副本永远在，传成了用 URL，传败了用副本。
  if (plan.copy) {
    const local = await fx.copy(name, base64)
    const up = await fx.upload(local.abs_path)
    return { src: up.url ?? local.relative_path, uploaded: up.url !== null, copied: true, error: up.error }
  }

  // 不复制 + 自动上传：临时文件转一圈，正文只留图床地址。
  const staged = await fx.stage(name, base64)
  if (staged) {
    const up = await fx.upload(staged)
    await fx.discard(staged)
    if (up.url) return { src: up.url, uploaded: true, copied: false, error: null }
    const fallback = await fx.copy(name, base64)
    return { src: fallback.relative_path, uploaded: false, copied: true, error: up.error }
  }

  // 壳里还没有 stage_image（旧版本）：退回「复制 + 上传」，行为一致、只是多留一份副本。
  const local = await fx.copy(name, base64)
  const up = await fx.upload(local.abs_path)
  return { src: up.url ?? local.relative_path, uploaded: up.url !== null, copied: true, error: up.error }
}

export function insertAt(text: string, offset: number, chunk: string): { text: string; caret: number } {
  const o = Math.max(0, Math.min(text.length, offset))
  return { text: text.slice(0, o) + chunk + text.slice(o), caret: o + chunk.length }
}

/** 拖入文件只留 basename；空格/非法字符改成 -；拒绝非图片扩展与逃逸。
 *  与旧版只认 `[A-Za-z0-9._-]` 的差异：保留中文/全角字符——生活里拖进来最多的
 *  就是「截图_2026.png」这种名字，硬把中文全剔掉会得到 `pasted-<时间戳>.png`。 */
export function safeDropName(original: string): string | null {
  const base = original.replace(/\\/g, '/').split('/').pop() ?? ''
  const trimmed = base.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return null
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = trimmed.slice(dot + 1).toLowerCase()
  if (!IMAGE_EXT.has(ext)) return null
  // 保留：拉丁、数字、CJK 等非 ASCII Letter、`-._`；其余（空格、符号）→ `-`。
  const stem = trimmed
    .slice(0, dot)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (!stem) return null
  return `${stem}.${ext}`
}

export function fileToBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk))
  }
  return btoa(bin)
}
