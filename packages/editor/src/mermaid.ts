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
let lastThemeKey: string | null = null
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

/** 读取原始 CSS 变量值（不包 rgb()），用于字体族这类非颜色 token。 */
function cssRawToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw || fallback
}

/**
 * mermaid 的调色板绑到我们的 token：图里的纸、墨、线全部跟主题走。
 *
 * 只绑 background 是不够的——实测过：浅色下画出来是「白纸上一张淡紫图」
 * （mermaid 自带 mediumpurple 描边 #9370DB、#333 文字），和界面的靛蓝中性墨完全不搭。
 * 背景跟了不等于整套配色跟了。
 *
 * 映射规则刻意克制：节点底用中性 --muted、描边用 --primary（靛蓝）、文字用 --foreground、
 * 连线用 --muted-foreground。这样图的语言和界面一致（中性面 + 靛蓝强调），
 * 而且对比度由我们自己的调色板保证（design-audit 已经守过这几个组合）。
 */
function themeVariablesFor(theme: 'light' | 'dark'): Record<string, string> {
  const dark = theme === 'dark'
  const t = (name: string, fb: string): string => cssRgbToken(name, fb)
  const card = t('--card', dark ? '#202020' : '#ffffff')
  const muted = t('--muted', dark ? '#2a2a30' : '#f4f4f6')
  const accent = t('--accent', dark ? '#26262c' : '#f0f0f4')
  const primary = t('--primary', dark ? '#8b8bf0' : '#4f46e5')
  const ink = t('--foreground', dark ? '#f4f4f6' : '#101014')
  const line = t('--muted-foreground', dark ? '#9e9ea8' : '#5c5c66')
  const border = t('--border', dark ? '#38383f' : '#e0e0e4')
  // 字体绑到应用 UI 字体（Inter / --font-sans）。不设的话 mermaid 用自带默认
  // "trebuchet ms"（Windows 系统字体，其他平台各自回退），导致图表字体和界面
  // 完全脱节、且各编辑器观感不一。显式绑定后写进 SVG 内部 <style>，全平台一致。
  const fontFamily = cssRawToken(
    '--font-sans',
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  )
  return {
    background: card,
    fontFamily,
    // 流程图 / 状态图 / 大部分图
    primaryColor: muted,
    primaryBorderColor: primary,
    primaryTextColor: ink,
    lineColor: line,
    textColor: ink,
    nodeBorder: primary,
    mainBkg: muted,
    clusterBkg: accent,
    clusterBorder: border,
    edgeLabelBackground: card,
    titleColor: ink,
    // 时序图
    actorBkg: muted,
    actorBorder: primary,
    actorTextColor: ink,
    signalColor: line,
    signalTextColor: ink,
    labelBoxBkgColor: card,
    labelBoxBorderColor: border,
    labelTextColor: ink,
    loopTextColor: ink,
    noteBkgColor: accent,
    noteBorderColor: border,
    noteTextColor: ink,
    activationBkgColor: accent,
    activationBorderColor: primary,
    // 类图
    classText: ink,
  }
}

function applyTheme(mermaid: Mermaid, theme: 'light' | 'dark'): void {
  const next = theme === 'dark' ? 'dark' : 'default'
  const vars = themeVariablesFor(theme)
  // 判重键里必须带上纸墨本身：阅读主题（纸 / 米黄 / 书）会改 --card / --foreground，
  // 只按 light/dark 判重的话，换成米黄纸面之后图还是旧的白底。
  const key = `${next}::${vars.background}::${vars.primaryColor}::${vars.primaryBorderColor}::${vars.textColor}::${vars.lineColor}::${vars.fontFamily}`
  if (lastThemeKey === key) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: next,
    themeVariables: vars,
    // 避免 mermaid 在失败时往 DOM 注入默认错误 UI（我们自己展示）
    suppressErrorRendering: true,
  })
  lastThemeKey = key
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
