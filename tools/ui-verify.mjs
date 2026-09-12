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
  /** 两色对比度。定义在探针顶部：下面的 IIFE 会用到，晚了会 TDZ 报错。 */
  const stepOf = (a, b) => {
    const [l1, l2] = [srgb(a), srgb(b)].sort((x, y) => y - x)
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
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

  // 代码高亮的四类颜色：各自与代码块底色的对比度。
  // 这些 span 只在真正出现对应 token 时才渲染，所以要主动构造，
  // 不能等样例里恰好有注释/字符串才发现颜色不达标。
  const codeColors = (() => {
    const host = document.querySelector('.reading-prose pre code')
    if (!host) return null
    const probe = document.createElement('span')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    host.appendChild(probe)
    const out = {}
    for (const cls of ['tok-keyword', 'tok-string', 'tok-number', 'tok-comment']) {
      probe.className = cls
      const c = parse(cs(probe).color)
      // 用元素自己的底色（含半透明合成），才是高亮文字真正坐的面
      if (c) out[cls.replace('tok-', '')] = stepOf(c, bgOf(host))
    }
    probe.remove()
    return out
  })()

  // 任务列表：勾选与未勾选的实际颜色，以及「勾选框是否与正文是否同一行」
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

  // 大纲浮层：必须是「浮层」而不是常驻侧栏，且不能盖住顶栏按钮
  const outline = (() => {
    const panel = document.querySelector('.outline-panel')
    if (!panel) return { missing: true }
    if (panel.hidden) return { hidden: true }
    const pr = panel.getBoundingClientRect()
    const barZ = Number(cs(document.getElementById('titlebar')).zIndex)
    const panelZ = Number(cs(panel).zIndex)
    // 浮层盖在正文上时，正文被遮多少
    const inner = document.querySelector('.reading-prose')
    const ir = inner ? inner.getBoundingClientRect() : null
    return {
      w: Math.round(pr.width),
      touchesRightEdge: pr.right >= window.innerWidth - 0.5,
      touchesBottom: pr.bottom >= window.innerHeight - 0.5,
      radius: parseFloat(cs(panel).borderTopLeftRadius),
      shadow: cs(panel).boxShadow !== 'none',
      aboveTitlebar: panelZ >= barZ,
      overlapTextPct: ir ? Math.round((Math.max(0, ir.right - pr.left) / ir.width) * 100) : null,
    }
  })()

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
    surfaces, bgTiling, rhythm, codeColors, outline,
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
  codeColors: { light: light.codeColors, dark: dark.codeColors },
  overflow: { light: light.overflow, dark: dark.overflow },
  consoleErrors,
}

// 侧栏与状态行：应用骨架的两端。
// 侧栏曾是贴边通栏的浮层，既盖正文又不像目录——这里把形态钉死。
{
  const clickOutline = async () => {
    await page.click('#outline-btn')
    await page.waitForTimeout(320)
  }
  const shell = () =>
    page.evaluate(() => {
      const sb = document.getElementById('sidebar')
      const sr = sb.getBoundingClientRect()
      const inner = document.querySelector('.reading-prose')
      const ir = inner ? inner.getBoundingClientRect() : null
      const bar = document.getElementById('statusbar')
      const cs = getComputedStyle(sb)
      return {
        mode: document.documentElement.classList.contains('sidebar-docked')
          ? 'docked'
          : document.documentElement.classList.contains('sidebar-overlay')
            ? 'overlay'
            : 'hidden',
        btnActive: document.getElementById('outline-btn').classList.contains('active'),
        sidebarW: Math.round(sr.width),
        sidebarRight: Math.round(sr.right),
        textX: ir ? Math.round(ir.x) : null,
        textRight: ir ? Math.round(ir.right) : null,
        // 侧栏在左：被压住的是正文的左边缘
        overlap: ir ? Math.round(Math.max(0, sr.right - ir.left)) : 0,
        position: cs.position,
        statusH: Math.round(bar.getBoundingClientRect().height),
        statusBottom: Math.round(bar.getBoundingClientRect().bottom),
        statusText: (document.getElementById('status-left')?.textContent ?? '').trim(),
      }
    })

  // 顶栏分组：文件操作 2 个 + 视图 4 个，中间一条分隔
  const tb = await page.evaluate(() => ({
    lead: document.querySelectorAll('.titlebar-lead .btn-icon').length,
    actions: document.querySelectorAll('.titlebar-actions .btn-icon').length,
    divider: !!document.querySelector('.titlebar-divider'),
  }))
  if (tb.lead !== 2) note('error', `顶栏左侧工具 ${tb.lead} 个（期望 2：打开/保存）`)
  if (tb.actions !== 4) note('error', `顶栏右侧工具 ${tb.actions} 个（期望 4：大纲/查找/主题/设置）`)
  if (!tb.divider) note('error', '顶栏缺少组间分隔，六个图标会读成一排散兵')

  // 1) 宽窗口：停靠、默认展开、不压正文
  const docked = await shell()
  if (docked.mode !== 'docked') {
    note('error', `1200px 宽下侧栏形态是 ${docked.mode}（期望 docked）`)
  } else {
    if (docked.sidebarW < 200 || docked.sidebarW > 300) {
      note('error', `停靠侧栏宽 ${docked.sidebarW}px，超出 200–300 的合理区间`)
    }
    if (docked.overlap > 0) {
      note('error', `停靠侧栏压住正文 ${docked.overlap}px（停靠时正文必须让位）`)
    }
    if (docked.textX !== null && docked.textX <= docked.sidebarRight) {
      note('error', `正文起点 ${docked.textX} 在侧栏右沿 ${docked.sidebarRight} 之内`)
    }
  }
  if (!docked.btnActive) note('error', '侧栏展开时顶栏大纲按钮没有点亮')

  // 2) 开合：点一次收起，正文应重新居中
  await clickOutline()
  const closed = await shell()
  if (closed.mode !== 'hidden') note('error', '点击大纲按钮后侧栏没有收起')
  if (closed.btnActive) note('error', '侧栏收起后大纲按钮仍然点亮')
  await clickOutline()
  const reopened = await shell()
  if (reopened.mode !== 'docked') note('error', '再次点击后侧栏没有恢复停靠')

  // 3) 窄窗口：必须退化成浮层，且能点外关闭
  await page.setViewportSize({ width: 900, height: 720 })
  await page.waitForTimeout(420)
  const narrow = await shell()
  if (narrow.mode !== 'overlay') {
    note('error', `900px 宽下侧栏形态是 ${narrow.mode}（期望 overlay：放不下就该变成抽屉）`)
  } else if (narrow.position !== 'fixed') {
    note('error', '窄窗口的侧栏没有脱离文档流（position 应为 fixed）')
  }
  await page.mouse.click(760, 400)
  await page.waitForTimeout(280)
  const afterOutsideClick = await shell()
  if (afterOutsideClick.mode !== 'hidden') {
    note('error', '窄窗口浮层模式下点击正文没有关闭侧栏')
  }
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.waitForTimeout(300)

  // 4) 状态行：常驻、贴底、有内容
  if (docked.statusH < 24 || docked.statusH > 44) {
    note('error', `状态行高 ${docked.statusH}px（期望 24–44）`)
  }
  if (Math.abs(docked.statusBottom - 820) > 2) {
    note('error', `状态行底边在 ${docked.statusBottom}px，没有贴住视口底部`)
  }
  if (!/\d/.test(docked.statusText)) {
    note('error', `状态行没有数字：${JSON.stringify(docked.statusText)}`)
  }
  note('info', `状态行：${docked.statusText}`)
  summary.shellAt1200 = reopened
  summary.shellAt900 = narrow
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
