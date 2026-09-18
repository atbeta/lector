// 两条行为断言（都是用户报过的）：
//   1. 滚动正文时，大纲里当前那一项必须自动滚进侧栏可视区——高亮跑出屏幕外等于没在指示位置；
//   2. 阅读档左键点图片 → 直接全屏看原图（与 mermaid 一致）；编辑档才给动作菜单。
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

  await browser.close()
  for (const e of errors) console.log(`ERROR ${e}`)
  console.log(`${errors.length} error`)
  process.exit(errors.length === 0 ? 0 : 1)
}

await main()
