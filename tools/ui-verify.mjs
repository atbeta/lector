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

  // 3.4) 大纲：当前小节高亮 + 跳转顶部对齐
  {
    const outline = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.outline-row')]
      const c = document.getElementById('content')
      return {
        count: rows.length,
        active: rows.filter((r) => r.classList.contains('active')).length,
        diag: {
          scrollTop: c.scrollTop,
          blocks: document.querySelectorAll('#content .block').length,
          sidebarHidden: document.getElementById('sidebar').hidden,
          firstRow: rows[0]?.textContent ?? null,
        },
      }
    })

    if (outline.count > 0) {
      if (outline.active === 0) note('error', '大纲没有任何高亮项（阅读时看不出「读到哪了」）')
      if (outline.active > 1) note('error', `大纲同时高亮 ${outline.active} 项，当前小节应当唯一`)

      // 滚动后高亮要跟着动
      // 每个大纲行都要指向真实存在的块：指不到就会「高亮消失 + 点击无反应」
      const dangling = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.outline-row')]
        const ids = new Set([...document.querySelectorAll('#content .block')].map((b) => b.dataset.blockId))
        return rows.map((r) => r.dataset.blockId).filter((id) => !id || !ids.has(id))
      })
      if (dangling.length) {
        note('error', `大纲有 ${dangling.length} 行指向不存在的块：${dangling.slice(0, 3).join(', ')}`)
      }

      const spy = await page.evaluate(async () => {
        const c = document.getElementById('content')
        const label = () => [...document.querySelectorAll('.outline-row')].find((r) => r.classList.contains('active'))?.textContent ?? null
        c.scrollTop = 0
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r))
        const atTop = label()
        c.scrollTop = c.scrollHeight
        for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r))
        const atBottom = label()
        c.scrollTop = 0
        return { atTop, atBottom, rows: document.querySelectorAll('.outline-row').length }
      })
      if (spy.rows > 1 && spy.atTop === spy.atBottom) {
        note('error', `滚动前后高亮都是「${spy.atTop}」，滚动反查没生效`)
      }

      // 点击跳转：标题应当到顶部（留呼吸），不是居中。
      // 取靠前的那一节——最后一节常常因为后面内容不够而滚不到顶，那是正常的，
      // 拿它断言会误报（第一版就是这么错的）。
      const jump = await page.evaluate(async () => {
        const rows = [...document.querySelectorAll('.outline-row')]
        const idx = Math.min(1, rows.length - 1)
        rows[idx].click()
        await new Promise((r) => setTimeout(r, 800))
        const content = document.getElementById('content')
        const heads = [...content.querySelectorAll('.block[data-kind="heading"]')]
        const el = heads[idx]
        const gap = el
          ? Math.round(el.getBoundingClientRect().top - content.getBoundingClientRect().top)
          : null
        const activeIdx = rows.indexOf(document.querySelector('.outline-row.active'))
        return { gap, clickedIdx: idx, viewportH: content.clientHeight, activeIdx }
      })
      // scroll-padding-top 是 24px，远小于视口；若居中对齐这里会是视口的 1/3 上下
      if (jump.gap !== null && jump.gap > 80) {
        note('error', `点击大纲项后标题距容器顶 ${jump.gap}px（视口 ${jump.viewportH}px），像是居中对齐而非顶部对齐`)
      }
      if (jump.activeIdx !== jump.clickedIdx) {
        note('error', `点击大纲第 ${jump.clickedIdx + 1} 项后，高亮的是第 ${jump.activeIdx + 1} 项`)
      }
      note('info', `大纲跳转：标题距顶 ${jump.gap}px，高亮第 ${jump.activeIdx + 1} 项`)
      // 上级高亮：读到一个二级小节时，要能看出它挂在哪个一级小节下
      const ancestry = await page.evaluate(async () => {
        const c = document.getElementById('content')
        const rows = [...document.querySelectorAll('.outline-row')]
        const out = []
        for (const top of [0, c.scrollHeight * 0.4, c.scrollHeight]) {
          c.scrollTop = top
          for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r))
          const active = rows.find((r) => r.classList.contains('active'))
          out.push({
            depth: Number(active?.dataset.depth ?? 1),
            ancestors: rows.filter((r) => r.classList.contains('ancestor')).map((r) => Number(r.dataset.depth)),
          })
        }
        c.scrollTop = 0
        return out
      })
      for (const a of ancestry) {
        if (a.depth > 1 && a.ancestors.length === 0) {
          note('error', `当前是 ${a.depth} 级小节，但没有任何上级被标出（长文档会失去方向感）`)
        }
        if (a.depth === 1 && a.ancestors.length > 0) {
          note('error', `一级小节不该有上级，却标出了 ${a.ancestors.length} 个`)
        }
      }
      summary.outlineSpy = { ...spy, ...jump, ancestry }
      await page.evaluate(() => { document.getElementById('content').scrollTop = 0 })
      await page.waitForTimeout(200)
    }
  }

  // 3.5) 滚动归属：正文自己滚，顶栏与状态行常驻（骨架的核心约束）
  // 先把滚动位置清零再滚，避免上一次断言留下的位置让 .scrolled 已经是真
  await page.evaluate(() => {
    const c = document.getElementById('content')
    c.scrollTop = 0
  })
  await page.waitForTimeout(150)
  const scrolling = await page.evaluate(async () => {
    const c = document.getElementById('content')
    const bar = document.getElementById('titlebar')
    const before = getComputedStyle(bar).boxShadow
    c.scrollTop = 300
    // 顶栏的 .scrolled 是在 rAF 里设的，等它出现（最多 300ms）再读
    for (let i = 0; i < 30 && !bar.classList.contains('scrolled'); i++) {
      await new Promise((r) => requestAnimationFrame(r))
    }
    return {
      contentScrolls: c.scrollHeight > c.clientHeight,
      domScrolls: document.documentElement.scrollHeight > window.innerHeight,
      barAtTop: Math.round(bar.getBoundingClientRect().y) === 0,
      barShadowBefore: before,
      barShadowAfter: getComputedStyle(bar).boxShadow,
      barScrolledClass: bar.classList.contains('scrolled'),
      diag: { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight },
      statusPinned: Math.abs(document.getElementById('statusbar').getBoundingClientRect().bottom - window.innerHeight) <= 2,
    }
  })
  if (!scrolling.contentScrolls) note('error', '正文没有可滚动区域（骨架要求滚动发生在正文里）')
  if (scrolling.domScrolls) note('error', '整页在滚动：顶栏与状态行会被滚走')
  if (!scrolling.statusPinned) note('error', '滚动后状态行离开了视口底部')
  if (!scrolling.barScrolledClass || scrolling.barShadowAfter === scrolling.barShadowBefore) {
    note('error', '正文滚动后顶栏没有出现分隔影（滚动监听的可能是 window，改骨架后它会失效）')
  }
  await page.evaluate(() => { document.getElementById('content').scrollTop = 0 })
  await page.waitForTimeout(200)

  // 3.6) 编辑与阅读能力：快捷键、代码复制、图片放大
  {
    const keys = await page.evaluate(() => {
      const block = [...document.querySelectorAll('#content .block')].find((b) => b.dataset.kind === 'paragraph')
      return block ? { found: true } : { found: false }
    })
    if (!keys.found) note('error', '样本文档里找不到段落块，无法验证编辑能力')

    // 快捷键走真实键盘：直接问 keymap 有没有装上是问不出来的
    if (keys.found) {
      const press = async (key) => {
        // 先失焦（Escape 让当前块回到预览态），再点目标块，
        // 否则「已经聚焦同一块」时点击不会重建编辑器。
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
        await page.evaluate(() => {
          const block = [...document.querySelectorAll('#content .block')].find((b) => b.dataset.kind === 'paragraph')
          block.click()
        })
        await page.waitForSelector('.cm-content', { timeout: 5000 })
        await page.waitForTimeout(200)
        await page.locator('.cm-content').first().click()
        await page.keyboard.press('Meta+a')
        await page.keyboard.type('x y')
        await page.keyboard.press('Meta+a')
        await page.keyboard.press(key)
        await page.waitForTimeout(200)
        return page.evaluate(() =>
          [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
        )
      }
      const cases = [
        ['Meta+b', '**x y**', '⌘B 粗体'],
        ['Meta+i', '*x y*', '⌘I 斜体'],
        ['Meta+e', '`x y`', '⌘E 行内代码'],
      ]
      for (const [key, want, label] of cases) {
        const got = await press(key)
        if (got !== want) note('error', `${label} 没生效：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
      }
      const link = await press('Meta+k')
      if (!/^\[x y\]\(.+\)$/.test(link)) {
        note('error', `⌘K 链接没生效：得到 ${JSON.stringify(link)}`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // 代码块：语言标签 + 复制
    const code = await page.evaluate(() => {
      const block = document.querySelector('.block[data-kind="code"]')
      if (!block) return { missing: true }
      const bar = block.querySelector('.code-bar')
      return {
        bar: !!bar,
        lang: bar?.querySelector('.code-lang')?.textContent ?? null,
        copy: !!bar?.querySelector('.code-copy'),
        insidePre: !!bar?.closest('pre'),
      }
    })
    if (code.missing) note('warn', '样本文档里没有代码块，跳过代码工具条检查')
    else {
      if (!code.bar) note('error', '代码块没有工具条（语言标签 + 复制）')
      if (!code.copy) note('error', '代码块没有复制按钮')
      if (code.insidePre) note('error', '代码工具条被塞进了 <pre>，会污染复制的文本')
      if (!code.lang) note('warn', '代码块没有显示语言标签')
    }

    // 阅读里的图片：光标要提示可放大，点击要真的能开、能关
    const img = await page.evaluate(() => {
      const i = document.querySelector('.reading-prose img')
      if (!i) return { missing: true }
      return { cursor: getComputedStyle(i).cursor, loaded: i.complete && i.naturalWidth > 0 }
    })
    if (img.missing) note('error', '样本文档里没有图片，无法验证放大查看')
    else {
      if (img.cursor !== 'zoom-in') note('error', `阅读里的图片光标是 ${img.cursor}，没有「可放大」的提示`)
      if (!img.loaded) note('error', '样本文档里的图片没加载出来（夹具路径不对？）')
      await page.click('.reading-prose img')
      await page.waitForTimeout(300)
      const opened = await page.evaluate(() => {
        const l = document.querySelector('.lightbox')
        return {
          open: !!l && !l.hidden,
          locked: getComputedStyle(document.getElementById('content')).overflowY === 'hidden',
        }
      })
      if (!opened.open) note('error', '点击图片没有打开放大浮层')
      if (!opened.locked) note('error', '放大浮层打开时正文仍可滚动（背景会跟着滚）')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      const closed = await page.evaluate(() => ({
        hidden: document.querySelector('.lightbox')?.hidden !== false,
        unlocked: getComputedStyle(document.getElementById('content')).overflowY !== 'hidden',
      }))
      if (!closed.hidden) note('error', 'Esc 关不掉图片放大浮层')
      if (!closed.unlocked) note('error', '关闭放大浮层后正文滚动没有恢复')
    }
  }

  // 3.65) 右键菜单：功能不做进常驻 UI，全靠它承接
  {
    const menuItems = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.context-menu .context-item')].map((b) => b.textContent),
      )
    const rightClick = async (sel, pos) => {
      const el = page.locator(sel).first()
      await el.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      const box = await el.boundingBox()
      if (!box) return false
      const x = pos?.x ?? box.x + box.width - 12
      const y = pos?.y ?? box.y + box.height / 2
      await page.mouse.click(x, y, { button: 'right' })
      await page.waitForTimeout(220)
      return true
    }

    // 块菜单
    await rightClick('#content .block[data-kind="paragraph"]')
    const blockMenu = await menuItems()
    if (blockMenu.length < 5) {
      note('error', `右键块只给出 ${blockMenu.length} 项：${JSON.stringify(blockMenu)}`)
    }
    if (!blockMenu.some((l) => /delete|删除/i.test(l))) note('error', '块菜单里没有删除项')
    if (!blockMenu.some((l) => /copy|复制/i.test(l))) note('error', '块菜单里没有复制项')
    // Esc 必须能关
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    if (await page.evaluate(() => !!document.querySelector('.context-menu'))) {
      note('error', 'Esc 关不掉右键菜单')
    }

    // 菜单不能溢出视口（右下角右键最容易踩）
    await rightClick('#content .block[data-kind="paragraph"]', {
      x: 1200 - 6,
      y: 800 - 6,
    })
    const clamped = await page.evaluate(() => {
      const m = document.querySelector('.context-menu')
      if (!m) return null
      const r = m.getBoundingClientRect()
      return { right: Math.round(r.right), bottom: Math.round(r.bottom), w: window.innerWidth, h: window.innerHeight }
    })
    if (clamped && (clamped.right > clamped.w || clamped.bottom > clamped.h)) {
      note('error', `右键菜单溢出视口：右下角 ${clamped.right}x${clamped.bottom} vs 视口 ${clamped.w}x${clamped.h}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)

    // 编辑态菜单
    await rightClick('#content .block[data-kind="paragraph"]', { x: 460, y: 300 })
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#content .block')].find((x) => x.dataset.kind === 'paragraph')
      b?.click()
    })
    await page.waitForTimeout(350)
    await page.locator('.cm-content').first().click({ button: 'right' })
    await page.waitForTimeout(220)
    const editorMenu = await menuItems()
    if (!editorMenu.some((l) => l.includes('撤销') || l.includes('Undo'))) {
      note('error', `编辑器右键没有标准编辑项：${JSON.stringify(editorMenu)}`)
    }
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)

    // 删除 + ⌘Z 恢复：破坏性操作必须有后悔药
    const countBlocks = () => page.evaluate(() => document.querySelectorAll('#content .block:not(.gap)').length)
    // 先退出编辑态，否则右键落在编辑器上，给的是编辑菜单（没有删除项）
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const before = await countBlocks()
    await rightClick('#content .block[data-kind="paragraph"]')
    // 用索引而不是文案：文案随语言变，而删除项在块菜单里的位置是固定的
    const idx = await page.evaluate(() =>
      [...document.querySelectorAll('.context-menu .context-item')].findIndex((b) =>
        /delete|删除/i.test(b.textContent ?? ''),
      ),
    )
    if (idx < 0) note('error', '块菜单里找不到删除项')
    else await page.locator('.context-menu .context-item').nth(idx).click()
    await page.waitForTimeout(300)
    const afterDelete = await countBlocks()
    if (afterDelete !== before - 1) {
      note('error', `删除块后块数 ${before} → ${afterDelete}，期望少 1`)
    }
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(400)
    const afterUndo = await countBlocks()
    if (afterUndo !== before) {
      note('error', `⌘Z 没能恢复删除的块：${afterDelete} → ${afterUndo}，期望回到 ${before}`)
    }
    note('info', `右键菜单：块 ${blockMenu.length} 项，删除+⌘Z 恢复 ${before}→${afterDelete}→${afterUndo}`)
  }

  // 3.7) 顶栏几何：导航对齐正文列、标题对齐正文中心、操作区贴右
  const barGeo = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), right: Math.round(b.right), center: Math.round(b.x + b.width / 2) }
    }
    return {
      lead: r('.titlebar-lead'),
      content: r('#content'),
      title: r('.titlebar-title'),
      // 正文的「光学中心」：盒子含左右内边距，用盒子中心比会得到 16px 假偏差
      // 用真实块元素量正文列：容器右侧可能被经典滚动条占掉
      // （Windows），按内边距推算会多算，断言就会假失败。
      text: (() => {
        const el = document.querySelector('#content .block:not(.gap)') ?? document.querySelector('.reading-prose')
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.x), right: Math.round(b.right), center: Math.round(b.x + b.width / 2) }
      })(),
      actions: r('.titlebar-actions'),
      barRight: Math.round(document.getElementById('titlebar').getBoundingClientRect().right),
    }
  })
  // 壳与正文共用一条竖线：顶栏导航左沿 == 状态行左沿 == 状态行右沿 == 正文文字左右沿。
  // 这条被用户指出过两次（先是「左边空白大」，再是「没对齐」），
  // 所以固化成断言：同屏出现三条不同的竖线，看着就是没做完。
  const edges = await page.evaluate(() => {
    const block = document.querySelector('#content .block:not(.gap)')
    const cb = document.getElementById('content').getBoundingClientRect()
    const bb = block ? block.getBoundingClientRect() : null
    const left = bb ? Math.round(bb.x) : Math.round(cb.x)
    const right = bb ? Math.round(bb.right) : Math.round(cb.right)
    const L = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().x)
    const R = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().right)
    return { textLeft: left, textRight: right, navLeft: L('.titlebar-lead'), statusLeft: L('#status-left'), statusRight: R('#status-right') }
  })
  const loose = (a, b) => Math.abs(a - b)
  if (loose(edges.navLeft, edges.textLeft) > 2) {
    note('error', `顶栏导航左沿 ${edges.navLeft} 与正文左沿 ${edges.textLeft} 未对齐`)
  }
  if (loose(edges.statusLeft, edges.textLeft) > 2) {
    note('error', `状态行左沿 ${edges.statusLeft} 与正文左沿 ${edges.textLeft} 未对齐`)
  }
  if (loose(edges.statusRight, edges.textRight) > 2) {
    note('error', `状态行右沿 ${edges.statusRight} 与正文右沿 ${edges.textRight} 未对齐`)
  }
  summary.shellEdges = edges
  // 标题必须对齐正文列的中心（不是窗口中心——有侧栏时两者差侧栏宽的一半）
  if (barGeo.title && barGeo.text) {
    // 门槛 4px：布局实测恒定在这个量级（图标字形宽度取整所致），
    // 而「对窗口居中」在有侧栏时会偏 120px，两者差两个数量级，不会误判。
    const delta = Math.abs(barGeo.title.center - barGeo.text.center)
    if (delta > 6) {
      note('error', `顶栏标题中心与正文光学中心相差 ${delta}px（有侧栏时对窗口居中就会偏 100px 以上）`)
    }
  }
  if (barGeo.actions && barGeo.barRight - barGeo.actions.right > 20) {
    note('warn', `顶栏操作区距右边缘 ${barGeo.barRight - barGeo.actions.right}px，偏大`)
  }
  summary.titlebarGeometry = barGeo

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

// ── 交互行为：粘贴转 Markdown 与块级撤销 ──
//
// 这两件事都发生在「事件 → 状态」这一层，静态审计和渲染审计都量不到：
// 只有真的按一次键、真的发一个 paste 事件，才知道接没接上。
{
  // 回到 macOS 的宽版式，并把侧栏收起来，避免遮住要点的块
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('lector-sidebar')
    } catch {
      /* ignore */
    }
  })
  await page.goto(URL_ARG, { waitUntil: 'networkidle' })
  await page.waitForSelector('#content .block', { timeout: 10000 })

  const blockCount = () => page.locator('#content .block').count()
  const toastText = () =>
    page.evaluate(() => document.getElementById('lector-toast')?.textContent ?? '')

  /**
   * 右键 target，点菜单里文字匹配 pattern 的那一项。
   *
   * 带重试：菜单会在页面滚动时关闭（这是产品行为），而上一步刚聚焦/滚动过，
   * 补一次滚动事件就可能在右键之后到达——那属于时序，不是缺陷。
   * 三次都打不开才算失败，失败要显式报出来，不能装作没测。
   */
  const menuItem = async (target, pattern, label) => {
    for (let i = 0; i < 3; i++) {
      await target.click({ button: 'right' })
      await page.waitForTimeout(260)
      const open = await page.evaluate(() => {
        const m = document.querySelector('.context-menu')
        return !!m && !m.hidden && m.querySelectorAll('.context-item').length > 0
      })
      if (open) {
        const item = page.locator('.context-menu .context-item', { hasText: pattern }).first()
        if ((await item.count()) > 0) {
          await item.click()
          await page.waitForTimeout(160)
          return true
        }
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(120)
    }
    note('error', `右键菜单里点不到「${label}」`)
    return false
  }

  // 1) 右键「在下方插入段落」→ 在刚聚焦的空块里按 ⌘Z → 段落应当撤回
  const before = await blockCount()
  // 只点有内容、看得见的块：块数组里还夹着零高的空行缝
  await menuItem(page.locator('#content .block:not(.gap)').nth(2), /insert paragraph below|在下方插入段落/i, '在下方插入段落')
  const inserted = await blockCount()
  if (inserted <= before) {
    note('error', `「插入段落」没有新增块：${before} → ${inserted}`)
  }
  const focused = await page.evaluate(() => document.querySelectorAll('#content .cm-content').length)
  if (focused !== 1) {
    note('error', `插入段落后应当只有一个聚焦块（页面上有 ${focused} 个 CM 编辑器）`)
  }
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(250)
  const undone = await blockCount()
  if (undone !== before) {
    note('error', `块内 ⌘Z 没有撤回插入的段落：${before} → ${inserted} → ${undone}`)
  } else {
    note('info', `块级撤销：插入的段落可撤回（块数回到 ${before}）`)
  }

  // 2) 粘贴带 HTML 的剪贴板 → 落到块里的是 Markdown
  // 挑一个不含链接的段落：点在有链接的段落上会被「打开链接」接走，块不会被聚焦
  await page
    .locator('#content .block[data-kind="paragraph"]')
    .filter({ hasNot: page.locator('a') })
    .first()
    .click()
  await page.waitForSelector('#content .cm-content', { timeout: 3000 })
  // 点块就该进编辑，焦点必须真的落在 CM 上：否则后面的按键打在 body 上，
  // 撤销看起来「没生效」，其实是没送到——测试会误报。
  const focusedCm = await page
    .waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (!focusedCm) {
    note('error', `点击块后焦点没进编辑器：activeElement=${await page.evaluate(() => document.activeElement?.className ?? null)}`)
  }
  const originalText = await page.locator('#content .cm-content').first().innerText()
  const pasted = await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData(
      'text/html',
      '<p>一句 <strong>加粗</strong> 和 <a href="https://a.com">链接</a></p><ul><li>甲</li><li>乙</li></ul>',
    )
    dt.setData('text/plain', '一句 加粗 和 链接 甲 乙')
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    // Chromium 不接受构造参数里的 clipboardData，只能自己挂一个
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    const content = document.querySelector('#content .cm-content')
    content.dispatchEvent(ev)
    return content.innerText
  })
  const need = ['**加粗**', '[链接](https://a.com)', '- 甲', '- 乙']
  const missing = need.filter((s) => !pasted.includes(s))
  if (missing.length) {
    note('error', `粘贴 HTML 没有转成 Markdown，缺少：${missing.join(' / ')}｜实际：${JSON.stringify(pasted)}`)
  } else {
    note('info', '粘贴 HTML：粗体、链接、清单都转成了 Markdown')
  }
  // 粘贴走 CM 的正常输入路径，所以块内 ⌘Z 应当把它整段撤回
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(250)
  const afterUndo = await page.locator('#content .cm-content').first().innerText()
  if (afterUndo.trim() !== originalText.trim()) {
    const active = await page.evaluate(() => document.activeElement?.className ?? null)
    note(
      'error',
      `粘贴没有进 CM 的撤销链：⌘Z 后是 ${JSON.stringify(afterUndo)}，原样应为 ${JSON.stringify(originalText)}｜activeElement=${active}`,
    )
  } else {
    note('info', '粘贴进撤销链：块内 ⌘Z 可整段撤回')
  }

  // 3) 任务勾选也要能撤回（勾选不经过 CM，得自己进撤销链）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const taskCount = await page.locator('#content li.task').count()
  if (taskCount > 0) {
    const checkbox = () => page.locator('#content li.task').first().locator('input[type=checkbox]')
    const checkedBefore = await checkbox().isChecked()
    await menuItem(
      page.locator('#content li.task').first(),
      /mark as (not )?done|标记为(未)?完成/i,
      '标记任务完成',
    )
    const checkedAfter = await checkbox().isChecked()
    if (checkedAfter === checkedBefore) {
      note('error', `任务勾选没有生效：${checkedBefore} → ${checkedAfter}`)
    }
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(250)
    const checkedUndone = await checkbox().isChecked()
    if (checkedUndone !== checkedBefore) {
      note('error', `任务勾选撤不回来：${checkedBefore} → ${checkedAfter} → ${checkedUndone}`)
    } else {
      note('info', `任务勾选可撤回（${checkedBefore} → ${checkedAfter} → ${checkedUndone}）`)
      note('info', `撤销回执：${JSON.stringify(await toastText())}`)
    }
  } else {
    note('warn', '示例文档里没有任务项，跳过勾选撤销检查')
  }

  // 4) 代码块里粘贴 HTML **不**转 Markdown：
  //    把网页的 <pre> 转成一个新围栏塞进已有围栏里，等于在代码里插了一段 Markdown
  const codeBlock = page.locator('#content .block[data-kind="code"]').first()
  if ((await codeBlock.count()) > 0) {
    await codeBlock.click()
    await page.waitForSelector('#content .cm-content', { timeout: 3000 })
    const ok = await page
      .waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 3000 })
      .then(() => true)
      .catch(() => false)
    if (!ok) note('error', '点击代码块后焦点没进编辑器')
    // 全选后粘贴：结果只由这一次粘贴决定，不受光标落点影响
    await page.keyboard.press('Meta+a')
    const codeAfterPaste = await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/html', '<pre><code class="language-js">const a = 1</code></pre>')
      dt.setData('text/plain', 'const a = 1')
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: dt })
      const content = document.querySelector('#content .cm-content')
      content.dispatchEvent(ev)
      return content.innerText
    })
    if (codeAfterPaste.includes('```') || !codeAfterPaste.includes('const a = 1')) {
      note('error', `代码块里粘贴 HTML 被转成了 Markdown：${JSON.stringify(codeAfterPaste)}`)
    } else {
      note('info', '代码块里粘贴 HTML：落进去的是代码原文，没有多出一层围栏')
    }
  } else {
    note('warn', '示例文档里没有代码块，跳过代码块粘贴检查')
  }
  summary.behavior = { blocksBefore: before, blocksAfterInsert: inserted, blocksAfterUndo: undone }
}

// info 是「量到了什么」的播报，不是问题；混进 warn 计数会让人以为有一堆毛病
const order = { error: 0, warn: 1, info: 2 }
findings.sort((a, b) => order[a.level] - order[b.level])
for (const f of findings) {
  console.log(`${f.level.toUpperCase().padEnd(5)} ${f.msg}`)
}
const errors = findings.filter((f) => f.level === 'error').length
const warns = findings.filter((f) => f.level === 'warn').length
console.log(`\n${errors} error / ${warns} warn / ${findings.length - errors - warns} info`)
if (process.env.VERIFY_DUMP) console.log(JSON.stringify(summary, null, 2))
process.exit(errors > 0 ? 1 : 0)
