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

// 平台修饰键：块内 CM 的 Mod- 绑定在非 macOS 上是 Ctrl。
// 脚本里硬写 Meta+ 会在 Linux/Windows（CI 与本地预览）上整段静默失效——
// 按下去什么都没发生，断言却报「功能没生效」，指向完全错误的方向。
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
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
    window.localStorage.setItem('lector-settings', JSON.stringify({ theme: 'light' }))
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
    window.localStorage.setItem('lector-settings', JSON.stringify({ theme: 'light' }))
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
        statusText: (document.getElementById('statusbar')?.textContent ?? '').trim(),
      }
    })

  // 顶栏分组：文件操作 2 个 + 视图 4 个，中间一条分隔
  const tb = await page.evaluate(() => ({
    lead: document.querySelectorAll('.titlebar-lead .btn-icon').length,
    actions: document.querySelectorAll('.titlebar-actions .btn-icon').length,
    divider: !!document.querySelector('.titlebar-divider'),
  }))
  if (tb.lead !== 2) note('error', `顶栏左侧工具 ${tb.lead} 个（期望 2：打开/保存）`)
  // 工具组只要求"至少这几件"：每加一个工具就改断言的精确值，会让这条断言变成维护负担，
  // 而它真正要守的是"右侧工具组存在且没被整体删掉"。
  if (tb.actions < 4) note('error', `顶栏右侧工具 ${tb.actions} 个（至少应有 4：大纲/查找/外观/键盘）`)
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

  // 3) 窄窗口：**不允许浮在正文上**
  //
  // 旧行为是「放不下就变成覆盖正文的抽屉」，实测这是最差的一种：为了看一眼目录，
  // 代价是刚读到的那段被挡住——阅读器里正文是主角。
  // 现行规则：要么停靠（和正文一起挤，正文列本来就有 max-width），要么收起，
  // 任何宽度下都不得盖住正文。
  await page.setViewportSize({ width: 900, height: 720 })
  await page.waitForTimeout(420)
  const narrow = await shell()
  if (narrow.mode === 'overlay') {
    note('error', '窄窗口下侧栏浮在正文上：会挡住正在读的内容（应停靠或收起）')
  } else {
    note('info', `窄窗口（900px）侧栏形态：${narrow.mode}（不允许浮层，只能是停靠或收起）`)
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

  // 3.45) 侧栏宽度可调 + 树形大纲
  //
  // 顺序有讲究：先验树形大纲，再验拖宽度。
  // 拖宽会把侧栏形态推到浮层（1200px 窗口 + 760px 栏宽本来就贴着停靠阈值），
  // 浮层进出有过渡，后续断言点到「正在移动的侧栏」会假失败。
  // 所以把会改变形态的操作放最后。
  {
    /** 侧栏确实开着（可见、宽度 > 0）。浮层模式或动画中间态都算没开。 */
    const sidebarOpen = () =>
      page.evaluate(() => {
        const el = document.getElementById('sidebar')
        return !!el && !el.hidden && el.getBoundingClientRect().width > 0
      })
    const ensureOpen = async () => {
      if (await sidebarOpen()) return true
      await page.click('#outline-btn')
      await page.waitForTimeout(450)
      return sidebarOpen()
    }

    if (!(await ensureOpen())) {
      note('error', '侧栏打不开，跳过宽度与大纲结构检查')
    } else {
      const tree = await page.evaluate(() => ({
        nested: !!document.querySelector('.outline-kids .outline-row'),
        twisty: document.querySelectorAll('.outline-twisty:not(.outline-twisty-empty)').length,
        empty: document.querySelectorAll('.outline-twisty-empty').length,
      }))
      if (!tree.nested) note('error', '大纲不是树：子级标题没有嵌在 .outline-kids 里')
      if (tree.twisty === 0) note('error', '大纲没有可点的收起三角（分层了却收不起来）')
      if (tree.twisty > 0) {
        const first = page.locator('.outline-twisty:not(.outline-twisty-empty)').first()
        await first.click()
        await page.waitForTimeout(260)
        const collapsed = await page.evaluate(() => {
          const n = document.querySelector(".outline-node[data-collapsed='true']")
          return {
            count: document.querySelectorAll(".outline-node[data-collapsed='true']").length,
            hidden: n ? getComputedStyle(n.querySelector('.outline-kids')).display === 'none' : false,
            stored: !!localStorage.getItem('lector-outline-collapsed'),
          }
        })
        if (collapsed.count !== 1 || !collapsed.hidden) {
          note('error', `收起三角点了没用：折叠节点 ${collapsed.count} 个，子容器隐藏=${collapsed.hidden}`)
        }
        await first.click()
        await page.waitForTimeout(240)
        if (await page.evaluate(() => document.querySelectorAll(".outline-node[data-collapsed='true']").length) !== 0) {
          note('error', '再点一次没有展开')
        }
        note('info', `大纲：树形（${tree.twisty} 个可折叠 / ${tree.empty} 个叶子），收起与展开都生效`)
      }

      // 宽度：放到最后，因为它可能把侧栏推进浮层形态
      const widthNow = () =>
        page.evaluate(() => ({
          css: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')),
          real: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
        }))
      const w0 = await widthNow()
      const grip = await page.locator('.sidebar-grip').boundingBox()
      if (!grip) {
        note('error', '侧栏没有宽度把手（.sidebar-grip），宽度不可调')
      } else {
        await page.mouse.move(grip.x + 3, grip.y + 160)
        await page.mouse.down()
        await page.mouse.move(grip.x + 3 + 80, grip.y + 160, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(300)
        const w1 = await widthNow()
        if (w1.css <= w0.css + 40) note('error', `拖宽度把手后 --sidebar-w 没变：${w0.css} → ${w1.css}`)
        if (w1.css !== w1.real) {
          note('error', `侧栏宽度的两处真相不一致：--sidebar-w=${w1.css}，实际 ${w1.real}（差 ${w1.real - w1.css}px）`)
        }
        const grip2 = await page.locator('.sidebar-grip').boundingBox()
        if (grip2) {
          await page.mouse.dblclick(grip2.x + 3, grip2.y + 160)
          await page.waitForTimeout(300)
          const w2 = await widthNow()
          if (Math.abs(w2.css - 288) > 1) note('error', `双击把手没有复位到默认 288：${w2.css}`)
          note('info', `侧栏宽度：${w0.css} → 拖到 ${w1.css} → 双击复位 ${w2.css}px`)
        }
      }
      await ensureOpen()
      await page.waitForTimeout(250)
    }
  }

  // 3.46) 空白处右键：不能漏出浏览器菜单（刷新 / 另存为 / 打印）
  {
    const gapMenu = await page.evaluate(() => {
      const gap = document.querySelector('#content .block.gap')
      if (!gap) return { missing: true }
      const r = gap.getBoundingClientRect()
      const ev = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 30),
        clientY: Math.round(r.top + 2),
      })
      gap.dispatchEvent(ev)
      return { prevented: ev.defaultPrevented, items: document.querySelectorAll('.context-item').length }
    })
    if (gapMenu.missing) note('warn', '样本文档里没有空白缝，跳过空白处右键检查')
    else if (!gapMenu.prevented || gapMenu.items === 0) {
      note('error', `段间空白右键没有接管：prevented=${gapMenu.prevented}，菜单项 ${gapMenu.items}（会漏出浏览器菜单）`)
    } else {
      note('info', `段间空白右键：拦掉系统菜单 + ${gapMenu.items} 项自定义菜单`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }

  // 3.47) 源码档：字号与阅读态一致；表格块点进去是源码，不弹网格面板
  {
    await page.evaluate(() => document.querySelector('.mode-opt[data-mode="source"]')?.click())
    await page.waitForTimeout(600)
    const src = await page.evaluate(() => {
      const s = document.querySelector('.source-view')
      return {
        size: s ? getComputedStyle(s).fontSize : null,
        reading: getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim(),
        tables: document.querySelectorAll('.reading-prose table').length,
      }
    })
    if (src.size !== src.reading) {
      note('error', `源码档字号 ${src.size} 与阅读字号 ${src.reading} 不一致（同一份文本的两种呈现，字号不该跳）`)
    }
    if (src.tables > 0) note('error', `源码档里仍有 ${src.tables} 个块渲染成了表格（源码档应当全是源码）`)
    const clicked = await page.evaluate(async () => {
      const blk = [...document.querySelectorAll('#content .block')].find((b) => b.dataset.kind === 'table')
      if (!blk) return { missing: true }
      blk.click()
      await new Promise((r) => setTimeout(r, 500))
      return {
        editor: !!document.querySelector('.table-editor-card'),
        cm: document.querySelectorAll('.cm-host').length,
      }
    })
    if (!clicked.missing && (clicked.editor || clicked.cm !== 1)) {
      note(
        'error',
        `源码档点表格：网格面板${clicked.editor ? '弹出了' : '没弹'}，块内编辑器 ${clicked.cm} 个（期望：无面板 + 1 个编辑器）`,
      )
    } else if (!clicked.missing) {
      note('info', '源码档：点表格进块内源码编辑，没有弹网格面板')
    }
    await page.keyboard.press('Escape')
    // 后面的交互都假设处于可编辑状态
    await page.evaluate(() => document.querySelector('.mode-opt[data-mode="edit"]')?.click())
    await page.waitForTimeout(300)
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
  //
  // 注意：默认档是「阅读」，点块不会进编辑。这一段要测的是编辑路径，
  // 所以先切到「编辑」档——v0.5.0 换默认档时这一段整段失效（超时失败），
  // 而失败信息只说「等 .cm-content 超时」，完全指向不到真因。
  await page.evaluate(() => document.querySelector('.mode-opt[data-mode="edit"]')?.click())
  await page.waitForTimeout(400)
  {
    const modeUi = await page.evaluate(() => {
      const opts = [...document.querySelectorAll('.mode-switch .mode-opt')]
      return {
        count: opts.length,
        modes: opts.map((o) => o.dataset.mode),
        labels: opts.map((o) => o.querySelector('.mode-opt-label')?.textContent ?? ''),
        icons: opts.map((o) => o.querySelectorAll('svg').length),
        names: opts.map((o) => o.getAttribute('aria-label') ?? ''),
        activeCount: opts.filter((o) => o.classList.contains('active')).length,
        active: document.querySelector('.mode-opt.active')?.dataset.mode ?? null,
        aria: opts.filter((o) => o.getAttribute('aria-checked') === 'true').length,
        htmlMode: document.documentElement.dataset.mode,
      }
    })
    if (modeUi.count !== 3) note('error', `视图模式控件有 ${modeUi.count} 档（期望 3：阅读/编辑/源码）`)
    // 三档「只要图标」是产品决定（顶栏更干净），所以不再要求文字标签；
    // 但纯图标意味着**可访问名必须存在**——既没文字又没 aria-label 的控件，
    // 读屏与悬浮提示双失，那是真缺陷，不是风格。
    if (modeUi.icons.some((n) => n === 0)) note('error', `视图模式有档位没有图标：${JSON.stringify(modeUi.icons)}`)
    if (modeUi.names.some((n) => !n.trim())) note('error', `视图模式有档位没有可访问名（aria-label）：${JSON.stringify(modeUi.names)}`)
    if (modeUi.activeCount !== 1) note('error', `视图模式同时有 ${modeUi.activeCount} 档处于选中态`)
    if (modeUi.aria !== 1) note('error', '视图模式的分段控件没有正确的 aria-checked（键盘/读屏拿不到当前档）')
    if (modeUi.active !== modeUi.htmlMode) {
      note('error', `分段控件亮的是 ${modeUi.active}，html[data-mode] 是 ${modeUi.htmlMode}（两处真相打架）`)
    }
    note('info', `视图模式：${modeUi.modes.join(' / ')}，当前 ${modeUi.active}`)
    summary.modeSwitch = modeUi
  }
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
        await page.keyboard.press(`${MOD}+a`)
        await page.keyboard.type('x y')
        await page.keyboard.press(`${MOD}+a`)
        await page.keyboard.press(key)
        await page.waitForTimeout(200)
        return page.evaluate(() =>
          [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
        )
      }
      const cases = [
        [`${MOD}+b`, '**x y**', '⌘B 粗体'],
        [`${MOD}+i`, '*x y*', '⌘I 斜体'],
        [`${MOD}+e`, '`x y`', '⌘E 行内代码'],
      ]
      for (const [key, want, label] of cases) {
        const got = await press(key)
        if (got !== want) note('error', `${label} 没生效：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
      }
      const link = await press(`${MOD}+k`)
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

    // 阅读里的图片：点击要弹出针对这张图的动作菜单，菜单里的「查看原图」能开、Esc 能关
    const img = await page.evaluate(() => {
      const i = document.querySelector('.reading-prose img')
      if (!i) return { missing: true }
      return { cursor: getComputedStyle(i).cursor, loaded: i.complete && i.naturalWidth > 0 }
    })
    if (img.missing) note('error', '样本文档里没有图片，无法验证放大查看')
    else {
      if (img.cursor !== 'pointer') note('error', `阅读里的图片光标是 ${img.cursor}，没有「可点击」的提示`)
      if (!img.loaded) note('error', '样本文档里的图片没加载出来（夹具路径不对？）')
      // 点击图片 → 弹「针对这张图」的动作菜单
      //
      // 先把图滚进视口再等滚动停：菜单遇滚动会收起（这是设计，防止菜单悬在已经移走的位置上），
      // 而 playwright 的 click 会自己先滚动一次——直接点就会"点了没菜单"的假失败。
      await page.evaluate(() => document.querySelector('.reading-prose img')?.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(450)
      await page.click('.reading-prose img')
      await page.waitForTimeout(250)
      const menu = await page.evaluate(() => ({
        open: !!document.querySelector('.context-menu'),
        items: [...document.querySelectorAll('.context-menu .context-item')].map((b) => b.textContent),
      }))
      if (!menu.open) note('error', '点击图片没有弹出图片动作菜单')
      // 按「位置/条数」判定，不按「文案」：实现里查看原图排第一，
      // 而文案随语言变（门跑英文界面时是 View original）——按中文标签找会假失败。
      else if (menu.items.length < 3)
        note('error', `图片动作菜单只有 ${menu.items.length} 项（应为：查看原图 / 编辑源码 / 复制图片路径）`)
      // 菜单里的「查看原图」打开放大浮层。
      // 按**位置**取（实现里它排第一），不按文案：这个脚本的页面没钉 locale，
      // 文案随机器语言变，按中文标签找会永远假红——上面 924 行刚说过这件事。
      await page.evaluate(() => {
        document.querySelector('.context-menu .context-item')?.click()
      })
      await page.waitForTimeout(300)
      const opened = await page.evaluate(() => {
        const l = document.querySelector('.lightbox')
        return {
          open: !!l && !l.hidden,
          locked: getComputedStyle(document.getElementById('content')).overflowY === 'hidden',
        }
      })
      if (!opened.open) note('error', '图片菜单里的「查看原图」没有打开放大浮层')
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
    // 先滚进视口并等滚动停下，再右键。
    // playwright 的 click() 会自己 scrollIntoViewIfNeeded，而正文滚动会关闭右键菜单
    // （产品行为：菜单跟着内容走）；那一下滚动若落在菜单弹出之后，菜单立刻被关。
    // 另外这里用显式的鼠标序列而不是 locator.click({button:'right'})：
    // 实测后者在某些页面状态下不会产生 contextmenu 事件（菜单自然也就没有），
    // 断言会报「编辑器右键没有标准编辑项」，而真因是事件根本没发出来。
    const cmBox = await page.locator('.cm-content').first()
    await cmBox.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const cmRect = await cmBox.boundingBox()
    await page.mouse.move(cmRect.x + 24, cmRect.y + 12)
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
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
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(400)
    const afterUndo = await countBlocks()
    if (afterUndo !== before) {
      note('error', `⌘Z 没能恢复删除的块：${afterDelete} → ${afterUndo}，期望回到 ${before}`)
    }
    note('info', `右键菜单：块 ${blockMenu.length} 项，删除+⌘Z 恢复 ${before}→${afterDelete}→${afterUndo}`)

    // ── 阅读档只给「读」的动作 ──
    //
    // 菜单是阅读档与编辑档唯一共用的入口：点块进入编辑那条路本来就在只读档 return 了，
    // 菜单一直没分档，于是阅读档右键表格会端出「编辑表格…」——从侧门把编辑能力放回了只读档。
    //
    // 判据刻意不按文案（页面没钉 locale）：只比**两档菜单的集合关系**。阅读档必须是
    // 编辑档的严格子集，且不再含危险项（删除那类），同时复制项还在（别修成空菜单）。
    const openMenuOn = async (sel) => {
      await page.locator(sel).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      await rightClick(sel)
      return page.evaluate(() => ({
        items: [...document.querySelectorAll('.context-menu .context-item')].map((b) => (b.textContent ?? '').trim()),
        dangers: document.querySelectorAll('.context-menu .context-item[data-danger="true"]').length,
        sepFirst: document.querySelector('.context-menu')?.firstElementChild?.className === 'context-sep',
      }))
    }
    const setMode = async (mode) => {
      await page.locator(`.mode-opt[data-mode="${mode}"]`).click()
      await page.waitForTimeout(320)
    }
    // 正文左留白：那里不属于任何块，拿到的是「段间空白」那份菜单。
    // 必须自检落点——坐标偏一点就落在块上，那一层会静默变成「又测了一遍块菜单」。
    const openBlankMenu = async () => {
      const g = await page.evaluate(() => {
        const content = document.getElementById('content')
        content.scrollTop = 0
        const blocks = [...document.querySelectorAll('#content > .block:not(.gap)')]
        const b = blocks[1] ?? blocks[0]
        const r = b.getBoundingClientRect()
        const x = Math.round(r.left - 16)
        const y = Math.round(r.top + r.height / 2)
        const hit = document.elementFromPoint(x, y)
        return { x, y, insideBlock: !!hit?.closest('.block') }
      })
      if (g.insideBlock) return { items: [], missed: true }
      await page.mouse.click(g.x, g.y, { button: 'right' })
      await page.waitForTimeout(250)
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('.context-menu .context-item')].map((b) => (b.textContent ?? '').trim()),
      )
      return { items, missed: false }
    }
    const tableSel = '#content .block[data-kind="table"]'
    await setMode('edit')
    const tableEdit = await openMenuOn(tableSel)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const blankEdit = await openBlankMenu()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await setMode('read')
    const tableRead = await openMenuOn(tableSel)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const blankRead = await openBlankMenu()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    if (tableEdit.items.length === 0) note('warn', '编辑档右键表格没给出菜单，阅读档的分档检查是空跑')
    const leaked = tableRead.items.filter((l) => !tableEdit.items.includes(l))
    if (leaked.length > 0) {
      note('error', `阅读档的块菜单出现了编辑档没有的项：${JSON.stringify(leaked)}`)
    }
    if (tableRead.items.length >= tableEdit.items.length) {
      note('error', `阅读档块菜单没有比编辑档少（${tableRead.items.length} vs ${tableEdit.items.length}）：「编辑表格…」那类改文档的动作还在`)
    }
    if (tableRead.dangers > 0) note('error', '阅读档块菜单里还有危险项（删除本块那类）')
    if (tableRead.items.length < 3) {
      note('error', `阅读档块菜单只剩 ${tableRead.items.length} 项：复制类动作不该被一起摘掉`)
    }
    if (tableRead.sepFirst) note('error', '阅读档块菜单首项是分隔线：过滤掉首项后没清 separatorBefore')

    // 留白菜单同样分档（那里原本有「在下方插入段落」）；判据同上一律比集合，不认文案
    if (blankEdit.missed || blankRead.missed) {
      note('warn', '右键没落在正文留白上（坐标偏了），留白那一层没验到')
    } else if (blankEdit.items.length === 0) {
      note('warn', '编辑档右键留白没有菜单，这一层没验到')
    } else if (blankRead.items.length >= blankEdit.items.length) {
      note(
        'error',
        `阅读档的留白菜单没有比编辑档少（${blankRead.items.length} vs ${blankEdit.items.length}）：插入段落的入口还在`,
      )
    } else if (blankRead.items.length === 0) {
      note('error', '阅读档的留白菜单空了：复制全文那类只读动作不该被一起摘掉')
    }
    note(
      'info',
      `只读档菜单：块 ${tableEdit.items.length} → ${tableRead.items.length} 项（危险项 ${tableRead.dangers}），` +
        `留白 ${blankEdit.items.length} → ${blankRead.items.length} 项`,
    )
    await setMode('edit')

    // ── 有选区时右键，焦点不许离开正文 ──
    //
    // 焦点一走，WebKit 就不再绘制选区高亮（选区还在、⌘C 也复制得到，但用户看不到
    // 自己选了什么——而右键菜单里恰恰有「复制选中的文字」）。真机壳就是 WebKit。
    // Chromium 复现不出这个症状（它照常绘制选区），所以这里钉的是**成因**：
    // 焦点没被抢走，那条路就不会丢高亮。见 contextMenu.ts 里的说明。
    //
    // 落点必须自检：右键落在**选区之外**（含被状态栏之类的浮层盖住）时，浏览器自己
    // 就会把选区清掉，那是浏览器的行为、不是这里的缺陷；不自检的话这条会假红。
    const selProbe = await page.evaluate(() => {
      const paras = [...document.querySelectorAll('#content .block[data-kind="paragraph"] .reading-prose p')]
      for (const para of paras) {
        const node = para.firstChild
        if (!node || node.nodeType !== 3 || node.textContent.length < 6) continue
        // 先滚到视口中间再量：上一步的探测可能把正文滚到别处，落在视口外的点
        // elementFromPoint 返回 null，会被下面的自检挡掉
        para.scrollIntoView({ block: 'center' })
        const r = document.createRange()
        r.setStart(node, 0)
        r.setEnd(node, 6)
        const box = r.getBoundingClientRect()
        const x = Math.round(box.left + box.width / 2)
        const y = Math.round(box.top + box.height / 2)
        // 命中的元素必须仍在这一段正文里：否则说明点被浮层盖住或落在视口外
        if (!document.elementFromPoint(x, y)?.closest('.reading-prose')) continue
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(r)
        return { x, y, text: sel.toString() }
      }
      return null
    })
    if (!selProbe) {
      note('warn', '段落里取不到可选的文本节点，右键保选区这条没验到')
    } else {
      await page.mouse.click(selProbe.x, selProbe.y, { button: 'right' })
      await page.waitForTimeout(260)
      const after = await page.evaluate(() => ({
        active: document.activeElement?.className ?? '',
        sel: window.getSelection()?.toString() ?? '',
      }))
      if (after.active.includes('context-menu')) {
        note('error', '有选区时右键把焦点抢进了菜单：WebKit 下选区高亮会因此消失')
      }
      if (after.sel !== selProbe.text) {
        note('error', `右键后选区变了：${JSON.stringify(selProbe.text)} → ${JSON.stringify(after.sel)}`)
      }
      note('info', `有选区右键：焦点=${after.active || '(正文)'}，选区 ${after.sel.length} 字未丢`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
    }
  }

  // 3.8) 阅读主题：纸墨与标定排版必须真的上屏
  //
  // 主题是「一套纸墨 + 一套标定排版」，两者都要验：
  //   - 纸墨：body 的实际背景色随主题变（改了 data-reading-theme 但 CSS 没命中，
  //     是这一层最常见的事故——属性对了、页面没变）；
  //   - 标定排版：字号/行距/栏宽要落到 --reading-* 上（画廊说「18px · 1.9 行距」，
  //     上屏就得是 18px / 1.9）。
  {
    /** 打开浮层（已经开着就别再点——这个按钮是 toggle，无脑点会把面板关掉）。 */
    const openPop = () =>
      page.evaluate(() => {
        if (!document.querySelector('.appearance-pop')) document.getElementById('appearance-btn')?.click()
      })
    const closePop = () =>
      page.evaluate(() => {
        if (document.querySelector('.appearance-pop')) document.getElementById('appearance-btn')?.click()
      })

    const pick = async (id) => {
      await openPop()
      await page.waitForTimeout(260)
      const exists = await page.evaluate(
        (tid) => !!document.querySelector(`.theme-preview[data-reading-theme="${tid}"]`),
        id,
      )
      if (!exists) {
        await closePop()
        return null
      }
      await page.evaluate(
        (tid) => document.querySelector(`.theme-preview[data-reading-theme="${tid}"]`)?.click(),
        id,
      )
      await page.waitForTimeout(320)
      const state = await page.evaluate(() => ({
        attr: document.documentElement.dataset.readingTheme,
        paper: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim(),
        lh: getComputedStyle(document.documentElement).getPropertyValue('--reading-line-height').trim(),
        w: getComputedStyle(document.documentElement).getPropertyValue('--reading-max-w').trim(),
        selected: document.querySelector('.theme-preview[aria-pressed="true"]')?.dataset.readingTheme ?? null,
      }))
      return state
    }

    await openPop()
    await page.waitForTimeout(300)
    const cards = await page.evaluate(() => document.querySelectorAll('.theme-preview').length)
    await closePop()
    await page.waitForTimeout(200)
    if (cards < 6) note('error', `阅读主题画廊只有 ${cards} 张卡（期望 ≥6：默认 + 新增 5 款）`)

    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const manual = await pick('manual')
    if (!manual) {
      note('error', '画廊里找不到「手册」主题卡')
    } else {
      if (manual.attr !== 'manual') note('error', `点了手册主题，html[data-reading-theme] 是 ${manual.attr}`)
      if (manual.selected !== 'manual') note('error', '点了手册主题，卡片没有变成选中态')
      if (manual.paper === before) note('error', `切换主题后纸面色没变（都是 ${before}）：主题只改了属性没改纸墨`)
      if (manual.font !== '16px' || !manual.lh.startsWith('1.68') || manual.w !== '920px') {
        note('error', `手册主题的标定排版没落上屏：字号 ${manual.font} / 行距 ${manual.lh} / 栏宽 ${manual.w}`)
      }
      note('info', `手册主题：纸面 ${manual.paper}，${manual.font} · ${manual.lh} · ${manual.w}`)
    }

    const book = await pick('book')
    if (book) {
      // 「书」这个主题的价值全在排版性格：首行缩进 + 两端对齐。
      // 颜色换了而缩进没上，等于没有这个主题。
      const indent = await page.evaluate(() => {
        const p = document.querySelector('.reading-prose p')
        if (!p) return null
        const cs = getComputedStyle(p)
        return { indent: cs.textIndent, align: cs.textAlign }
      })
      if (!indent || Number.parseFloat(indent.indent) < 16) {
        note('error', `「书」主题的段落首行缩进没有生效：text-indent = ${indent ? indent.indent : '找不到段落'}`)
      }
      if (indent && indent.align !== 'justify') {
        note('error', `「书」主题的正文没有两端对齐：text-align = ${indent.align}`)
      }
      if (book.paper === before) note('error', '「书」主题的纸面色与默认相同')
    } else {
      note('error', '画廊里找不到「书」主题卡')
    }
    await closePop()
    summary.readingTheme = { manual, book }
  }

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
  // 壳与正文共用一条竖线：顶栏导航左沿 == 正文文字左沿。
  // 状态行不在这条线上——它是**窗口**的元信息，整组贴窗口右下角（见下面那两条断言）。
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
  // 状态行：内容整组贴**窗口**右下角，不再与正文列同宽同位
  // （旧规则是「左沿对齐正文、右沿对齐正文右沿」，会让同一屏出现三条较劲的竖线）。
  const winW = await page.evaluate(() => window.innerWidth)
  if (winW - edges.statusRight > 28) {
    note(
      'error',
      `状态行没有贴到窗口右下角：内容右沿 ${edges.statusRight}，窗口宽 ${winW}（差 ${winW - edges.statusRight}px）`,
    )
  }
  note('info', `状态行：内容右沿 ${edges.statusRight} / 窗口 ${winW} / 正文右沿 ${edges.textRight}`)
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
  // 整段交互都建立在「点块能进源码编辑」之上，所以加载完先切到编辑档。
  // 阅读档（默认）点块不聚焦——少了这一步，这一段会在「等 .cm-content」上超时，
  // 而报错完全指向不到真因（2026-09 就是这么坏的）。
  await page.evaluate(() => document.querySelector('.mode-opt[data-mode="edit"]')?.click())
  await page.waitForTimeout(400)

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
  await page.keyboard.press(`${MOD}+z`)
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
  await page.keyboard.press(`${MOD}+z`)
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
    await page.keyboard.press(`${MOD}+z`)
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
    await page.keyboard.press(`${MOD}+a`)
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

// ── 4) mermaid 与图片放大 ──
//
// 图默认撑满栏宽、放大后按屏幕尺寸铺开、浮层背景跟主题走。
// 这三条都只有真的渲染出 SVG、真的点开浮层才量得到，所以要换到带 mermaid 的样例。
{
  await page.goto(`${URL_ARG}?doc=mermaid`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2600)
  const mmd = await page.evaluate(() => {
    const svg = document.querySelector('.mermaid-diagram .mermaid-svg svg')
    const box = document.querySelector('.mermaid-diagram .mermaid-svg')
    const col = document.querySelector('#content .block:not(.gap)')
    if (!svg || !box || !col) return { missing: true }
    return {
      svgW: Math.round(svg.getBoundingClientRect().width),
      boxW: Math.round(box.getBoundingClientRect().width),
      colW: Math.round(col.getBoundingClientRect().width),
      // mermaid 把自然宽度写在 svg 的 inline max-width 上，用它判断「该图是否被压过」
      natural: Number.parseFloat(/max-width:\s*([\d.]+)px/.exec(svg.getAttribute('style') ?? '')?.[1] ?? '0'),
    }
  })
  if (mmd.missing) {
    note('warn', 'mermaid 样例没有渲染出图，跳过尺寸检查')
  } else {
    // 正文里的图按 mermaid 的自然尺寸渲染（与 notefast 一致），只加「不超过栏宽」的上限。
    // 所以这里不能要求「撑满栏宽」——那会把两个节点的图拉成一整屏；
    // 要验的是「不溢出栏宽」且「不是小得看不清」。
    if (mmd.boxW > mmd.colW + 2) {
      note('error', `mermaid 图溢出正文栏：svg ${mmd.svgW}px / 容器 ${mmd.boxW}px / 栏宽 ${mmd.colW}px`)
    }
    if (mmd.svgW < 120) {
      note('error', `mermaid 图小得离谱（${mmd.svgW}px）：多半是尺寸算错而不是图本身小`)
    }
    // 回归守卫：svg 的 width="100%" 需要有确定的父级宽度才有意义。
    // 曾经中间层是 flex 项（宽度 = max-content），百分比失效，838px 的流程图被浏览器
    // 退回 300px 的默认尺寸——图看着「莫名很小」，而 CSS 里查不出任何一条规则是错的。
    if (mmd.natural > mmd.colW && mmd.svgW < mmd.colW * 0.95) {
      note(
        'error',
        `宽图被压成 ${mmd.svgW}px（自然 ${mmd.natural}px > 栏宽 ${mmd.colW}px）：svg 的 width=100% 没有确定宽度可依`,
      )
    }
    await page.click('.mermaid-diagram')
    await page.waitForTimeout(500)
    const lb = await page.evaluate(() => {
      const o = document.querySelector('.lightbox')
      const st = document.querySelector('.lb-media')
      // 图表走内联 SVG（notefast 同款），位图才是 <img>
      const img = document.querySelector('.lb-media svg') ?? document.querySelector('.lb-img')
      const canvas = document.querySelector('.lb-canvas')
      if (!o || !st || !img || !canvas) return { missing: true }
      const norm = (c) => c.replace(/[ ,]+/g, ',')
      return {
        imgW: Math.round(img.getBoundingClientRect().width),
        imgH: Math.round(img.getBoundingClientRect().height),
        vw: canvas.clientWidth,
        vh: canvas.clientHeight,
        stageBg: norm(getComputedStyle(st).backgroundColor),
        paper: norm(`rgb(${getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()})`),
        readout: document.querySelector('.lb-zoom-readout')?.textContent,
        tools: document.querySelectorAll('.lb-tool').length,
      }
    })
    if (lb.missing) note('error', '点 mermaid 图没有打开放大浮层（.lb-canvas / .lb-media / .lb-img 缺一）')
    else {
      // 默认必须「适配视口」。判据是**至少一维**吃满 88% 填充率，另一维按比例即可：
      // 宽高比 4:1 的流程图适配后本来就该是「宽度铺满、高度只有两百多」——
      // 用「两维都要占一半」去卡，会把正确的适配判成失败（宽图必然不满足）。
      const fill = Math.max(lb.imgW / lb.vw, lb.imgH / lb.vh)
      if (fill < 0.85) {
        note('error', `放大后没有适配视口（最大填充率 ${fill.toFixed(2)}）：图 ${lb.imgW}×${lb.imgH}，画布 ${lb.vw}×${lb.vh}`)
      }
      if (lb.imgW > lb.vw || lb.imgH > lb.vh) {
        note('error', `放大后超出画布：图 ${lb.imgW}×${lb.imgH}，画布 ${lb.vw}×${lb.vh}`)
      }
      if (lb.stageBg !== lb.paper) {
        note('error', `放大浮层的背景没有跟主题：媒体框 ${lb.stageBg}，纸面 ${lb.paper}`)
      }
      if (lb.readout !== '100%') note('error', `打开时应是 100%（= 适配视口），读到 ${lb.readout}`)
      if (lb.tools < 3) note('error', `缩放工具条不全：只有 ${lb.tools} 个控件`)

      // 缩放 + 平移：Ctrl/⌘+滚轮改倍率，拖动改滚动位置
      const canvasBox = await page.locator('.lb-canvas').boundingBox()
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -240)
      await page.keyboard.up('Control')
      await page.waitForTimeout(300)
      const zoomed = await page.evaluate(() => ({
        readout: document.querySelector('.lb-zoom-readout')?.textContent,
        w: Math.round((document.querySelector('.lb-media svg') ?? document.querySelector('.lb-img')).getBoundingClientRect().width),
        fitVisible: !document.querySelector('.lb-tool--fit')?.hidden,
      }))
      const pct = Number.parseInt(zoomed.readout ?? '0', 10)
      if (!(pct > 100)) note('error', `Ctrl+滚轮没有放大：读数 ${zoomed.readout}`)
      if (zoomed.w <= lb.imgW) note('error', `放大后图片宽度没变：${lb.imgW} → ${zoomed.w}`)
      if (!zoomed.fitVisible) note('error', '放大后没有出现「适应窗口」按钮（回不去了）')

      const before = await page.evaluate(() => ({
        x: document.querySelector('.lb-canvas').scrollLeft,
        y: document.querySelector('.lb-canvas').scrollTop,
      }))
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(canvasBox.x + canvasBox.width / 2 - 120, canvasBox.y + canvasBox.height / 2 - 60, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      const after = await page.evaluate(() => ({
        x: document.querySelector('.lb-canvas').scrollLeft,
        y: document.querySelector('.lb-canvas').scrollTop,
        open: !document.querySelector('.lightbox')?.hidden,
      }))
      if (!after.open) note('error', '拖动之后浮层被误关了（拖动的终点不该当成「点空白」）')
      else if (after.x === before.x && after.y === before.y) {
        note('error', `拖动没有平移画布：scroll ${before.x},${before.y} 没变`)
      }

      // 复位
      await page.click('.lb-tool--fit')
      await page.waitForTimeout(250)
      const fit = await page.evaluate(() => document.querySelector('.lb-zoom-readout')?.textContent)
      if (fit !== '100%') note('error', `点「适应窗口」没回到 100%：${fit}`)
      note(
        'info',
        `mermaid：正文内 ${mmd.svgW}px（栏宽 ${mmd.colW}px）；放大后 ${lb.imgW}×${lb.imgH} 适配画布 ${lb.vw}×${lb.vh}；缩放→${zoomed.readout}→可拖动→复位`,
      )
    }
    await page.keyboard.press('Escape')
  }
  // 3.9) 查找：第几处 / 共几处 + 命中高亮 + 关掉不留痕
  //
  // 这一组守的是「读文档时最常用的工具」，三件事缺一不可：
  // 只报总数不报当前是第几处，用户不知道自己走到哪；不高亮等于让人肉眼去找；
  // 关掉后不拆标记，正文里就留下假的「高亮」。
  {
    await page.click('#find-btn')
    await page.waitForSelector('.find-bar input', { timeout: 3000 })
    // 查询词从当前文档里取（这段跑在哪个文档上不该是断言的隐含前提），
    // 取一个字保证至少有一处命中，多数字在正文里都会出现多于一处的。
    const query = await page.evaluate(() => {
      const el = document.querySelector('#content .block .reading-prose, #content .block .source-view')
      return (el?.textContent ?? '').replace(/\s+/g, '').slice(0, 1)
    })
    await page.fill('.find-bar input', query)
    await page.waitForTimeout(350)
    const opened = await page.evaluate(() => {
      const label = document.querySelector('.find-count')?.textContent ?? ''
      return {
        label,
        hits: document.querySelectorAll('mark.find-hit').length,
        current: document.querySelectorAll('mark.find-hit--current').length,
        // 「第几处」的判据：出现了当前序号，且不是只有一个数字
        hasIndex: /第\s*\d+\s*处/.test(label) || /\d+\s*(\/|of)\s*\d+/.test(label),
      }
    })
    if (opened.hits === 0) note('error', `查找没有高亮任何命中（查询词 ${JSON.stringify(query)}）`)
    else if (opened.current !== 1) note('error', `当前命中标记 ${opened.current} 个（期望恰好 1 个）`)
    if (!opened.hasIndex) note('error', `查找没报「当前是第几处」：${JSON.stringify(opened.label)}`)

    // 翻页：跳转单位是「处」而不是「块」——旧版按块跳，一个块里多处会像卡住
    await page.press('.find-bar input', 'Enter')
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => document.querySelector('.find-count')?.textContent ?? '')
    if (after === opened.label && opened.hits > 1) {
      note('error', `按 Enter 后计数没变（${opened.label}）：跳转单位可能又退回按块了`)
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const closed = await page.evaluate(() => ({
      hits: document.querySelectorAll('mark.find-hit').length,
      bar: !!document.querySelector('.find-bar'),
    }))
    if (closed.bar) note('warn', '查找栏按 Esc 没关掉，后续断言可能被遮挡')
    if (closed.hits !== 0) {
      note('error', `关掉查找后正文里还剩 ${closed.hits} 个命中标记（用户会以为文档真有高亮）`)
    }
    note('info', `查找：${opened.label} → ${after}；命中 ${opened.hits} 处，关闭后残留 ${closed.hits}`)
  }

  // 3.10) 界面缩放：整页等比（含壳），且设置里能读出当前档位
  //
  // 判据分两层，缺一层就退化：
  //   - 只放大正文 = 正文字号，不是界面缩放，所以顶栏/状态行必须跟着大；
  //   - 设置里的读数必须存在，否则用户完全看不出线停在哪一档
  //     （滑块的读数是与 root 平级的独立元素，用错行容器就会静默丢失）。
  {
    const readZoom = () =>
      page.evaluate(() => ({
        zoom: Number(getComputedStyle(document.documentElement).zoom || '1'),
        titleH: Math.round(document.getElementById('titlebar').getBoundingClientRect().height),
        statusH: Math.round(document.getElementById('statusbar').getBoundingClientRect().height),
      }))
    const z0 = await readZoom()
    await page.keyboard.press(`${MOD}+=`)
    await page.waitForTimeout(250)
    const z1 = await readZoom()
    if (!(z1.zoom > z0.zoom)) note('error', `⌘/Ctrl + = 没有放大界面：zoom ${z0.zoom} → ${z1.zoom}`)
    if (!(z1.titleH > z0.titleH && z1.statusH > z0.statusH)) {
      note(
        'error',
        `界面缩放没有作用到壳上（那只是正文字号）：顶栏 ${z0.titleH}→${z1.titleH}，状态行 ${z0.statusH}→${z1.statusH}`,
      )
    }
    await page.keyboard.press(`${MOD}+0`)
    await page.waitForTimeout(250)
    const z2 = await readZoom()
    if (Math.abs(z2.zoom - 1) > 0.001) note('error', `⌘/Ctrl + 0 没有回到 100%：${z2.zoom}`)

    await page.click('#settings-btn')
    await page.waitForTimeout(400)
    const zoomRow = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.settings-row.cell')].find(
        (r) => (r.textContent ?? '').includes('界面缩放') || (r.textContent ?? '').includes('Interface zoom'),
      )
      return row
        ? {
            value: (row.querySelector('.slider-value')?.textContent ?? '').trim(),
            label: (row.querySelector('.row-label')?.textContent ?? '').trim(),
          }
        : null
    })
    if (!zoomRow) note('error', '设置里找不到「界面缩放」这一行（可能误用了 row 而不是 cellRow 而整行丢失）')
    else if (!/%$/.test(zoomRow.value)) {
      note('error', `界面缩放的读数没有渲染：${JSON.stringify(zoomRow.value)}（slider 的 readout 是独立元素，必须用 cellRow）`)
    }

    // 分区标题的显隐：浏览时藏（左侧选中项已经写着这一节叫什么，右侧再顶一行是同一句话说两遍），
    // 搜索时露（结果跨分区，那些标题正是「这条命中属于哪一节」的答案）。
    //
    // 查询词从界面里取（「界面缩放」这一行的标签），不硬写字符串：这个脚本的页面没钉 locale，
    // 文案跟着机器语言走，写死中文会在英文环境下永远搜不到东西、把检查变成假红。
    const visibleGroups = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.settings-group')]
          .filter((s) => !s.hidden)
          .map((s) => ({
            section: s.dataset.section,
            title: (s.querySelector('.settings-group-title')?.textContent ?? '').trim(),
            titleHidden: s.querySelector('.settings-group-title')?.hidden,
          })),
      )
    const browsing = await visibleGroups()
    if (browsing.length !== 1) {
      note('warn', `常规浏览时应恰好一个分区可见，实为 ${browsing.length} 个，标题显隐检查可能不准`)
    }
    for (const g of browsing) {
      if (g.titleHidden !== true) {
        note('error', `常规浏览时分区标题「${g.title}」不该可见：它与左侧选中项重复`)
      }
    }
    const probe = (zoomRow?.label ?? '').trim().slice(0, 3) || 'zoom'
    await page.fill('.settings-search', probe)
    await page.waitForTimeout(300)
    const searching = await visibleGroups()
    if (searching.length === 0) note('error', `搜索「${probe}」没有任何分区命中`)
    for (const g of searching) {
      if (g.titleHidden !== false) {
        note('error', `搜索时分区 ${g.section} 的标题被藏了：跨分区命中要靠它说明属于哪一节`)
      }
    }
    await page.fill('.settings-search', '')
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    note(
      'info',
      `界面缩放：${z0.zoom} → ${z1.zoom} → 复位 ${z2.zoom}；设置里读数 ${zoomRow ? zoomRow.value : '缺失'}；` +
        `分区标题 浏览时藏 ${browsing.length} 个，搜「${probe}」时露 ${searching.length} 个`,
    )
  }

  // 3.11) 查找选项与正则：三个开关、危险正则被拒、**计数与高亮必须一致**
  //
  // 这一组守的是「三处匹配实现不许走偏」。计数说 6 处、只标出 4 个，
  // 是只有用户能发现的错（而且字符串模式下永远看不出来）。
  {
    await page.goto(URL_ARG, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    await page.click('#find-btn')
    await page.waitForSelector('.find-bar input', { timeout: 3000 })
    const toggles = await page.evaluate(() => document.querySelectorAll('.find-toggle').length)
    if (toggles !== 3) note('error', `查找选项开关 ${toggles} 个（期望 3：区分大小写 / 全词 / 正则）`)

    // 正则：计数与高亮数量必须相等
    await page.fill('.find-bar input', '\\d+')
    await page.evaluate(() => document.querySelector('.find-regex')?.click())
    await page.waitForTimeout(400)
    const rx = await page.evaluate(() => {
      const label = document.querySelector('.find-count')?.textContent ?? ''
      // 计数文案两种语言两种形状（「第 1 处 / 共 6 处」/「1 of 6」），
      // 所以不匹配固定句式，只取「最后一个数字 = 总数」。
      const nums = (label.match(/\d+/g) ?? []).map(Number)
      return {
        label,
        total: nums.length ? nums[nums.length - 1] : 0,
        marks: document.querySelectorAll('mark.find-hit').length,
        current: document.querySelectorAll('mark.find-hit--current').length,
      }
    })
    if (rx.total <= 0) note('error', `正则 \\d+ 没有报出命中：${JSON.stringify(rx.label)}`)
    else if (rx.total !== rx.marks) {
      note('error', `查找的计数与高亮不一致：报 ${rx.total} 处，高亮 ${rx.marks} 个`)
    }
    if (rx.current !== 1) note('error', `当前命中标记 ${rx.current} 个（期望 1 个）`)

    // 危险正则与语法错必须当场给出可读提示，而不是卡住/静默
    await page.fill('.find-bar input', '(a+)+')
    await page.waitForTimeout(350)
    const risky = await page.evaluate(() => ({
      text: document.querySelector('.find-count')?.textContent ?? '',
      marks: document.querySelectorAll('mark.find-hit').length,
    }))
    if (!/复杂|risky|danger|complex/i.test(risky.text)) note('error', `嵌套量词正则没有被拒：${JSON.stringify(risky.text)}`)
    if (risky.marks !== 0) note('error', '被拒的正则仍然标了高亮')

    await page.fill('.find-bar input', '([')
    await page.waitForTimeout(350)
    const bad = await page.evaluate(() => document.querySelector('.find-count')?.textContent ?? '')
    if (!/无效|invalid/i.test(bad)) note('error', `语法错的正则没有提示无效：${JSON.stringify(bad)}`)

    // 区分大小写：同一个词，开/关要给出不同结果
    await page.fill('.find-bar input', '')
    await page.evaluate(() => document.querySelector('.find-regex')?.click())
    await page.waitForTimeout(200)
    await page.fill('.find-bar input', 'lector')
    await page.waitForTimeout(350)
    const loose = await page.evaluate(() => document.querySelector('.find-count')?.textContent ?? '')
    await page.evaluate(() => document.querySelector('.find-case')?.click())
    await page.waitForTimeout(350)
    const strict = await page.evaluate(() => ({
      text: document.querySelector('.find-count')?.textContent ?? '',
      pressed: document.querySelector('.find-case')?.getAttribute('aria-pressed'),
    }))
    if (loose === strict.text) {
      note('warn', `区分大小写开关没有改变结果（loose=${JSON.stringify(loose)} strict=${JSON.stringify(strict.text)}）：样本文档里可能恰好没有大小写差异`)
    }
    if (strict.pressed !== 'true') note('error', '区分大小写开关没有把 aria-pressed 置为 true')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    note('info', `查找选项：${toggles} 个开关；正则 \\d+ 报 ${rx.total} 处、高亮 ${rx.marks} 个；危险/语法错均有提示`)
  }

  // 3.12) mermaid 调色板必须绑在主题 token 上
  //
  // 判据用「节点描边 == --primary 的计算值」而不是截图：这条错误是**配色不搭**，
  // 看截图只能说"感觉不对"，而计算值是硬证据。曾经它整张图走 mermaid 自带调色板
  // （浅色下 mediumpurple 描边 + #333 文字），背景跟了但整套配色没跟。
  {
    await page.goto(`${URL_ARG}?doc=mermaid`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1400)
    const pal = await page.evaluate(() => {
      const svg = document.querySelector('.mermaid-svg svg')
      const shape = svg?.querySelector('.node rect, .node polygon, .node path, rect.basic')
      const stroke = shape ? getComputedStyle(shape).stroke : ''
      const label = svg?.querySelector('.nodeLabel, .node text, text')
      const fill = label ? getComputedStyle(label).fill : ''
      const token = (n) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim()
        return v ? `rgb(${v.split(/\s+/).join(', ')})` : ''
      }
      return { stroke, fill, primary: token('--primary'), fg: token('--foreground') }
    })
    if (!pal.stroke) note('warn', 'mermaid 图里没找到节点形状，跳过调色板检查')
    else {
      if (pal.stroke.startsWith('rgb') && pal.stroke !== pal.primary) {
        note('error', `mermaid 节点描边 ${pal.stroke} ≠ 主题 --primary ${pal.primary}（调色板又回到 mermaid 自带了）`)
      }
      if (pal.fill.startsWith('rgb') && pal.fill !== pal.fg) {
        note('error', `mermaid 节点文字 ${pal.fill} ≠ 主题 --foreground ${pal.fg}`)
      }
    }
    note('info', `mermaid 配色：描边 ${pal.stroke || '—'} / 文字 ${pal.fill || '—'}（主题 primary ${pal.primary}，foreground ${pal.fg}）`)
  }

  // 3.13) 表格数字列右对齐
  {
    await page.goto(URL_ARG, { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    const cell = await page.evaluate(() => {
      const td = document.querySelector(".reading-prose td[data-align='right']")
      if (!td) return { missing: true, total: document.querySelectorAll('.reading-prose td').length }
      return { align: getComputedStyle(td).textAlign, text: (td.textContent ?? '').trim() }
    })
    if (cell.missing) {
      note('warn', `样本文档里没有数字单元格（共 ${cell.total} 个 td），跳过右对齐检查`)
    } else if (cell.align !== 'right') {
      note('error', `数字单元格 data-align 是 right，但计算样式是 ${cell.align}`)
    } else {
      note('info', `表格数字列右对齐生效：「${cell.text}」text-align=${cell.align}`)
    }
  }

  // 3.14) 空态的「最近打开」
  {
    await page.addInitScript(() => {
      window.__lectorTestRecent = [
        '/Users/beta/docs/设计语言单一真相源.md',
        '/Users/beta/notes/lector-优化清单.md',
      ]
    })
    await page.goto(`${URL_ARG}?doc=empty`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    const recent = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.recent-item')]
      return {
        label: document.querySelector('.recent-label')?.textContent ?? '',
        count: items.length,
        names: items.map((i) => i.querySelector('.recent-name')?.textContent ?? ''),
        dirs: items.map((i) => i.querySelector('.recent-dir')?.textContent ?? ''),
        hasPath: items.every((i) => !!i.dataset.path),
      }
    })
    if (recent.count !== 2) note('error', `空态「最近打开」应有 2 条，实际 ${recent.count}（注入缝失效？）`)
    if (!recent.names[0]?.includes('设计语言')) note('error', `最近打开第一条文件名不对：${JSON.stringify(recent.names)}`)
    if (!recent.dirs[0]?.includes('docs')) note('error', `最近打开没有显示所在目录：${JSON.stringify(recent.dirs)}`)
    if (!recent.hasPath) note('error', '最近打开条目没有带路径（点了不知道开哪个）')

    // 点一条不存在的路径：必须给出可读提示，而不是静默什么都不发生
    if (recent.count > 0) {
      await page.locator('.recent-item').first().click()
      await page.waitForTimeout(700)
      const toast = await page.evaluate(() => document.body.textContent ?? '')
      if (!/打开失败|Could not open/.test(toast)) {
        note('error', '点了打不开的最近文件后没有任何提示（静默失败）')
      }
    }
    note('info', `最近打开：${recent.count} 条，首条「${recent.names[0] ?? '—'}」目录「${recent.dirs[0] ?? '—'}」`)
  }

  // 3.15) 空文档必须能直接打字
  //
  // 用户看到的问题是"打开一个空的 .md 却打不了字"——空文档表现成了"没打开文件"。
  // 判据不能只看块数（不同版本可能产出 0 块或 1 个空块），要看**有没有落点**：
  // 进了编辑档、有块内编辑器、光标在里面，三者缺一都还是打不了字。
  {
    await page.goto(URL_ARG + '?doc=blank', { waitUntil: 'load' })
    await page.waitForTimeout(1300)
    const blank = await page.evaluate(() => ({
      mode: document.documentElement.dataset.mode,
      cms: document.querySelectorAll('.cm-content').length,
      focused: !!document.activeElement?.closest?.('.cm-content'),
    }))
    if (blank.mode !== 'edit') note('error', `打开空文档没有进编辑档：${blank.mode}`)
    if (blank.cms < 1) note('error', '空文档里没有块内编辑器（表现成了"没打开文件"）')
    else if (!blank.focused) note('error', '空文档的编辑器没有聚焦：光标没进去，用户看不出能打字')
    else {
      await page.keyboard.type('空白文档')
      await page.waitForTimeout(350)
      const ok = await page.evaluate(() => document.querySelector('#content')?.textContent?.includes('空白文档'))
      if (!ok) note('error', '空文档里打字没有写进正文')
    }
    await page.goto(URL_ARG, { waitUntil: 'load' })
    await page.waitForTimeout(600)
  }

  // 3.16) 空态「新建」：必须得到一份能立刻打字的空文档
  //
  // 这条守的是"用户打开应用想创建、却创建不了"。只看按钮在不在不够——
  // 新建出来必须是**可写文档**：编辑档 + 块内编辑器 + 光标在里面，三者缺一都算失败。
  {
    await page.goto(URL_ARG + '?doc=empty', { waitUntil: 'load' })
    await page.waitForTimeout(900)
    const hasNew = await page.evaluate(() => !!document.querySelector('.empty-new'))
    if (!hasNew) note('error', '空态没有「新建」入口（记事本能新建，只支持打开说不过去）')
    else {
      await page.click('.empty-new')
      await page.waitForTimeout(900)
      const made = await page.evaluate(() => ({
        mode: document.documentElement.dataset.mode,
        cms: document.querySelectorAll('.cm-content').length,
        focused: !!document.activeElement?.closest?.('.cm-content'),
        title: document.getElementById('file-name')?.textContent ?? '',
      }))
      if (made.mode !== 'edit' || made.cms < 1 || !made.focused) {
        note('error', `新建出来的不是可写文档：mode=${made.mode} cms=${made.cms} focused=${made.focused}`)
      } else if (!made.title) note('error', '新建文档标题栏是空的（应当显示「未命名」一类占位名）')
      else note('info', `新建：标题「${made.title}」、编辑档、光标入位`)
    }
    await page.goto(URL_ARG, { waitUntil: 'load' })
    await page.waitForTimeout(600)
  }
  // 3.17) 大文件模式：必须打得开、可编辑（整篇进一个裸 CM）、不建块
  //
  // 用户的原始反馈是"30M/73 万行永远停在 Loading"。旧方案是只读代码块预览；
  // 现在改成整篇裸 CM6（自带视口虚拟化），所以判据是：**有提示条**、**挂了 CM**、
  // **没建块**、**档位锁在源码档**、**耗时**（超过 15 秒就等同于打不开）。
  {
    const started = Date.now()
    await page.goto(URL_ARG + '?doc=huge', { waitUntil: 'load' })
    await page.waitForSelector('.large-file-bar', { timeout: 20000 }).catch(() => {})
    const ms = Date.now() - started
    const lf = await page.evaluate(() => ({
      bar: !!document.querySelector('.large-file-bar'),
      mode: document.documentElement.dataset.mode,
      blocks: document.querySelectorAll('#content .block').length,
      cm: !!document.querySelector('.large-doc-host .cm-editor'),
      // CM 视口虚拟化：DOM 里的行数应远小于全文行数
      renderedLines: document.querySelectorAll('.large-doc-host .cm-line').length,
    }))
    if (!lf.bar) note('error', '大文件没有进入大文件模式（无提示条）：说明整篇解析了，大文档会卡死')
    if (!lf.cm) note('error', '大文件模式没有挂上可编辑的 CodeMirror（应当整篇进裸 CM）')
    if (lf.mode !== 'source') note('error', `大文件档位应为 source，实为 ${lf.mode}`)
    if (lf.blocks > 0) note('error', `大文件模式仍建了 ${lf.blocks} 个块（应当不建块）`)
    if (ms > 15000) note('error', `大文件打开耗时 ${ms}ms（超过 15s 等同于打不开）`)
    else note('info', `大文件：${ms}ms、mode=${lf.mode}、CM=${lf.cm}、DOM 行 ${lf.renderedLines}`)
    await page.goto(URL_ARG, { waitUntil: 'load' })
    await page.waitForTimeout(500)
  }

  // 3.18) 键盘面板：键位有地方可查；且提示语里不再夹带快捷键
  //
  // 两件事一起守：**提示语**只描述按钮做什么（快捷键不属于它的语义），
  // **面板**提供唯一可查的键位清单。只做前者会让用户无处可查，只做后者会留下双份真相。
  {
    const tipsWithKeys = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tip]')]
        .map((el) => el.dataset.tip ?? '')
        .filter((s) => /[⌘⇧]|Ctrl\+|Cmd\+/.test(s)),
    )
    if (tipsWithKeys.length > 0) note('error', `提示语里仍夹带快捷键：${tipsWithKeys.join(' / ')}`)
    await page.click('#keyboard-btn')
    await page.waitForTimeout(400)
    const panel = await page.evaluate(() => ({
      // 键位面板是悬浮卡（.shortcuts-pop），不是模态（.modal-backdrop）：
      // 查键位是「看一眼就走」，不该遮正文
      open: !!document.querySelector('.shortcuts-pop'),
      notModal: !document.querySelector('.modal-backdrop .shortcuts-card'),
      rows: document.querySelectorAll('.shortcut-row').length,
      keys: [...document.querySelectorAll('.shortcut-keys')].map((k) => k.textContent ?? '').slice(0, 3),
    }))
    if (!panel.open) note('error', '键盘图标点了没有打开键位面板')
    else if (!panel.notModal) note('error', '键位面板变成了模态弹窗（应为悬浮卡）')
    else if (panel.rows < 8) note('error', `键位面板只列了 ${panel.rows} 条（太少，用户查不到）`)
    else note('info', `键盘面板：${panel.rows} 条，首列 ${panel.keys.join(' / ')}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }

  // 3.19) 空态不该有"凭空"的滚动条
  //
  // 用户的原始描述："明明看起来很空，却有右侧滚动条，太丑"。根因是空态用 min-height
  // 撑高度（62vh）+ 固定 padding，窗口一矮就超出容器。判据直接量：**空态的滚动高度
  // 不得超过可视高度**，而不是去核对某条 CSS 的值（值会被后来的人改）。
  {
    await page.setViewportSize({ width: 1200, height: 700 })
    await page.addInitScript(() => {
      window.__lectorTestRecent = ['/docs/a.md', '/docs/b.md', '/docs/c.md']
    })
    await page.goto(URL_ARG + '?doc=empty', { waitUntil: 'load' })
    await page.waitForTimeout(900)
    const fit = await page.evaluate(() => {
      const el = document.getElementById('content')
      return el ? { scroll: el.scrollHeight, client: el.clientHeight } : null
    })
    if (!fit) note('error', '空态找不到正文容器')
    else if (fit.scroll > fit.client + 1) note('error', `空态出现滚动条：${fit.scroll}px / 可视 ${fit.client}px`)
    else note('info', `空态无多余滚动条：${fit.scroll}px / ${fit.client}px`)
    await page.setViewportSize({ width: 1200, height: 820 })
    await page.waitForTimeout(200)
  }
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
