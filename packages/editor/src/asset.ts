// 相对图片资源解析。
// 壳通过 setAssetResolver 注入自定义协议解析（lector-file://，baseDir 沙箱防穿越）。
// 浏览器 dev：回退到 origin（假设资源在 packages/editor/public 下由 Vite 服务）。

type Resolver = (raw: string, mdPath: string | null) => string | null | undefined

let customResolver: Resolver | null = null
let currentMdPath: string | null = null

/** 壳/外部注册自定义资源解析器；回退到 dev 行为。 */
export function setAssetResolver(resolver: Resolver | null): void {
  customResolver = resolver
}

/** 记录当前文档路径（壳打开时设置；浏览器 dev 无真实路径则留空）。 */
export function setCurrentMdPath(path: string | null): void {
  currentMdPath = path
}

/** 拒绝 ../ 向上逃逸；相对路径禁止越出 doc 目录。 */
export function sanitizeRelative(src: string): string | null {
  const segments = src.split('/')
  let depth = 0
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      depth -= 1
      if (depth < 0) return null // 向 doc 目录之上逃逸 → 拒绝
    } else {
      depth += 1
    }
  }
  return src
}

const SAFE_ABS_RE = /^(https?:|lector-file:)/i
const SAFE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i

/** 由 mdast 的 image url 产出最终 src。 */
export function resolveImageSrc(raw: string): string {
  if (!raw) return ''
  if (/^(file:|blob:)/i.test(raw)) return ''
  if (/^data:/i.test(raw)) return SAFE_DATA_RE.test(raw) ? raw : ''
  if (SAFE_ABS_RE.test(raw)) return raw
  const safe = sanitizeRelative(raw)
  if (safe === null) return ''
  if (customResolver) {
    const custom = customResolver(safe, currentMdPath)
    if (custom != null) return custom
  }
  // dev：按 Vite 服务根解析（默认 public/ 或 /images/）
  return new URL(safe, window.location.origin).href
}

/**
 * 从渲染出来的图片 src 反解本地绝对路径（仅壳的 lector-file 协议）。
 *
 * Windows 形如 `http://lector-file.localhost/<encoded>`，其余平台
 * `lector-file://localhost/<encoded>`；Windows 的 path 还带一个前导斜杠
 * （`/D:\…`）。反解不出来（https 外链、data:）返回 null——调用方据此隐藏
 * 「在文件夹中显示 / 复制路径 / 上传图床」这类只对本地文件有意义的动作。
 */
export function assetLocalPath(src: string): string | null {
  const m =
    /^https?:\/\/lector-file\.localhost\/(.*)$/i.exec(src) ??
    /^lector-file:\/\/localhost\/(.*)$/i.exec(src)
  if (!m) return null
  let p = decodeURIComponent(m[1] ?? '')
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p || null
}
