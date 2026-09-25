// 行为断言（前两条都是用户报过的）：
//   1. 滚动正文时，大纲里当前那一项必须自动滚进侧栏可视区——高亮跑出屏幕外等于没在指示位置；
//   2. 阅读档左键点图片 → 直接全屏看原图（与 mermaid 一致）；编辑档才给动作菜单。
//   3. 图片反馈态：lector-upload:// 占位渲成 .img-pending；加载失败的图拿 .img-broken + 原始地址悬浮。
//   4. 拖放 overlay 有文案且分类型（图片=插入）；空态拖图片时文案变「请先打开文件」。
//
// 判定一律按"能否滚/是否在可视区"这类几何事实，不按类名（类名会被重构改掉）。
import { chromium } from 'playwright'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const errors = []

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 640 }, locale: 'zh-CN' })

  // ——— 1. 大纲跟随阅读位置 ———
  await page.goto(`${URL_ARG}?doc=long`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  const w0 = await page.evaluate(() => document.getElementById('sidebar')?.getBoundingClientRect().width ?? 0)
  if (w0 < 100) {
    await page.click('#outline-btn')
    await page.waitForTimeout(400)
  }
  await page.evaluate(() => {
    const c = document.getElementById('content')
    if (c) c.scrollTop = c.scrollHeight * 0.75
  })
  await page.waitForTimeout(700)
  const outline = await page.evaluate(() => {
    const row = document.querySelector('.outline-row.active')
    if (!row) return { err: '没有 active 的大纲项' }
    const r = row.getBoundingClientRect()
    if (r.height === 0) return { err: 'active 项高度为 0（侧栏没展开）' }
    let box = row.parentElement
    while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 2)) box = box.parentElement
    const b = (box ?? document.body).getBoundingClientRect()
    return {
      text: (row.textContent ?? '').slice(0, 10),
      inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
      row: [Math.round(r.top), Math.round(r.bottom)],
      box: [Math.round(b.top), Math.round(b.bottom)],
    }
  })
  if (outline.err) errors.push(`大纲跟随：${outline.err}`)
  else if (!outline.inside) errors.push(`滚动后大纲当前项跑出可视区：行 ${outline.row} / 容器 ${outline.box}`)
  else console.log(`INFO  大纲跟随：当前项「${outline.text}」在可视区内 行 ${outline.row} / 容器 ${outline.box}`)

  // ——— 2. 阅读档点图片 → 全屏 ———
  await page.goto(`${URL_ARG}?doc=media`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => document.querySelector('.reading-prose img')?.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(450)
  await page.click('.reading-prose img')
  await page.waitForTimeout(500)
  const img = await page.evaluate(() => ({
    lightbox: document.documentElement.classList.contains('lightbox-open'),
    menu: !!document.querySelector('.context-menu'),
    mode: document.documentElement.dataset.mode,
  }))
  if (img.mode !== 'read') errors.push(`点图片时不在阅读档（mode=${img.mode}），这条断言的前提不成立`)
  else if (!img.lightbox) errors.push('阅读档左键点图片没有打开全屏（应当和 mermaid 一致）')
  else if (img.menu) errors.push('阅读档左键点图片弹出了动作菜单（那是编辑档的行为）')
  else console.log('INFO  图片：阅读档左键 → 全屏 ✓ 且未弹菜单')

  // ——— 3. 图片反馈态：上传中占位 + 破图弱化框 ———
  await page.goto(`${URL_ARG}?doc=media`, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const states = await page.evaluate(() => {
    const pending = document.querySelector('.reading-prose .img-pending')
    const broken = document.querySelector('.reading-prose img.img-broken')
    return {
      pending: !!pending,
      pendingText: (pending?.textContent ?? '').trim(),
      broken: !!broken,
      brokenTip: broken?.getAttribute('data-tip') ?? '',
    }
  })
  if (!states.pending) errors.push('上传中占位：lector-upload:// 没有渲染成 .img-pending')
  else if (!states.pendingText) errors.push('上传中占位：占位框没有文案')
  else console.log(`INFO  上传中占位：渲染为「${states.pendingText}」✓`)
  if (!states.broken) errors.push('破图态：不存在的图片没有拿到 .img-broken（onerror 委托没生效）')
  else if (!states.brokenTip.includes('no-such-file.png')) errors.push(`破图态：data-tip 没带原始地址（${states.brokenTip}）`)
  else console.log('INFO  破图态：弱化框 ✓ 悬浮给出原始地址 ✓')

  // ——— 4. 拖放 overlay：按拖的东西给文案；空态拖图片与结果一致 ———
  const dragImageOverlay = () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const el = document.querySelector('.drop-overlay')
    const text = (el?.querySelector('.drop-overlay-text')?.textContent ?? '').trim()
    window.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
    return { shown: !!el, text, goneAfterLeave: !document.querySelector('.drop-overlay') }
  }
  const overlay = await page.evaluate(dragImageOverlay)
  if (!overlay.shown) errors.push('拖放 overlay：拖图片时没有亮出提示框')
  else if (!overlay.text.includes('插入图片')) errors.push(`拖放 overlay：文案没有区分「插入图片」（实际「${overlay.text}」）`)
  else if (!overlay.goneAfterLeave) errors.push('拖放 overlay：dragleave 后没有撤掉')
  else console.log(`INFO  拖放 overlay：文案「${overlay.text}」✓ 离开即撤 ✓`)

  await page.goto(`${URL_ARG}?doc=empty`, { waitUntil: 'load' })
  await page.waitForTimeout(800)
  const emptyOverlay = await page.evaluate(dragImageOverlay)
  if (!emptyOverlay.shown) errors.push('空态拖放 overlay：拖图片时没有亮出提示框')
  else if (!emptyOverlay.text.includes('打开文件')) errors.push(`空态拖放 overlay：文案没有变成「请先打开文件」（实际「${emptyOverlay.text}」）`)
  else console.log(`INFO  空态拖放 overlay：文案「${emptyOverlay.text}」✓`)

  await browser.close()
  for (const e of errors) console.log(`ERROR ${e}`)
  console.log(`${errors.length} error`)
  process.exit(errors.length === 0 ? 0 : 1)
}

await main()
