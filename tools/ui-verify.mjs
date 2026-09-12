// 渲染层验证：用真实浏览器量「实际画出来的东西」。
//
// 为什么必须用它：静态审计只能算 token 本身，算不出
//  - 半透明合成后的真实对比度（--border-strong /0.7 才是上屏的值）
//  - 表格是不是真的排成了四列、边框是不是真的可见
//  - 元素有没有重叠、溢出、被挤出视口
//  - 主题（浅色/深色）与平台（mac 红绿灯留位 / Windows 自绘控件）的实际版式
//
// 用法：node tools/ui-verify.mjs [url]
// 需要先起 vite dev。退出码非 0 表示有硬问题。

import { chromium } from 'playwright'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const findings = []
const note = (level, msg) => findings.push({ level, msg })

// 浏览器里跑的探针：只做测量，不做判断（判断放 Node 侧，方便加断言）
const PROBE = `(() => {
  const cs = (el) => getComputedStyle(el)
  const parse = (s) => {
    const m = s.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const p = m[1].split(',').map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })
  // 逐层向上合成背景：透明背景必须和父层叠起来才是看到的颜色
  const bgOf = (el) => {
    const stack = []
    for (let n = el; n; n = n.parentElement) {
      const c = parse(cs(n).backgroundColor)
      if (c && c.a > 0) {
        stack.push(c)
        if (c.a === 1) break
      }
    }
    let out = { r: 255, g: 255, b: 255, a: 1 }
    for (const c of stack.reverse()) out = over(c, out)
    return out
  }
  const srgb = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const contrastOf = (el) => {
    const fg = parse(cs(el).color)
    if (!fg) return null
    const fgc = fg.a < 1 ? over(fg, bgOf(el)) : fg
    const bg = bgOf(el)
    const [l1, l2] = [srgb(fgc), srgb(bg)].sort((a, b) => b - a)
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
  }
  // 非文本元素的可见度：边框色与背景的对比
  const borderContrast = (el, side = 'Left') => {
    const c = parse(cs(el)['border' + side + 'Color'])
    if (!c || c.a === 0) return null
    const bg = bgOf(el)
    const eff = c.a < 1 ? over(c, bg) : c
    const [l1, l2] = [srgb(eff), srgb(bg)].sort((a, b) => b - a)
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
  }

  const info = (sel, label) => {
    const el = document.querySelector(sel)
    if (!el) return { label, sel, missing: true }
    const r = el.getBoundingClientRect()
    const s = cs(el)
    return {
      label, sel,
      fontSize: parseFloat(s.fontSize),
      fontWeight: Number(s.fontWeight),
      lineHeight: s.lineHeight === 'normal' ? null : Math.round(parseFloat(s.lineHeight) * 100) / 100,
      color: s.color,
      bg: bgOf(el),
      contrast: contrastOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
    }
  }

  // 表格：逐格量宽度，验证真的排成 4 列
  const table = document.querySelector('.reading-prose table')
  const tableInfo = table ? (() => {
    const heads = [...table.querySelectorAll('thead th')].map((th) => {
      const r = th.getBoundingClientRect()
      return { text: th.textContent.trim().slice(0, 8), w: Math.round(r.width), x: Math.round(r.x), contrast: contrastOf(th) }
    })
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => {
        const r = td.getBoundingClientRect()
        return { text: td.textContent.trim().slice(0, 10), w: Math.round(r.width), x: Math.round(r.x), h: Math.round(r.height), contrast: contrastOf(td) }
      }),
    )
    const firstTd = table.querySelector('tbody td')
    return {
      headCols: heads.length, bodyCols: rows[0] ? rows[0].length : 0,
      heads, rows,
      headRowSep: table.querySelector('thead th') ? borderContrast(table.querySelector('thead th'), 'Bottom') : null,
      rowSep: firstTd ? borderContrast(firstTd, 'Bottom') : null,
      tableWidth: Math.round(table.getBoundingClientRect().width),
    }
  })() : null

  // 任务列表：勾选与未勾选的实际颜色，以及「勾选框是否与正文同一行」
  const tasks = [...document.querySelectorAll('.reading-prose li.task')].map((li) => {
    const box = li.querySelector('input[type=checkbox]')
    const label = li.querySelector('.task-label')
    const firstLine = label ? label.querySelector('p, div') ?? label : null
    const br = box ? box.getBoundingClientRect() : null
    const lr = firstLine ? firstLine.getBoundingClientRect() : null
    return {
      text: li.textContent.trim().slice(0, 12),
      checked: !!box?.checked,
      contrast: contrastOf(li),
      color: cs(li).color,
      // 勾选框与首行文字的垂直重叠量：> 0 才算同一行
      lineOverlap: br && lr ? Math.round(Math.min(br.bottom, lr.bottom) - Math.max(br.top, lr.top)) : null,
      boxTop: br ? Math.round(br.top) : null,
      textTop: lr ? Math.round(lr.top) : null,
      textLeft: lr ? Math.round(lr.left) : null,
      boxLeft: br ? Math.round(br.left) : null,
      labelDisplay: label ? cs(label).display : null,
    }
  })
  const checkbox = document.querySelector('.reading-prose li.task input[type=checkbox]')
  const checkboxInfo = checkbox
    ? { borderContrast: borderContrast(checkbox, 'Left'), borderColor: cs(checkbox).borderLeftColor, w: Math.round(checkbox.getBoundingClientRect().width) }
    : null

  // 结构性元素是否真的画出来了
  const hr = document.querySelector('.reading-prose hr')
  const hrInfo = hr
    ? { h: Math.round(hr.getBoundingClientRect().height), w: Math.round(hr.getBoundingClientRect().width), bg: cs(hr).backgroundColor, visible: hr.getBoundingClientRect().height > 0 }
    : { missing: true }

  const quote = document.querySelector('.reading-prose blockquote')
  const quoteInfo = quote
    ? { barContrast: borderContrast(quote, 'Left'), barWidth: cs(quote).borderLeftWidth, w: Math.round(quote.getBoundingClientRect().width) }
    : { missing: true }

  // 代码块：是否真的有高亮（不同颜色数 > 1 说明上了色）
  const pre = document.querySelector('.reading-prose pre')
  const preInfo = pre ? (() => {
    const r = pre.getBoundingClientRect()
    const colors = new Set([...pre.querySelectorAll('*')].map((e) => cs(e).color))
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      textWidth: Math.round(Math.max(...[...pre.querySelectorAll('*')].map((e) => e.getBoundingClientRect().width), 0)),
      distinctColors: colors.size,
      contrast: contrastOf(pre),
    }
  })() : null

  // 表面层级：填充类表面（码片 / 代码块 / 表头）与它们所在背景的对比。
  // 1.0x 意味着「有背景色但看不见」，这是浅色主题最容易犯的错。
  const stepOf = (a, b) => {
    const [l1, l2] = [srgb(a), srgb(b)].sort((x, y) => y - x)
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
  }
  // 表面「看得见」= 它和它所在的页面底（画布/纸）差一档。
  // 不能拿父元素比：码片的父元素就是没有背景的段落，等于和画布比。
  const surfaceStep = (sel, label) => {
    const el = document.querySelector(sel)
    if (!el) return { label, missing: true }
    const own = parse(cs(el).backgroundColor)
    if (!own || own.a === 0) return { label, sel, alpha: 0 }
    const host = bgOf(document.body) // 页面底：纸或画布
    const eff = own.a < 1 ? over(own, host) : own
    return { label, sel, step: stepOf(eff, host), color: cs(el).backgroundColor }
  }
  const surfaces = [
    surfaceStep('.reading-prose code', 'inline-code'),
    surfaceStep('.reading-prose pre', 'code-block'),
    // 表头不用填充底（在纸面上叠不出可辨的一档），靠 border-strong 的分隔线；
    // 它的可见度由 headRowSep 断言保证，不列入填充面。

  ]

  // 背景是否平铺：body 高 100%，radial-gradient 不写 no-repeat 会每屏重复一次，
  // 长文档上出现周期性硬边。用 computed background-repeat 判。
  const bodyBg = cs(document.body)
  const bgTiling = {
    repeat: bodyBg.backgroundRepeat,
    attachment: bodyBg.backgroundAttachment,
    size: bodyBg.backgroundSize,
    image: bodyBg.backgroundImage.slice(0, 60),
  }

  // 块间距节奏：相邻块之间的真实间距，用来验证 margin 没有相加
  // 间距要跨过零高的空行缝量：相邻块中间夹着 .block.gap（高度 0），
  // 只比相邻两个会量出一堆 5–11px 的假值。
  const contentBlocks = [...document.querySelectorAll('#content > .block')].filter(
    (el) => el.getBoundingClientRect().height > 0,
  )
  const rhythm = []
  for (let i = 1; i < contentBlocks.length; i++) {
    const a = contentBlocks[i - 1].getBoundingClientRect()
    const b = contentBlocks[i].getBoundingClientRect()
    rhythm.push({ kind: contentBlocks[i].getAttribute('data-kind'), gap: Math.round(b.top - a.bottom) })
  }

  // 版心与溢出
  const content = document.getElementById('content')
  const contentRect = content.getBoundingClientRect()
  const bodyRect = { x: Math.round(contentRect.x), w: Math.round(contentRect.width) }
  const overflow = [...document.querySelectorAll('#content *')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5)
    })
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 30) }))

  // 标题：字阶是否单调递减（h5/h6 不能比正文小到看不清）
  const headings = ['h1','h2','h3','h4','h5','h6'].map((t) => {
    const el = document.querySelector('.reading-prose ' + t)
    return el ? { tag: t, size: parseFloat(cs(el).fontSize), weight: Number(cs(el).fontWeight), contrast: contrastOf(el) } : null
  }).filter(Boolean)

  // 顶栏与窗口控件
  const bar = document.getElementById('titlebar')
  const barRect = bar.getBoundingClientRect()
  const controls = [...document.querySelectorAll('.window-controls button')].map((b) => {
    const r = b.getBoundingClientRect()
    return { title: b.title, disabled: b.disabled, w: Math.round(r.width), x: Math.round(r.x), visible: r.width > 0 }
  })
  const iconBtns = [...document.querySelectorAll('.titlebar-actions .btn-icon, .titlebar-lead .btn-icon')].map((b) => ({
    id: b.id, contrast: contrastOf(b), visible: b.getBoundingClientRect().width > 0,
  }))
  const titleEl = document.querySelector('.titlebar-title')
  const titleRect = titleEl.getBoundingClientRect()

  return {
    theme: document.documentElement.getAttribute('data-theme'),
    shell: document.documentElement.getAttribute('data-shell'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    titlebar: {
      h: Math.round(barRect.height),
      bg: cs(bar).backgroundColor,
      hasScrolled: bar.classList.contains('scrolled'),
      titleCenterX: Math.round(titleRect.x + titleRect.width / 2),
      viewportCenterX: Math.round(window.innerWidth / 2),
      icons: iconBtns,
      controls,
    },
    surface: {
      body: cs(document.body).backgroundColor,
      paper: cs(document.documentElement).getPropertyValue('--paper').trim(),
      background: cs(document.documentElement).getPropertyValue('--background').trim(),
    },
    content: { ...bodyRect, blockCount: document.querySelectorAll('#content .block').length },
    typography: [
      info('.reading-prose h1', 'h1'), info('.reading-prose h2', 'h2'),
      info('.reading-prose h3', 'h3'),
      // 必须取顶层段落：任务列表项里的 p 在 .task-label 内，颜色语义不同
      info('#content > .block[data-kind="paragraph"] .reading-prose > p, #content > .block[data-kind="paragraph"] p', 'body'),
      info('.reading-prose code', 'inline-code'), info('.reading-prose pre', 'code-block'),
      info('.reading-prose a', 'link'), info('.titlebar-title', 'titlebar-title'),
    ],
    headings, table: tableInfo, tasks, checkbox: checkboxInfo, hr: hrInfo, quote: quoteInfo, pre: preInfo,
    surfaces, bgTiling, rhythm,
    // 任务项的删除线是否真的落在正文上（span 嵌套 bug 会让它落在空元素上）
    taskDecoration: (() => {
      const label =
        document.querySelector('.reading-prose li.task:has(input:checked) .task-label') ??
        document.querySelector('.reading-prose li.task .task-label')
      if (!label) return { missing: true }
      const s = getComputedStyle(label)
      return {
        textDecorationLine: s.textDecorationLine,
        isChecked: !!label.closest('li')?.querySelector('input:checked'),
        childTag: label.firstElementChild ? label.firstElementChild.tagName.toLowerCase() : null,
        hasText: label.textContent.trim().length > 0,
      }
    })(),
    overflow,
    // 视口内实际能看到多少块：太多说明首屏塞太满，太少说明留白过度
    blocksInView: [...document.querySelectorAll('#content .block')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0 }).length,
    scrollHeight: document.documentElement.scrollHeight,
  }
})()`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2 })

const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))

// 浅色主题是本应用的默认，必须显式验证（localStorage 里可能存着 dark）
await page.addInitScript(() => {
  try {
    window.localStorage.setItem('lector-theme', 'light')
  } catch {
    /* ignore */
  }
})
await page.goto(URL_ARG, { waitUntil: 'networkidle' })
await page.waitForSelector('#content .block', { timeout: 10000 })

async function measure(tag) {
  const data = await page.evaluate(PROBE)
  await page.screenshot({ path: `.shots/verify-${tag}.png`, fullPage: false })
  await page.screenshot({ path: `.shots/verify-${tag}-full.png`, fullPage: true })
  return data
}

const light = await measure('light')

// 深色主题
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await page.waitForTimeout(250)
const dark = await measure('dark')

// Windows 版式：换 UA 重建页面，chrome.ts 会按 UA 画出三个窗口控件
// 注意：UA 必须在 context 级设置——newPage({ userAgent }) 的实际行为不可靠，
// 之前就出现过「以为换了 UA、其实 navigator.userAgent 没变」的假通过。
const winContext = await browser.newContext({
  viewport: { width: 1200, height: 820 },
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
})
const winPage = await winContext.newPage()
await winPage.addInitScript(() => {
  try {
    window.localStorage.setItem('lector-theme', 'light')
  } catch {
    /* ignore */
  }
})
await winPage.goto(URL_ARG, { waitUntil: 'networkidle' })
await winPage.waitForSelector('#content .block', { timeout: 10000 })
const win = await winPage.evaluate(PROBE)
await winPage.screenshot({ path: '.shots/verify-windows.png' })

await browser.close()

// ── 断言 ──
for (const [themeName, d] of [['light', light], ['dark', dark]]) {
  // 1. 表格必须真的排成 4 列（这是被怀疑渲染坏掉的地方）
  if (!d.table) note('error', `${themeName}: 找不到表格`)
  else {
    if (d.table.headCols !== 4) note('error', `${themeName}: 表头 ${d.table.headCols} 列，期望 4`)
    const row = d.table.rows[0] ?? []
    if (row.length !== 4) note('error', `${themeName}: 表体首行 ${row.length} 列，期望 4（疑似单元格塌陷）`)
    const narrow = row.filter((c) => c.w < 40)
    if (narrow.length) note('error', `${themeName}: 表体有 ${narrow.length} 个单元格窄于 40px：${JSON.stringify(narrow)}`)
    if (d.table.headRowSep !== null && d.table.headRowSep < 1.2) {
      note('warn', `${themeName}: 表头下边框合成后对比 ${d.table.headRowSep}:1（几乎看不见）`)
    }
  }

  // 2. 任务列表：勾选态不能比未勾选暗得多（视觉上像失效）
  if (d.tasks.length >= 2) {
    const done = d.tasks.filter((t) => t.checked).map((t) => t.contrast)
    const todo = d.tasks.filter((t) => !t.checked).map((t) => t.contrast)
    if (done.length && todo.length) {
      const worst = Math.min(...done)
      const best = Math.max(...todo)
      if (worst < 3) note('error', `${themeName}: 已勾选任务对比度 ${worst}:1 < 3（看起来像禁用）`)
      else if (worst < best / 2) note('warn', `${themeName}: 已勾选 ${worst}:1 vs 未勾选 ${best}:1，差距过大`)
    }
  }

  // 3. 结构元素必须可见：引用条、复选框边框、分隔线
  if (d.quote?.barContrast !== null && d.quote?.barContrast < 1.8) {
    note('error', `${themeName}: 引用条合成后对比 ${d.quote.barContrast}:1 < 1.8（看不见）`)
  }
  if (d.checkbox?.borderContrast !== null && d.checkbox?.borderContrast < 1.8) {
    note('error', `${themeName}: 复选框边框合成后对比 ${d.checkbox.borderContrast}:1 < 1.8（看不见）`)
  }
  if (d.hr?.visible === false) note('error', `${themeName}: 分隔线高度为 0`)
  const deco = d.taskDecoration
  if (deco?.missing) note('error', `${themeName}: 找不到 .task-label`)
  else if (!deco.hasText) note('error', `${themeName}: .task-label 里没有文字（嵌套被浏览器拆掉了）`)

  // 4. 对比度：正文与链接要过 AA
  const body = d.typography.find((t) => t.label === 'body')
  if (body && !body.missing && body.contrast < 7) note('warn', `${themeName}: 正文对比 ${body.contrast}:1（阅读器建议 ≥7）`)
  const link = d.typography.find((t) => t.label === 'link')
  if (link && !link.missing && link.contrast < 4.5) note('warn', `${themeName}: 链接对比 ${link.contrast}:1 < 4.5`)
  const dec = d.taskDecoration
  if (dec && !dec.missing && dec.isChecked && dec.textDecorationLine === 'none') {
    note('error', `${themeName}: 已勾选任务没有删除线（CSS 没命中或被嵌套拆掉）`)
  }

  // 任务项：勾选框必须与正文首行同一行（这是最容易复发的排版 bug）
  for (const t of d.tasks) {
    if (t.lineOverlap === null) continue
    if (t.lineOverlap <= 0) {
      note('error', `${themeName}: 任务项「${t.text}」的勾选框与正文不在同一行（boxTop=${t.boxTop} textTop=${t.textTop}）`)
    }
  }

  // 填充类表面必须真的看得出是一档，否则「有背景色」是假的。
  // 门槛 1.15：低于这个值就是「配了个色但看不见」，浅色主题最容易犯。
  for (const sfc of d.surfaces) {
    if (sfc.missing) continue
    if (sfc.alpha === 0) continue
    if (sfc.step !== undefined && sfc.step < 1.15) {
      note('error', `${themeName}: ${sfc.label} 表面与背景只差 ${sfc.step}:1，等于没画`)
    } else if (sfc.step !== undefined) {
      note('info', `${themeName}: ${sfc.label} 表面 ${sfc.step}:1`)
    }
  }

  // 背景不能平铺
  // 注意别用 /repeat/ 子串判断——"no-repeat" 里也含 "repeat"
  const repeats = d.bgTiling.repeat.split(',').map((x) => x.trim())
  if (repeats.some((r) => r !== 'no-repeat')) {
    note('error', `${themeName}: body 背景会平铺（background-repeat: ${d.bgTiling.repeat}），长文档会出现周期性硬边`)
  }

  // 阅读版心与字号：这两个值由设置决定，必须与设计标定一致
  const bodyT = d.typography.find((x) => x.label === 'body')
  if (bodyT && !bodyT.missing) {
    if (bodyT.fontSize < 16) note('warn', `${themeName}: 正文字号 ${bodyT.fontSize}px（阅读器下限 16）`)
    if (d.content.w && d.content.w > 760) {
      note('warn', `${themeName}: 版心 ${d.content.w}px 偏宽（>760px 时中文一行超过 45 字）`)
    }
  }

  // 块间距：小于 0.5 倍行高才算粘连（半行的说法对应的是 15px，会把正常段距全报成问题）
  // lineHeight 是 computed 值（已经是 px），不要再乘字号——那会得到 506px 的假阈值
  const line = bodyT && !bodyT.missing && bodyT.lineHeight ? bodyT.lineHeight : 28
  for (const r of d.rhythm) {
    if (r.kind && r.gap > 0 && r.gap < line * 0.5) {
      note('error', `${themeName}: ${r.kind} 与上一块间距仅 ${r.gap}px（< ${Math.round(line * 0.5)}px），会读成粘连`)
    }
  }
  note('info', `${themeName}: 块间距 ${d.rhythm.map((r) => `${r.kind}:${r.gap}`).join(' ')}`)
  const th = d.table?.heads?.[0]
  if (th && th.contrast < 4.5) note('warn', `${themeName}: 表头对比 ${th.contrast}:1 < 4.5`)

  // 5. 溢出
  if (d.overflow.length) note('error', `${themeName}: ${d.overflow.length} 个元素横向溢出：${JSON.stringify(d.overflow.slice(0, 3))}`)

  // 6. 标题字阶必须严格递减，且都不小于正文字号
  for (let i = 1; i < d.headings.length; i++) {
    if (d.headings[i].size >= d.headings[i - 1].size) {
      note('error', `${themeName}: 标题字阶非递减 ${d.headings[i - 1].tag}(${d.headings[i - 1].size}) → ${d.headings[i].tag}(${d.headings[i].size})`)
    }
  }

  // 7. 表面分层：纸 vs 画布不能糊在一起
  const l = d.surface
  note('info', `${themeName}: 表面 background=${l.background} paper=${l.paper}`)

  // 8. 顶栏标题必须居中
  if (Math.abs(d.titlebar.titleCenterX - d.titlebar.viewportCenterX) > 2) {
    note('warn', `${themeName}: 顶栏标题中心 ${d.titlebar.titleCenterX} ≠ 视口中心 ${d.titlebar.viewportCenterX}`)
  }
  for (const icon of d.titlebar.icons) {
    if (!icon.visible) note('error', `${themeName}: 顶栏图标 ${icon.id} 不可见`)
    else if (icon.contrast < 3) note('warn', `${themeName}: 顶栏图标 ${icon.id} 对比 ${icon.contrast}:1 < 3`)
  }
}

// Windows：三个窗口控件必须在位、可用、且贴右边缘
if (win.shell !== 'windows') note('error', `Windows UA 下 data-shell=${win.shell}，期望 windows`)
if (win.titlebar.controls.length !== 3) {
  note('error', `Windows 下窗口控件 ${win.titlebar.controls.length} 个，期望 3`)
} else {
  for (const c of win.titlebar.controls) {
    if (!c.visible) note('error', `Windows 窗口控件「${c.title}」不可见`)
    if (c.w < 30) note('warn', `Windows 窗口控件「${c.title}」宽 ${c.w}px，点击区域偏小`)
  }
}
if (light.shell === win.shell) note('error', `macOS 与 Windows 的 data-shell 相同（都是 ${light.shell}），平台判定没生效`)
// Windows 的标题栏要向系统靠：32px 高。46px 的居中式标题栏 + 右侧控件
// 会读成「mac 窗口贴了 Windows 按钮」。
if (win.shell === 'windows' && win.titlebar.h !== 32) {
  note('error', `Windows 标题栏高 ${win.titlebar.h}px（原生 32px）`)
}
if (light.titlebar.h !== 46) note('warn', `macOS 标题栏高 ${light.titlebar.h}px（期望 46）`)
if (light.titlebar.controls.some((c) => c.visible)) {
  note('error', 'macOS 版式下不应出现自绘窗口控件（有原生红绿灯）')
}

// 采样出来的关键数字，便于人工复核
const summary = {
  theme: { light: light.theme, dark: dark.theme },
  shell: { mac: light.shell, win: win.shell },
  titlebar: { light: light.titlebar, dark: dark.titlebar },
  table: { light: light.table, dark: dark.table },
  tasks: { light: light.tasks, dark: dark.tasks },
  hr: { light: light.hr, dark: dark.hr },
  taskDecoration: { light: light.taskDecoration, dark: dark.taskDecoration },
  checkbox: { light: light.checkbox, dark: dark.checkbox },
  quote: { light: light.quote, dark: dark.quote },
  quote: { light: light.quote, dark: dark.quote },
  pre: { light: light.pre, dark: dark.pre },
  typography: { light: light.typography, dark: dark.typography },
  content: { light: light.content, dark: dark.content },
  headings: { light: light.headings, dark: dark.headings },
  windowControls: { mac: light.titlebar.controls, win: win.titlebar.controls },
  overflow: { light: light.overflow, dark: dark.overflow },
  consoleErrors,
}

const order = { error: 0, warn: 1 }
findings.sort((a, b) => order[a.level] - order[b.level])
for (const f of findings) {
  console.log(`${f.level === 'error' ? 'ERROR' : 'WARN '} ${f.msg}`)
}
const errors = findings.filter((f) => f.level === 'error').length
console.log(`\n${errors} error / ${findings.length - errors} warn`)
if (process.env.VERIFY_DUMP) console.log(JSON.stringify(summary, null, 2))
process.exit(errors > 0 ? 1 : 0)
