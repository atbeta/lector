// 撤销可达性回归：焦点离开编辑块之后，⌘Z / ⌘⇧Z 仍然要能撤到「刚编辑过的那块」。
//
// 挡的是两条真实存在过、用户会直接撞上的线：
//   1. 在 A 块打字 → 点 B 块 → ⌘Z：**什么都不发生**。撤销史按块存在 blockHistory，
//      块失焦后 CM 被销毁，能驱动它的只有 map 里那份 state——而全局入口只看
//      「当前有没有聚焦块」，于是那份历史再也没人够得到。
//   2. 打字 → Esc 退出编辑 → ⌘Z：同上，而且连提示都没有，用户只会以为键盘坏了。
//
// 还有一个同样重要的断言：**撤销落空时必须有回执**。静默的空操作比报错更伤，
// 用户按了键、界面纹丝不动，只会认为软件坏了。
//
// 用法：先起 Vite（端口 5199），再 `node tools/undo-focus-verify.mjs http://localhost:5199/`

import { launchBrowser, exitSkipped } from './browser.mjs'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let errors = 0
const fail = (msg) => {
  errors++
  console.log(`ERROR ${msg}`)
}
const info = (msg) => console.log(`INFO  ${msg}`)

const browser = await launchBrowser()
if (!browser) exitSkipped('撤销可达性回归', process.argv.includes('--strict'))
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

const hasText = (mark) =>
  page.evaluate((m) => (document.getElementById('content')?.innerText ?? '').includes(m), mark)

/** 当前可见的 toast 文案（没有则 null）。 */
const toastText = () =>
  page.evaluate(() => {
    const el = document.getElementById('lector-toast')
    return el && el.classList.contains('show') ? (el.textContent ?? '').trim() : null
  })

/** 重新载入到干净状态，切编辑档，返回段落块定位器。 */
async function fresh() {
  await page.goto(URL_ARG, { waitUntil: 'load' })
  await page.waitForSelector('#content > .block:not(.gap)', { timeout: 15000 })
  await page.click('button[data-mode=edit]')
  await page.waitForTimeout(300)
  return page.locator('#content .block[data-kind=paragraph]')
}

/** 聚焦第 n 个段落块并把光标放到块末，然后打字。 */
async function typeIn(paras, n, mark) {
  const count = await paras.count()
  if (count <= n) throw new Error(`段落块不足：${count}`)
  await paras.nth(n).click()
  await page.waitForTimeout(300)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(mark)
  await page.waitForTimeout(300)
}

try {
  // ── 1. 点去别的块之后，⌘Z 要撤得到 ──
  {
    const paras = await fresh()
    const mark = 'UNDOA'
    await typeIn(paras, 1, mark)
    if (!(await hasText(mark))) fail('用例 1：打字没进正文，用例本身没跑起来')
    await paras.nth(3).click()
    await page.waitForTimeout(400)
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(600)
    if (await hasText(mark)) {
      fail('点去别的块后 ⌘Z 没撤掉刚打的字（撤销在块失焦后变成死键）')
    } else {
      info('点去别的块后 ⌘Z 仍可撤销')
    }
  }

  // ── 2. Esc 退出编辑之后，⌘Z 要撤得到 ──
  {
    const paras = await fresh()
    const mark = 'UNDOB'
    await typeIn(paras, 1, mark)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(450)
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(600)
    if (await hasText(mark)) {
      fail('Esc 退出编辑后 ⌘Z 没撤掉刚打的字')
    } else {
      info('Esc 退出编辑后 ⌘Z 仍可撤销')
    }
  }

  // ── 3. 撤销之后焦点在别处，⌘⇧Z 要能重做回来 ──
  {
    const paras = await fresh()
    const mark = 'REDOC'
    await typeIn(paras, 1, mark)
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(450)
    if (await hasText(mark)) fail('用例 3：撤销没生效，重做验不出来')
    await paras.nth(3).click()
    await page.waitForTimeout(400)
    await page.keyboard.press(`${MOD}+Shift+Z`)
    await page.waitForTimeout(600)
    if (!(await hasText(mark))) {
      fail('撤销后焦点在别的块上，⌘⇧Z 没把内容重做回来')
    } else {
      info('焦点在别的块上 ⌘⇧Z 仍可重做')
    }
  }

  // ── 4. 无可撤销时必须有回执（静默空操作是最伤的一种）──
  {
    await fresh()
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(500)
    const toast = await toastText()
    if (!toast) fail('无可撤销的操作时按 ⌘Z，界面没有任何回执')
    else info(`空撤销有回执：「${toast}」`)
  }

  // ── 5. 无可重做时也要有回执 ──
  {
    await fresh()
    await page.keyboard.press(`${MOD}+Shift+Z`)
    await page.waitForTimeout(500)
    const toast = await toastText()
    if (!toast) fail('无可重做的操作时按 ⌘⇧Z，界面没有任何回执')
    else info(`空重做有回执：「${toast}」`)
  }

  // ── 6. 回归：块内正常的撤销 / 重做不能被上面的路由弄坏 ──
  {
    const paras = await fresh()
    const mark = 'REGRD'
    await typeIn(paras, 1, mark)
    await page.keyboard.press(`${MOD}+z`)
    await page.waitForTimeout(450)
    const undone = !(await hasText(mark))
    await page.keyboard.press(`${MOD}+Shift+Z`)
    await page.waitForTimeout(450)
    const redone = await hasText(mark)
    if (!undone) fail('块内 ⌘Z 失效了')
    else if (!redone) fail('块内 ⌘⇧Z 失效了')
    else info('块内撤销 / 重做不受影响')
  }
} catch (e) {
  fail(`用例异常：${e.message}`)
}

if (pageErrors.length) fail(`页面报错：${pageErrors.join(' | ')}`)
await browser.close()

if (errors) {
  console.error(`\n撤销可达性回归：${errors} 处失败`)
  process.exit(1)
}
console.log('撤销可达性回归：通过')
