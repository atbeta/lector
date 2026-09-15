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

/** 容错解码：不是合法转义就原样返回（正文里的裸 `%` 不该让渲染报错）。 */
function safeDecode(s: string): string {
  if (!s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 由 mdast 的 image url 产出最终 src。 */
export function resolveImageSrc(raw: string): string {
  if (!raw) return ''
  if (/^(file:|blob:)/i.test(raw)) return ''
  if (/^data:/i.test(raw)) return SAFE_DATA_RE.test(raw) ? raw : ''
  if (SAFE_ABS_RE.test(raw)) return raw
  // 先把相对路径解回原文再校验、拼接：markdown 里空格会被编码成 %20（见 imageMarkdown），
  // 带着 %20 拼进绝对路径后，协议层（convertFileSrc / URL）会**再编码一次**变成 %2520，
  // 壳解一次仍是 `%20` 字面量 → 文件找不到、图片不显示。
  // 放在 sanitizeRelative 之前也更安全：`%2e%2e` 这类编码穿越会先还原成 `..` 再被拒。
  const safe = sanitizeRelative(safeDecode(raw))
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
 *
 * 关键：**分隔符要归一成平台原生**。URL 里拼的是 `base + '/' + relative`，
 * base 是原生分隔符（Windows 是 `\`），反解出来就成了 `D:\Code/images/x.png`
 * 这种混的——混的分隔符 explorer 的 `/select,` 会认不出，直接退到默认目录
 * （用户看到"打开了桌面"），复制出来也不是一条能直接用的路径。
 */
export function assetLocalPath(src: string): string | null {
  const win = /^https?:\/\/lector-file\.localhost\/(.*)$/i.exec(src)
  const posix = win ? null : /^lector-file:\/\/localhost\/(.*)$/i.exec(src)
  const encoded = (win ?? posix)?.[1]
  if (encoded == null) return null
  let p = decodeURIComponent(encoded)
  if (win) {
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // /D:\… → D:\…
    p = p.replace(/\//g, '\\')
  } else {
    p = p.replace(/\\/g, '/')
  }
  return p || null
}
