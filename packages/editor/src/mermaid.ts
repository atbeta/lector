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
import { getSettings } from './settings.ts'

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
    // 加载失败**不能**留在缓存里：一次失败（例如依赖缓存过期，动态 import 拿到
    // 504 Outdated Optimize Dep）会把整个会话钉死——之后每张图都拿到同一个已 reject 的
    // promise，界面上一直是「渲染失败」，而重新加载明明已经能成功了。
    // 清掉它，下一次渲染自己重试；失败本身仍由调用方照常报出来。
    mermaidPromise = import('mermaid')
      .then((m) => m.default)
      .catch((err: unknown) => {
        mermaidPromise = null
        throw err
      })
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
 * 映射规则：节点底是纸色往靛蓝混 12% 的浅调（轻上色，图不再纯线框灰），
 * 描边用图表专属靛蓝、文字用 --foreground、连线用 --muted-foreground（暖灰墨）。
 * note 用琥珀浅底（注释的惯例语义色），cluster 带微弱靛调，secondary/tertiary
 * 给状态图等补绿/琥珀变体。强调色不绑 --primary——应用的 primary 是暖黑，
 * 绑它图就永远是灰的；靛蓝与暖纸底对比和谐，且图表观感跨主题稳定。
 */

/** 解析 cssRgbToken 产出的颜色（rgb(79 70 229) / rgb(79,70,229) / #4f46e5 均可）。 */
function parseRgb(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    const h = color.slice(1)
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ]
  }
  const n = color.match(/[\d.]+/g) ?? ['0', '0', '0']
  return [Number(n[0]), Number(n[1]), Number(n[2])]
}

/** 把 a 往 b 混 ratio（0=a 原样，1=全 b），返回 rgb() 串。 */
function mixColor(a: string, b: string, ratio: number): string {
  const ca = parseRgb(a)
  const cb = parseRgb(b)
  const ch = (i: number): number => Math.round(ca[i]! + (cb[i]! - ca[i]!) * ratio)
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`
}

function themeVariablesFor(theme: 'light' | 'dark'): Record<string, string> {
  const dark = theme === 'dark'
  const t = (name: string, fb: string): string => cssRgbToken(name, fb)
  const card = t('--card', dark ? '#202020' : '#ffffff')
  const ink = t('--foreground', dark ? '#f4f4f6' : '#101014')
  const line = t('--muted-foreground', dark ? '#9e9ea8' : '#5c5c66')
  const border = t('--border', dark ? '#38383f' : '#e0e0e4')
  // 图表强调色：读 --diagram-accent。
  // 以前这里写死靛蓝，理由是「--primary 在默认主题里是暖黑，绑它图就永远是灰的」。
  // 那个理由只对默认/focus 成立，代价却是所有主题共用一支靛蓝——米黄纸面上的一张
  // 靛蓝图就是用户说的「不匹配」。现在由主题自己表态：tokens.css 给靛蓝兜底，
  // 纸/书/手册/米黄在 reading-themes.css 里各自覆盖成自己的强调色。
  const diagramAccent = t('--diagram-accent', dark ? '#8b8bf0' : '#4f46e5')
  // 节点底：纸色往靛蓝混 12%（暗色 16%——暗底上浅调要更浓才可感知）。
  // 注意方向：card 是基底、accent 是掺入色，掺多了会变回饱和主色。
  const nodeTint = mixColor(card, diagramAccent, dark ? 0.16 : 0.12)
  const clusterTint = mixColor(card, diagramAccent, dark ? 0.08 : 0.06)
  // note 的琥珀调：注释的惯例语义色，与主色区分开。
  const noteBkg = dark ? '#2c2921' : '#fffbeb'
  const noteBorder = dark ? '#4d4636' : '#ecd9a0'
  // 状态图等用到的变体底色：绿（完成/正常）与琥珀（注意）。
  const secondary = dark ? '#1c2a24' : '#ecfdf5'
  const tertiary = noteBkg
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
    primaryColor: nodeTint,
    primaryBorderColor: diagramAccent,
    primaryTextColor: ink,
    lineColor: line,
    textColor: ink,
    nodeBorder: diagramAccent,
    mainBkg: nodeTint,
    secondaryColor: secondary,
    tertiaryColor: tertiary,
    clusterBkg: clusterTint,
    clusterBorder: border,
    edgeLabelBackground: card,
    titleColor: ink,
    // 时序图
    actorBkg: nodeTint,
    actorBorder: diagramAccent,
    actorTextColor: ink,
    signalColor: line,
    signalTextColor: ink,
    labelBoxBkgColor: card,
    labelBoxBorderColor: border,
    labelTextColor: ink,
    loopTextColor: ink,
    noteBkgColor: noteBkg,
    noteBorderColor: noteBorder,
    noteTextColor: ink,
    activationBkgColor: clusterTint,
    activationBorderColor: diagramAccent,
    // 类图
    classText: ink,
  }
}

function applyTheme(mermaid: Mermaid, theme: 'light' | 'dark'): void {
  const next = theme === 'dark' ? 'dark' : 'default'
  const vars = themeVariablesFor(theme)
  const user = effectiveUserConfig()
  // 用户挑了 mermaid 内置主题 → **我们的调色板让位**。
  // 不让位的话 `{"theme":"forest"}` 几乎看不出变化：我们绑了二十多个 themeVariables，
  // 它们盖在内置主题之上，用户会以为「不支持」。让位 = 那个主题原样上屏。
  //
  // 两处不让位：
  //   - 用户自己写了 themeVariables：那是明确要细调，在我们的基础上覆盖（逐层合并）；
  //   - 字体：图里的字要和界面����致，那是全局观感，不属于「主题」这一层。
  const userTheme = typeof user.config.theme === 'string' && user.config.theme.trim() !== ''
  const userVars = typeof user.config.themeVariables === 'object' && user.config.themeVariables !== null
  const baseVars: Record<string, string> =
    userTheme && !userVars ? { fontFamily: vars.fontFamily ?? '' } : vars
  // 判重键里必须带上纸墨本身：阅读主题（纸 / 米黄 / 书）会改 --card / --foreground，
  // 只按 light/dark 判重的话，换成米黄纸面之后图还是旧的白底。
  // 也要带上用户配置：配置一变就得重新 initialize，否则新配置要等下次切主题才生效。
  const key = `${next}::${baseVars.background ?? ''}::${baseVars.primaryColor ?? ''}::${baseVars.primaryBorderColor ?? ''}::${baseVars.textColor ?? ''}::${baseVars.lineColor ?? ''}::${baseVars.fontFamily}::${user.signature}`
  if (lastThemeKey === key) return
  mermaid.initialize(
    mergeMermaidConfig(
      {
        startOnLoad: false,
        securityLevel: 'strict',
        theme: next,
        themeVariables: baseVars,
        // 避免 mermaid 在失败时往 DOM 注入默认错误 UI（我们自己展示）
        suppressErrorRendering: true,
      },
      user.config,
    ),
  )
  lastThemeKey = key
}

/**
 * mermaid 列为 secure 的键：谁传都会被它自己丢掉——包括文档里的 `%%{init}%%` 指令
 * （实测过：指令里写 `securityLevel: "loose"` 加 `click ... call fn()`，点击不会执行）。
 *
 * 我们**再手动剥一层**，不把安全属性寄托在库的内部实现上：将来 mermaid 调整那张表，
 * 这一层还在。这几个�����决定的是「图里能不能跑脚本/能塞多大」，不属于主题自定义的范围。
 */
const MERMAID_SECURE_KEYS = [
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
]

/**
 * 深合并：用户配置盖在我们的默认之上。用户配置里的 secure keys 一��忽略。
 *
 * 逐层合并（而不是整份替换）是必须的：用户只写 `{"themeVariables": {"lineColor": "red"}}`
 * 时，其余几十个色仍要保留我们按主题算出来的值——整份替换会让图瞬间变回 mermaid 自带的
 * 淡紫默认（那正是当初要绑 token 的原因）。数组与标量按「后者胜」处理。
 */
export function mergeMermaidConfig(
  base: Record<string, unknown>,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(user)) {
    if (MERMAID_SECURE_KEYS.includes(k)) continue
    const prev = out[k]
    const bothPlainObjects =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    out[k] = bothPlainObjects
      ? mergeMermaidConfig(prev as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}

/**
 * 解析用户配置。返回 null 表示「没有配置」，error 供设置面板显示。
 *
 * 只接受 JSON 对象：一段合法的 JSON 数组/数字对 mermaid 没有意义，早点说清楚比
 * 让它悄悄不生效好。
 */
export function parseMermaidConfig(text: string): {
  config: Record<string, unknown> | null
  error: string | null
} {
  const raw = text.trim()
  if (!raw) return { config: null, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: null, error: 'not an object' }
  }
  return { config: parsed as Record<string, unknown>, error: null }
}

/**
 * 由设置里的原文算出「本次生效的用户配置」。纯函数，单独测。
 *
 * 三种输入三种处置，别混：
 *   - 合法对象 → 生效；
 *   - **空** → 没有用户配置，回到默认（指纹也要清掉，否则清空输入框不生效）；
 *   - 解析失败 → 沿用上一份能用的。用户是边打边看的，敲到一半必然不合法
 *     （少个花括号而已），那时把图全渲染回默认色比什么都不做更糟。
 */
export function nextUserConfig(
  text: string,
  prev: { config: Record<string, unknown> | null; signature: string },
): { config: Record<string, unknown> | null; signature: string } {
  const { config, error } = parseMermaidConfig(text)
  if (config) return { config, signature: JSON.stringify(config) }
  if (!error) return { config: null, signature: '' }
  return prev
}

let lastGoodConfig: Record<string, unknown> | null = null
let lastGoodSignature = ''
function effectiveUserConfig(): { config: Record<string, unknown>; signature: string } {
  const next = nextUserConfig(getSettings().mermaidConfig ?? '', {
    config: lastGoodConfig,
    signature: lastGoodSignature,
  })
  lastGoodConfig = next.config
  lastGoodSignature = next.signature
  return { config: lastGoodConfig ?? {}, signature: lastGoodSignature }
}

/**
 * 影响渲染结果的一切（明暗 + 纸面 + 用户配置）的指纹。
 * 调用方用它判断「设置变了要不要重画」——mermaid 的配色是**烘进 SVG** 的，
 * 不像正文那样靠 CSS 变量自动跟随：换阅读主题（纸 / 米黄 / 书）改的是 --card，
 * 只看明暗的话图还停在旧纸面上。
 */
export function mermaidRenderSignature(): string {
  const theme =
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light'
  // 纸面 + 图表强调色都要进签名：两者都烘进 SVG，换主题时必须重画。
  return `${theme}::${cssRgbToken('--card', '')}::${cssRgbToken('--diagram-accent', '')}::${effectiveUserConfig().signature}`
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
  columnWidth?: number,
): Promise<string> {
  // 缓存键必须带上用户配置、纸面与栏宽：
  //   - 配置改过之后，同一段源码的旧 SVG 就是错的；
  //   - 换阅读主题会改 --card，而底色与墨色都烘在 SVG 里，不带上就永远返回旧纸面那张；
  //   - 画布自然宽按测量时的栏宽定（甘特尤甚），栏宽变了必须绕开缓存重画。
  //   栏宽由调用方传入（图所在容器的实际宽度）——全局 querySelector 会抓到
  //   文档里第一个 .reading-prose，多栏/测试环境下量错对象。
  const measured = columnWidth || document.querySelector('.reading-prose')?.clientWidth || 800
  // 甘特画布保底 1000px：任务条宽度 = 跨度天数占比 × 画布，40 天跨度里 2 天的
  // 任务在 760px 画布上只有 ~36px，装不下四个汉字的任务名（标签溢出到条外，
  // 看着像「条前面的纯文字」）。保底宽度 + min-width 锁 + 容器横向滚动，
  // 窄栏也能完整读图——其他甘特渲染器都是这个策略。
  const canvasWidth = isGanttSource(code) ? Math.max(measured, 1000) : measured
  const key = `${theme}::${canvasWidth}::${cssRgbToken('--card', '')}::${cssRgbToken('--diagram-accent', '')}::${effectiveUserConfig().signature}::${code}`
  const hit = cacheGet(key)
  if (hit !== undefined) return hit

  const mermaid = await getMermaid()
  applyTheme(mermaid, theme)
  // 甘特图等「按容器宽度定画」的图：mermaid 渲染时读临时容器父级的宽度当画布宽
  // （ganttDiagram 源码：st = N.parentElement.offsetWidth）。不传容器时挂在 body
  // 下，量到的宽度不可控（实测 288px，整张甘特缩在左边）。传入宽度等于阅读栏宽
  // 的临时容器，自然宽度一开始就算对；svg 自带 width=100% + max-width=自然宽，
  // 显示时仍随实际栏宽自适应。visibility:hidden 保留布局，offsetWidth 可量。
  const tmp = document.createElement('div')
  // 这个类名是给 app.css 的 reduced-motion 守卫看的：那条守卫会把全局的
  // transition-duration 压成 0.01ms，而 mermaid 正是在这里量尺寸的——
  // 被压过的时长会让它的包围盒算飞（详见 app.css 里的注释）。
  tmp.className = 'mermaid-render-host'
  tmp.style.cssText = `position:absolute;visibility:hidden;left:-99999px;top:0;width:${canvasWidth}px`
  document.body.appendChild(tmp)
  try {
    const { svg } = await mermaid.render(id, code.trim(), tmp)
    // 甘特图的任务条宽度跟轴走：窄栏里短任务（如 2d）会被压到装���下任务名，
    // 标签居中溢出到条外，看着像「条前面的纯文字」。锁最小宽度 = 不缩于自然宽，
    // 窄栏走容器横向滚动（.mermaid-diagram 已有 overflow-x: auto）。
    if (isGanttSource(code)) {
      const patched = svg.replace(
        /max-width:\s*([\d.]+px)/,
        'max-width: $1; min-width: $1',
      )
      cachePut(key, patched)
      return patched
    }
    cachePut(key, svg)
    return svg
  } finally {
    tmp.remove()
  }
}

/** 测试钩子：清空缓存。生产代码不要调。 */
export function _resetCacheForTests(): void {
  svgCache.clear()
}

/** 首个有效行（跳过空行与 %% 注释）是否为 gantt——只有甘特需要锁最小宽度。 */
function isGanttSource(code: string): boolean {
  for (const line of code.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('%%')) continue
    return t === 'gantt' || t.startsWith('gantt ')
  }
  return false
}
