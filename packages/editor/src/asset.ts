// 相对图片资源解析。
// 壳通过 setAssetResolver 注入自定义协议解析（lector-file://，baseDir 沙箱防穿越）。
// 浏览器 dev：回退到 origin（假设资源在 packages/editor/public 下由 Vite 服务）。

type Resolver = (raw: string, mdPath: string | null) => string

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

const ABSOLUTE_RE = /^(https?:|data:|file:|lector-file:|blob:)/i

/** 由 mdast 的 image url 产出最终 src。 */
export function resolveImageSrc(raw: string): string {
  if (!raw) return ''
  if (ABSOLUTE_RE.test(raw)) return raw
  const safe = sanitizeRelative(raw)
  if (safe === null) return ''
  if (customResolver) return customResolver(safe, currentMdPath)
  // dev：按 Vite 服务根解析（默认 public/ 或 /images/）
  return new URL(safe, window.location.origin).href
}
