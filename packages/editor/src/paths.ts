// 路径工具：平台无关的取段与判定。
//
// 原先 baseName / dirName / docStem / isAbsolutePath 散在 main.ts 与 loadState.ts，
// 各写一份（改一处漏一处，正是这轮路径 bug 的来源）。集中到这里，一处测试、多处复用。
//
// 只做"取段"和"粗判"，不做规范化或 IO——真正的路径权威在壳侧。

/** 取文件名：Windows 路径是反斜杠，只 split('/') 会把整条路径留在结果里。 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * 目录部分，用于在文件名下面标出处。
 * 分隔符按原路径的形态还原（Windows 上显示 `D:/a/b` 和系统里看到的不是一回事）。
 */
export function dirName(p: string, maxLen = 42): string {
  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(/[\\/]/)
  parts.pop()
  if (parts.length === 0) return ''
  const joined = parts.join(sep)
  return joined.length > maxLen ? `…${joined.slice(-(maxLen - 1))}` : joined
}

/** 文档基名去扩展名（图片目录模板的 {filename} 用）。 */
export function docStem(path: string): string {
  return baseName(path).replace(/\.(md|markdown|txt)$/i, '') || 'untitled'
}

/**
 * 是否是「已经在磁盘上的绝对路径」。
 * 覆盖：POSIX `/…`、Windows 盘符 `C:\…` / `C:/…`、UNC 与 verbatim `\\server\share` / `\\?\D:\…`。
 * 只用来判断"有没有磁盘身份"，不做严格校验（严格校验在壳侧）。
 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}
