import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://127.0.0.1:5478/')
await page.waitForSelector('.block')
await page.waitForTimeout(500)

// #14 精确验证：同一 li 的勾选态翻转
const task = await page.evaluate(async () => {
  const li = document.querySelector('.preview li.task')
  const box = li.querySelector('input[type=checkbox]')
  const was = box.checked
  box.click()
  await new Promise((r) => setTimeout(r, 300))
  const now = document.querySelector('.preview li.task input[type=checkbox]').checked
  const dirty = document.documentElement.classList.contains('dirty')
  return { was, now, flipped: was !== now, dirty }
})

// #10：新建空文档 → 打字 → 删这一块 → 应变空段且仍聚焦可编辑，不是消失
await page.click('.empty-open', { force: true }).catch(() => {})
const r2 = await page.evaluate(async () => {
  // 直接走「新建」按钮
  document.querySelector('.empty-new')?.click()
  await new Promise((r) => setTimeout(r, 400))
  const cm = document.querySelector('.cm-host .cm-content')
  if (!cm) return { step: 'no-cm' }
  return { step: 'focused-empty' }
})
// 在 CM 里打字
await page.keyboard.type('hello world')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const blocks1 = await page.locator('.block:not(.gap)').count()
// 右键这一块 → 删除本块
await page.locator('.block:not(.gap)').first().click({ button: 'right', force: true })
await page.waitForTimeout(200)
const del = page.locator('button:has-text("删除本块"), button:has-text("Delete block")')
const hasDel = await del.count()
if (hasDel) await del.first().click()
await page.waitForTimeout(300)
const after = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.block:not(.gap)').length,
  focusedEditable: !!document.querySelector('.block.focused .cm-host'),
  text: document.querySelector('.block:not(.gap)')?.textContent ?? null,
}))

console.log(JSON.stringify({ task, r2, blocks1, hasDel, after }, null, 1))
await browser.close()
