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
// 这些都能从 tokens.css / app.css 直接算，比截图更可靠，也能进 CI。
//
// 用法：node tools/design-audit.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const TOKENS = readFileSync(join(ROOT, 'packages/editor/src/styles/tokens.css'), 'utf8')
const APP = readFileSync(join(ROOT, 'packages/editor/src/styles/app.css'), 'utf8')

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
note(primaryUses > 40 ? 'warn' : 'ok', `app.css 里 primary 出现 ${primaryUses} 次（选择器层面；过多说明强调失效）`)

// ── 3. token 绕过：硬编码颜色 / 时长 / 缓动 ──
const hardColors = [...APP.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0])
const hardDurations = [...APP.matchAll(/(?:transition|animation)[^;]*?\b(\d{2,4})ms/g)].map((m) => m[0])
const rgbLiterals = [...APP.matchAll(/rgba?\(\s*\d/g)].map((m) => m[0])
if (hardColors.length) note('warn', `app.css 硬编码颜色 ${hardColors.length} 处：${hardColors.slice(0, 6).join(' ')}`)
if (rgbLiterals.length) note('warn', `app.css 裸 rgb() 数值 ${rgbLiterals.length} 处（应走 token）`)
if (hardDurations.length) note('info', `app.css 直接写时长 ${hardDurations.length} 处（应走 --motion-*）`)

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
const required = ['.window-controls', '.win-btn', '#titlebar.scrolled', 'html[data-shell=\'windows\']', '.modal-backdrop', '.find-bar', '.outline-panel', '.empty-state']
for (const sel of required) {
  if (!APP.includes(sel.replace(/^html\[/, 'html[').replace(/'/g, "'"))) {
    note('error', `缺少关键样式：${sel}`)
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
