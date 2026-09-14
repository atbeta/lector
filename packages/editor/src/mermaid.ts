// Mermaid 图表渲染（懒加载，单例缓存）
//
// 模式参考 notefast：首个 mermaid 块才拉取库，避免撑大主包。
//
// 缓存：按 `theme::code` 键值保留最近 MAX_CACHE_ENTRIES 张 SVG。
// - 同主题同源码的重复渲染（如主题来回切换、光标拖动导致 reconcile 重渲）
//   走 O(1) map 命中，绕过 mermaid.render 重计算。
// - 主题切换不需要 invalidate——不同主题是不同 key，同时存在也没问题。
// - LRU：Map 保持插入序，超限丢第一个。代码量与内存都在控。
//   （不依赖 LRU 库是为了零依赖；lector 其他地方如 imageBase64Cache 也是手写 LRU 风格。）

import type mermaidApi from 'mermaid'

type Mermaid = typeof mermaidApi

const MAX_CACHE_ENTRIES = 200

let mermaidPromise: Promise<Mermaid> | null = null
let lastTheme: 'default' | 'dark' | null = null
let renderSeq = 0

const svgCache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const v = svgCache.get(key)
  if (v === undefined) return undefined
  // LRU bump：删了重插，键就跑到末尾
  svgCache.delete(key)
  svgCache.set(key, v)
  return v
}

function cachePut(key: string, svg: string): void {
  if (svgCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = svgCache.keys().next().value
    if (firstKey !== undefined) svgCache.delete(firstKey)
  }
  svgCache.set(key, svg)
}

function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function cssRgbToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `rgb(${raw})` : fallback
}

function applyTheme(mermaid: Mermaid, theme: 'light' | 'dark'): void {
  const next = theme === 'dark' ? 'dark' : 'default'
  if (lastTheme === next) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: next,
    // 画布跟 data-theme 的 --card 对齐，不写死 hex
    themeVariables: {
      background: cssRgbToken('--card', theme === 'dark' ? '#202020' : '#ffffff'),
    },
    // 避免 mermaid 在失败时往 DOM 注入默认错误 UI（我们自己展示）
    suppressErrorRendering: true,
  })
  lastTheme = next
}

/** 生成全局唯一的 mermaid render id（库要求 id 不重复）。 */
export function nextMermaidId(): string {
  renderSeq += 1
  return `lector-mmd-${renderSeq}`
}

/**
 * 将 mermaid 源码渲染为 SVG 字符串。
 * 语法错误时抛出 Error（message 可供 UI 展示）。
 */
export async function renderMermaidSvg(
  code: string,
  theme: 'light' | 'dark',
  id = nextMermaidId(),
): Promise<string> {
  const key = `${theme}::${code}`
  const hit = cacheGet(key)
  if (hit !== undefined) return hit

  const mermaid = await getMermaid()
  applyTheme(mermaid, theme)
  const { svg } = await mermaid.render(id, code.trim())
  cachePut(key, svg)
  return svg
}

/** 测试钩子：清空缓存。生产代码不要调。 */
export function _resetCacheForTests(): void {
  svgCache.clear()
}
