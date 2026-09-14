// KaTeX 数学公式渲染（懒加载，与 mermaid 同一模式）
//
// 模式参考 notefast：
// - 首个数学公式才拉取库与 CSS,避免撑大主包
// - 行内公式用 Pandoc 风格定界 `$...$`,块级用 `$$...$$`
// - output 为已转义 HTML,直接拼进预览 DOM 是安全的
//   （trust 保持默认 false:禁 \href / \html* 等危险命令,
//   错误时 throw 出来由 UI 兜底）
// - 字体走 katex 包内 woff2,Vite 打包自托管,无 CDN 依赖
//
// 与 mermaid.ts 的关键区别:没有 theme 概念(数学公式不跟主题切配色),
// 同一个公式在 light/dark 下都长一样。所以不需要按 theme 缓存。
// 但同公式重复渲染(主题切换导致 reconcile 触发的全量 re-render)
// 仍然走 hash 命中更省。

import type katexApi from 'katex'

type Katex = typeof katexApi

let katexPromise: Promise<Katex> | null = null
const renderCache = new Map<string, string>() // `${display}::${tex}` → html
const CACHE_MAX = 200

function getKatex(): Promise<Katex> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      // CSS 跟 katex JS 同时拉:Vite 抽成同一个 chunk,字体 woff2 也会内联
      import('katex/dist/katex.min.css'),
    ]).then(([m]) => m.default)
  }
  return katexPromise
}

function cacheGet(key: string): string | undefined {
  const v = renderCache.get(key)
  if (v === undefined) return undefined
  renderCache.delete(key)
  renderCache.set(key, v)
  return v
}

function cachePut(key: string, html: string): void {
  if (renderCache.size >= CACHE_MAX) {
    const firstKey = renderCache.keys().next().value
    if (firstKey !== undefined) renderCache.delete(firstKey)
  }
  renderCache.set(key, html)
  void html
}

/**
 * 渲染为 HTML 字符串。语法错误时抛出 Error(message 可供 UI 展示)。
 * displayMode=true 是块级 $$...$$,false 是行内 $...$。
 */
export async function renderMathToHtml(
  tex: string,
  displayMode: boolean,
): Promise<string> {
  const key = `${displayMode ? 'block' : 'inline'}::${tex}`
  const hit = cacheGet(key)
  if (hit !== undefined) return hit

  const katex = await getKatex()
  const html = katex.renderToString(tex.trim(), {
    displayMode,
    throwOnError: true,
    strict: 'warn',
    output: 'html',
  })
  cachePut(key, html)
  return html
}

export function _resetCacheForTests(): void {
  renderCache.clear()
}
