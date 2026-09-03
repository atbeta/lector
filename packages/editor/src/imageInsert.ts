const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

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

export function imageMarkdown(relPath: string, alt = ''): string {
  return `![${alt}](${relPath})`
}

export function insertAt(text: string, offset: number, chunk: string): { text: string; caret: number } {
  const o = Math.max(0, Math.min(text.length, offset))
  return { text: text.slice(0, o) + chunk + text.slice(o), caret: o + chunk.length }
}

/** 拖入文件只留 basename；空格改成 -；拒绝非图片扩展与逃逸。 */
export function safeDropName(original: string): string | null {
  const base = original.replace(/\\/g, '/').split('/').pop() ?? ''
  const trimmed = base.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return null
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const stem = trimmed.slice(0, dot).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const ext = trimmed.slice(dot + 1).toLowerCase()
  if (!stem || !IMAGE_EXT.has(ext)) return null
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
