// 静态设计审计：把「好看」里能算的部分算出来。
//
// 边界（很重要）：这个脚本只看 CSS 源码，算的是 token 的原始值。
// 「元素上屏后到底可不可见」——半透明合成、层叠背景、实际字号——它算不出来，
// 那部分由 tools/ui-verify.mjs 用真实浏览器量。两个都要跑：
//   node tools/design-audit.mjs   # token 体系、字阶、悬空引用
//   node tools/ui-verify.mjs      # 渲染结果、合成对比度、版式断言
//
// 为什么需要它：模型侧看不到图，而设计里有相当一部分是硬指标——
// 正文对比度够不够（WCAG AA）、强调色有没有被滥用、字阶是不是成体系、
// 阴影是不是彩色投影、有没有硬编码的时长/颜色绕过 token。
// 这些都能从 tokens.css 与各 partial 直接算，比截图更可靠，也能进 CI。
//
// 用法：node tools/design-audit.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// 不能用 `new URL('..', import.meta.url).pathname`：Windows 上 pathname 是
// `/D:/Code/lector/`，再 join 下去会得到 `D:\D:\Code\lector\...`。
// CI 跑在 Linux 上（没有盘符），这条路只在开发机上是坏的。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 去掉 CSS 注释：静态体检只看声明，注释里的 hex / 数值 / 伪选择器都是噪音。 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const TOKENS = stripCssComments(readFileSync(join(ROOT, 'packages/editor/src/styles/tokens.css'), 'utf8'))

// app.css 现在只是入口清单（五条 @import，见该文件的说明）。直接读它等于什么都没
// 体检——必须顺着 @import 把 partial 按顺序拼回来，顺序就是层叠顺序。
// tokens / reading-themes 跳过：它们各自有专门的检查，混进来会把 --primary 的
// 统计口径也一起改了（那两处是「定义」，不是「用」）。
const STYLES_DIR = join(ROOT, 'packages/editor/src/styles')
const SEPARATELY_AUDITED = ['tokens.css', 'reading-themes.css']
function readCssBundle(entry) {
  const text = readFileSync(entry, 'utf8')
  return text.replace(/@import\s+'\.\/([^']+)';/g, (whole, name) =>
    SEPARATELY_AUDITED.includes(name) ? '' : readCssBundle(join(STYLES_DIR, name)),
  )
}
const APP = stripCssComments(readCssBundle(join(STYLES_DIR, 'app.css')))

/** 取某个主题块里的 token 定义（light = :root，dark = html[data-theme='dark']）。 */
function parseTokens(css) {
  const out = { light: {}, dark: {} }
  // 注意：token 块的结束大括号可能和最后一行定义同行，不能用 /\n\}/ 收尾
  const blocks = [
    ['light', /:root\s*\{([\s\S]*?)\}/],
    ['dark', /html\[data-theme='dark'\]\s*\{([\s\S]*?)\}/],
  ]
  for (const [theme, re] of blocks) {
    const m = css.match(re)
    if (!m) continue
    for (const line of m[1].split('\n')) {
      const t = line.match(/^\s*(--[\w-]+):\s*([^;]+);/)
      if (t) out[theme][t[1]] = t[2].trim()
    }
  }
  return out
}

const tokens = parseTokens(TOKENS)

/** 把 token 值解析成 RGB 三元组：支持 "24 24 27" 与 rgb(var(--x) / a)。 */
function resolveColor(value, theme, depth = 0) {
  if (depth > 6 || !value) return null
  const v = value.trim()
  const triple = v.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/)
  if (triple) return { r: +triple[1], g: +triple[2], b: +triple[3] }
  const ref = v.match(/rgb\(\s*var\((--[\w-]+)\)\s*(?:\/\s*([\d.]+)\s*)?\)/)
  if (ref) {
    const base = resolveColor(tokens[theme][ref[1]] ?? tokens.light[ref[1]], theme, depth + 1)
    if (!base) return null
    const alpha = ref[2] === undefined ? 1 : parseFloat(ref[2])
    // 与白/黑底混合，近似「肉眼看到的颜色」
    const bg = theme === 'dark' ? { r: 14, g: 14, b: 16 } : { r: 255, g: 255, b: 255 }
    return {
      r: Math.round(base.r * alpha + bg.r * (1 - alpha)),
      g: Math.round(base.g * alpha + bg.g * (1 - alpha)),
      b: Math.round(base.b * alpha + bg.b * (1 - alpha)),
    }
  }
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  return null
}

const srgb = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const lum = (c) => 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b)
function contrast(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
}

// token 表里的 key 带 -- 前缀；调用处写裸名更顺手，这里补上。
const color = (name, theme) => {
  const key = name.startsWith('--') ? name : `--${name}`
  return resolveColor(tokens[theme][key] ?? tokens.light[key], theme)
}

const findings = []
const note = (level, msg) => findings.push({ level, msg })

if (process.env.AUDIT_DEBUG) {
  console.error('light keys:', Object.keys(tokens.light).length, 'dark keys:', Object.keys(tokens.dark).length)
  console.error('sample light:', tokens.light['--foreground'], '| dark:', tokens.dark['--foreground'])
}

// ── 1. 对比度（token 原始值，不含合成）──
// 这里是「纸面 vs 文字色」的静态值，门槛按 WCAG AA。
// 正文（14–17px 常规）要 4.5:1；大字（≥18.66px 粗体或 24px）3:1；
// 非文本 UI（边框、图标）3:1。
for (const theme of ['light', 'dark']) {
  const paper = color('paper', theme)
  const checks = [
    ['foreground', '正文', 4.5],
    ['muted-foreground', '次级信息', 4.5],
    ['subtle-foreground', '最弱一级（时间戳/图注）', 3.0],
    ['primary', '链接/选中（文本用）', 4.5],
    // 结构线（引用条 / 复选框 / 分隔线）在本文件只做「存在性」检查，
    // 真正的可见度必须按合成后的值算——见 ui-verify.mjs（那里门槛是 3:1）。
    ['border-strong', '强边框（非文本，原始值）', 2.0],
  ]
  for (const [token, label, min] of checks) {
    const c = color(token, theme)
    if (!c) {
      note('warn', `${theme}: 找不到 --${token}`)
      continue
    }
    const ratio = contrast(c, paper)
    if (ratio < min) {
      note('error', `${theme} ${label} ${token} 对纸面对比度 ${ratio}:1 < ${min}:1`)
    } else {
      note('ok', `${theme} ${label} ${token} = ${ratio}:1 (≥${min})`)
    }
  }
}

// ── 2. 强调色用量：靛蓝只能出现在选中/主按钮/焦点环/链接 ──
const APP_ALLOWED_PRIMARY = ['a', 'a:hover', '.btn-primary', '.slider-fill', '.switch-track.on', 'outline', 'focus-visible', 'block-focus-bg', 'accent', 'selection']
const primaryUses = [...APP.matchAll(/rgb\(var\(--primary[^)]*\)\)/g)].length
note(primaryUses > 40 ? 'warn' : 'ok', `样式表里 primary 出现 ${primaryUses} 次（选择器层面；过多说明强调失效）`)

// ── 3. token 绕过：硬编码颜色 / 时长 / 缓动 ──
// 一定要在**去掉注释之后**扫：注释里提到某个 hex（「这里曾经写死 #4f46e5」）
// 会被当成真的绕过 token，报出来的是一条自己写的说明文案。
const APP_CODE = stripCssComments(APP)
// 有意写死的两处：开关滑块必须纯白（它坐在彩色/灰轨道上，跟主题走会失去「凸起」感），
// 打印强制白底（PDF 的归宿是分享与打印，深色没有意义）。其余硬编码颜色都算绕过 token。
const ALLOWED_HARD_COLORS = ['#fff']
const hardColors = [...APP_CODE.matchAll(/#[0-9a-f]{3,8}\b/gi)]
  .map((m) => m[0])
  .filter((c) => !ALLOWED_HARD_COLORS.includes(c.toLowerCase()))
const hardDurations = [...APP_CODE.matchAll(/(?:transition|animation)[^;]*?\b(\d{2,4})ms/g)].map((m) => m[0])
const rgbLiterals = [...APP_CODE.matchAll(/rgba?\(\s*\d/g)].map((m) => m[0])
if (hardColors.length) note('warn', `样式表硬编码颜色 ${hardColors.length} 处：${hardColors.slice(0, 6).join(' ')}`)
if (rgbLiterals.length) note('warn', `样式表裸 rgb() 数值 ${rgbLiterals.length} 处（应走 token）`)
if (hardDurations.length) note('info', `样式表直接写时长 ${hardDurations.length} 处（应走 --motion-*）`)

// ── 4. 阴影：禁止彩色投影（品牌靛蓝做投影） ──
const shadowVals = Object.entries(tokens.light)
  .filter(([k]) => k.startsWith('--shadow'))
  .map(([k, v]) => [k, v])
for (const [k, v] of shadowVals) {
  if (/var\(--primary\)|var\(--success\)|var\(--warning\)|var\(--destructive\)/.test(v) && !k.includes('primary')) {
    note('warn', `${k} 使用了语义色做投影：${v}`)
  }
}
note('ok', `定义了 ${shadowVals.length} 组阴影`)

// ── 5. 字阶：档位数量与相邻档差 ──
const sizes = Object.entries(tokens.light)
  .filter(([k]) => k.startsWith('--text-'))
  .map(([k, v]) => [k, parseFloat(v)])
  .filter(([, v]) => !Number.isNaN(v))
  .sort((a, b) => a[1] - b[1])
const uniq = [...new Set(sizes.map(([, v]) => v))]
let tight = []
for (let i = 1; i < uniq.length; i++) {
  if (uniq[i] - uniq[i - 1] < 1) tight.push(`${uniq[i - 1]}→${uniq[i]}`)
}
note('info', `字阶档位 ${uniq.length} 个：${uniq.join(' / ')}`)
if (tight.length) note('warn', `相邻档差 <1px：${tight.join(', ')}`)
if (uniq.some((v) => v < 12)) {
  note('error', `存在小于 12px 的字号（CJK 底线）：${uniq.filter((v) => v < 12).join(', ')}`)
}

// ── 6. 阅读版心：一行能排多少中文字 ──
const rem = (v) => {
  const n = parseFloat(v)
  return Number.isNaN(n) ? NaN : v.includes('rem') ? n * 16 : n
}
const measure = rem(tokens.light['--reading-max-w'])
const readingSize = parseFloat(tokens.light['--text-reading'])
if (!Number.isNaN(measure) && !Number.isNaN(readingSize)) {
  const perLine = Math.round(measure / readingSize)
  const ok = perLine >= 28 && perLine <= 48
  note(ok ? 'ok' : 'warn', `版心 ${measure}px / 正文 ${readingSize}px ≈ 每行 ${perLine} 个中文字（理想 30–45）`)
}

// ── 7. 组件层：检查关键结构是否存在（防重构漏改） ──
// 骨架与浮层的关键选择器：任何一个消失都说明有人误删，
// 而这些结构在 UI 上往往「不报错、只是没了」（#titlebar.scrolled 就被误删过一次）。
const required = [
  '.window-controls', // Windows 自绘窗口控件
  '.win-btn',
  '#titlebar.scrolled', // 正文滚动后顶栏浮现的分隔影
  'html[data-shell=\'windows\']',
  '.modal-backdrop',
  '.find-bar',
  '.sidebar', // 停靠侧栏（替代了早期的 .outline-panel 浮层）
  '#statusbar', // 状态行
  '.frontmatter', // frontmatter 属性卡
  '.empty-state',
]
for (const sel of required) {
  if (!APP.includes(sel.replace(/^html\[/, 'html[').replace(/'/g, "'"))) {
    note('error', `缺少关键样式：${sel}`)
  }
}

// ── 8. 阅读主题：两侧不漏、基线与对比度 ──
//
// 阅读主题是手写的 12 套纸墨（6 款 × 明暗）。手工配的色值不设机器门，
// 下一个人改一处 --muted 就可能把某款主题的正文压到 3:1 而没人发现——
// 主题是「读起来像什么」，可读性塌了，主题就白做了。
const THEMES_CSS = readFileSync(join(ROOT, 'packages/editor/src/styles/reading-themes.css'), 'utf8')
const THEMES_TS = readFileSync(join(ROOT, 'packages/core/src/readingThemes.ts'), 'utf8')

/** 解析 reading-themes.css 里所有 [data-reading-theme='x'] 块（这些块里没有嵌套大括号）。 */
function parseThemeBlocks(css) {
  const out = {}
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]
    if (!/data-reading-theme/.test(sel)) continue
    const ids = [...sel.matchAll(/data-reading-theme='([\w-]+)'/g)].map((x) => x[1])
    const dark = /data-theme='dark'/.test(sel)
    const vars = {}
    for (const line of m[2].split('\n')) {
      const t = line.match(/^\s*(--[\w-]+):\s*([^;]+);/)
      if (t) vars[t[1]] = t[2].trim()
    }
    for (const id of new Set(ids)) {
      out[id] ??= { light: {}, dark: {} }
      Object.assign(out[id][dark ? 'dark' : 'light'], vars)
    }
  }
  return out
}

const themeBlocks = parseThemeBlocks(THEMES_CSS)
const declaredIds = [...THEMES_TS.matchAll(/\n\s+id: '([\w-]+)',/g)].map((m) => m[1])
if (declaredIds.length < 6) note('error', `阅读主题清单只有 ${declaredIds.length} 款（期望 ≥6）`)

// 两侧不漏：清单里声明的必须有样式，样式里有的必须在清单里。
// 少一边的后果都是静默的——用户选了主题，页面什么都不变。
for (const id of declaredIds) {
  if (!themeBlocks[id]) {
    note('error', `阅读主题「${id}」在 readingThemes.ts 里声明了，reading-themes.css 里没有对应规则（选了它不会有任何变化）`)
  }
}
for (const id of Object.keys(themeBlocks)) {
  if (!declaredIds.includes(id)) {
    note('error', `reading-themes.css 里的「${id}」不在主题清单里（用户永远选不到它）`)
  }
}

// default 块是 tokens.css 基线的副本（为了让预览卡在别的主题下仍显示「默认」的样子）。
// 副本就会漂移，所以逐项比对：基线改了而这里没跟上，直接报错。
{
  const base = themeBlocks.default
  if (!base) {
    note('error', '缺少 default 主题块：预览卡会继承当前主题的纸墨，「默认」那张显示的是别人')
  } else {
    let drift = 0
    for (const [mode, table] of [
      ['light', tokens.light],
      ['dark', tokens.dark],
    ]) {
      for (const [k, v] of Object.entries(base[mode])) {
        if (table[k] !== v) {
          drift++
          if (drift <= 3) note('error', `default 主题 ${mode} 的 ${k} = ${v}，与 tokens.css 基线 ${table[k]} 不一致`)
        }
      }
    }
    if (drift > 3) note('error', `default 主题与基线共 ${drift} 处不一致（只列出前 3 处）`)
    if (drift === 0) note('ok', `default 主题与 tokens.css 基线完全一致（${Object.keys(base.light).length} 项）`)
  }
}

// 每款主题 × 明暗：正文 / 次级 / 最弱 / 链接 对纸面的对比度。
// 门槛与上面第 1 节同源（都是 WCAG AA），只是这里逐主题穷举。
for (const id of declaredIds) {
  const block = themeBlocks[id]
  if (!block) continue
  for (const mode of ['light', 'dark']) {
    // 主题只覆盖它关心的那几个变量，其余继承基线——所以要合并后再算
    const merged = { ...tokens[mode], ...tokens.light, ...block.light, ...block[mode] }
    const pick = (name) => resolveColor(merged[`--${name}`], mode)
    const paper = pick('paper')
    if (!paper) {
      note('warn', `${id}/${mode}: 找不到 --paper`)
      continue
    }
    const checks = [
      ['foreground', '正文', 4.5],
      ['muted-foreground', '次级信息', 4.5],
      ['subtle-foreground', '最弱一级', 3.0],
      ['primary', '链接/选中', 4.5],
    ]
    const line = []
    for (const [name, label, min] of checks) {
      const c = pick(name)
      if (!c) {
        note('warn', `${id}/${mode}: 缺少 --${name}`)
        continue
      }
      const ratio = contrast(c, paper)
      line.push(`${label} ${ratio}`)
      if (ratio < min) {
        note('error', `${id}/${mode} ${label} --${name} 对纸面 ${ratio}:1 < ${min}:1`)
      }
    }
    note('info', `主题 ${id}/${mode} 对纸面：${line.join(' · ')}`)
  }
}

// ── 5. 被烧过的三处（canary） ──
// 每条对应一个真修过的 bug，且都**静态可判**：不需要浏览器。它们共同的特征是
// 「坏掉的时候界面不会报错，只是少了一层效果或悄悄画错」，靠肉眼很容易漏。
// 浏览器量不了层叠，但层叠写法的这几条硬规矩能量。

// (a) 全局动效守卫只允许一条。
// 两份 *-规则并存时只有一份生效，另一份静默失效——文件末尾那份"减弱动态效果"
// 曾经就是重复的第二份，谁也不知道哪份在起作用。
const rmBlocks = [...APP.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}/g)]
const globalGuards = rmBlocks.filter((m) => /^\s*\*(,|:not\(|\s|\{)/.test(m[1]))
if (globalGuards.length > 1) {
  note('error', `reduced-motion 的全局守卫有 ${globalGuards.length} 条：多条 *-规则只会互相遮蔽，先写的那条静默失效`)
}
// (b) 那条全局守卫必须放过 mermaid。
// mermaid 的布局测量要经过它自己的一条 transition，把 transition-duration 压成
// 0.01ms 会让 getBBox() 算出巨大的包围盒（实测 viewBox 4141×2103，正确 838×190），
// 整张图缩进角落——而且只有开了「减弱动态效果」的用户才看得到。
{
  const guard = globalGuards.map((m) => m[0]).join('\n')
  if (guard && (!guard.includes('.mermaid-render-host') || !guard.includes('.mermaid-svg'))) {
    note('error', 'reduced-motion 的全局守卫没有排除 mermaid 的两个 host：会把图的布局量坏')
  }
}
// (c) [hidden] 必须有全局守卫。
// 作者样式的 display:flex/grid 会盖过 UA 的 [hidden] { display: none }，
// 于是 el.hidden = true 对它们完全无效（设置面板的行/分区、关于面板都栽过）。
// 没有这条 !important，任何人写一条 display 就能把它按回去。
{
  const hiddenRules = [...APP.matchAll(/([^{}]*\[hidden\][^{}]*)\{([^}]*)\}/g)]
  const guarded = hiddenRules.some(([, , body]) => /display:\s*none\s*!important/.test(body))
  if (!guarded) {
    note('error', '缺少 [hidden] 的全局守卫（display:none !important）：作者样式的 display 会盖过它，el.hidden = true 静默失效')
  }
}
// (d) 「滑块显出来」只允许一条规则决定。
// 曾经两套滚动条系统并存（html 上 .is-scrolling 30% + 全局 :hover 12%），
// 内层容器被后者接管且只有 12% —— 深色下等于没有，而浅色下看起来正常。
{
  const visible = [...APP.matchAll(/([^{}]+)\{([^}]*scrollbar-color:[^;]+;[^}]*)\}/g)]
    .map(([, sel, body]) => [sel.trim().replace(/\s+/g, ' '), body.match(/scrollbar-color:\s*([^;]+)/)[1].trim()])
    .filter(([, v]) => !v.startsWith('transparent'))
  if (visible.length > 1) {
    note('error', `滚动条有 ${visible.length} 条规则在决定「滑块显出来」（${visible.map(([s]) => s.slice(0, 28)).join(' | ')}）：靠后的会静默遮蔽靠前的`)
  }
}

// ── 输出 ──
const order = { error: 0, warn: 1, ok: 2, info: 3 }
findings.sort((a, b) => order[a.level] - order[b.level])
for (const f of findings) {
  const tag = { error: 'ERROR', warn: 'WARN ', ok: 'OK   ', info: 'INFO ' }[f.level]
  console.log(`${tag} ${f.msg}`)
}
const errors = findings.filter((f) => f.level === 'error').length
const warns = findings.filter((f) => f.level === 'warn').length
console.log(`\n${errors} error / ${warns} warn`)
process.exit(errors > 0 ? 1 : 0)
