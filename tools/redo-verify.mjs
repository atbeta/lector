// 重做回归：⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y 在三种承载里都要能把撤销过的内容放回来。
//
// 挡的是一条真实发生过、且**只在某个平台上失效**的线：
// `redoFallback` 原来在 CM 重做栈非空时 `return false` 让位，指望 historyKeymap
// 接走。而 historyKeymap 的重做键是平台分表的——
//   mac   : Mod-Shift-z 与 Mod-y（mac 独家）
//   linux : Ctrl-Shift-z
//   win   : 只有 Ctrl+Y（**没有** Ctrl+Shift+Z）
// 于是 Windows 上撤销之后按 Ctrl+Shift+Z 一个字都不回来，mac 上一切正常，
// 服务器（Linux）上这条也查不出来。所以这里三个平台键位都按，
// 断言只看「文字有没有回来」，不看实现。
//
// 用法：先起 Vite（端口 5199），再 `node tools/redo-verify.mjs http://localhost:5199/`

import { launchBrowser, exitSkipped } from './browser.mjs'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const IS_MAC = process.platform === 'darwin'
const MOD = IS_MAC ? 'Meta' : 'Control'

// 三条重做键位。mac 上 Ctrl+* 是 CM defaultKeymap 的光标键（Ctrl-z 是别的意思），
// 所以在 mac 上只按 Meta 组合；非 mac 上 Meta 不存在，只按 Control 组合。
const REDO_KEYS = IS_MAC
  ? [{ keys: 'Meta+Shift+Z', why: '⌘⇧Z（historyKeymap 只在 mac 注册这条）' }]
  : [
      { keys: 'Control+Shift+Z', why: 'Ctrl+Shift+Z（Windows 上 historyKeymap 没有这条）' },
      { keys: 'Control+y', why: 'Ctrl+Y（各平台通例）' },
    ]

let errors = 0
const fail = (msg) => {
  errors++
  console.log(`ERROR ${msg}`)
}
const info = (msg) => console.log(`INFO  ${msg}`)

const browser = await launchBrowser()
if (!browser) exitSkipped('重做回归', process.argv.includes('--strict'))
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

/** 正文里有没有这段字。看 innerText 而不是 .cm-line 拼：CM 只渲染视口内的行。 */
const hasText = (mark) =>
  page.evaluate((m) => (document.getElementById('content')?.innerText ?? '').includes(m), mark)

/** 进入编辑档，聚焦第 n 个段落块，光标放到块末。 */
async function focusParagraph(n = 1) {
  await page.click('button[data-mode=edit]')
  await page.waitForTimeout(250)
  const paras = page.locator('#content .block[data-kind=paragraph]')
  const count = await paras.count()
  if (count <= n) throw new Error(`样例里段落块不够：${count}`)
  await paras.nth(n).click()
  await page.waitForTimeout(250)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('End')
}

/**
 * 一轮完整往返：打字 → （可选 afterType）→ 撤销 → 重做。
 * 每一轮都重新载入，避免前面几轮的聚焦块 / 历史互相影响。
 *
 * afterType 在**打完字之后、撤销之前**跑：像「把焦点移出 CM」这种准备动作
 * 必须发生在文字已经落进块里之后，否则字打进了空处、用例自己先空跑。
 */
async function roundTrip(label, redoKey, prepare, afterType) {
  await page.goto(URL_ARG, { waitUntil: 'load' })
  await page.waitForSelector('#content > .block:not(.gap)', { timeout: 15000 })
  const mark = `RDO${Math.random().toString(36).slice(2, 6).toUpperCase()}`

  await prepare()
  await page.keyboard.type(mark)
  await page.waitForTimeout(250)
  if (!(await hasText(mark))) return fail(`${label}：打字后正文里就没有 ${mark}（用例本身没跑起来）`)
  if (afterType) await afterType()

  await page.keyboard.press(`${MOD}+z`)
  await page.waitForTimeout(350)
  if (await hasText(mark)) return fail(`${label}：⌘Z / Ctrl+Z 没撤掉 ${mark}（撤销先坏了，重做验不出来）`)

  await page.keyboard.press(redoKey.keys)
  await page.waitForTimeout(400)
  if (!(await hasText(mark))) return fail(`${label}：${redoKey.keys} 没把内容放回来 —— ${redoKey.why}`)
  info(`${label}：${redoKey.keys} 重做成功`)
}

try {
  // ── 1. 块档：聚焦块里的文字重做 ──
  for (const key of REDO_KEYS) {
    await roundTrip('块档（聚焦块内打字）', key, () => focusParagraph(1))
  }

  // ── 2. 源码档：整篇一个 CM ──
  for (const key of REDO_KEYS) {
    await roundTrip('源码档（整篇 CM）', key, async () => {
      await page.keyboard.press(`${MOD}+3`)
      await page.waitForTimeout(700)
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('End')
    })
  }

  // ── 3. 焦点不在 CM 里时，全局 ⌘⇧Z 也要能重做 ──
  // 打完字后把焦点移出 CM（焦点落到 body，块仍是聚焦块），再撤销 / 重做。
  // 这条路走的是 appBindings 的全局分支，不是 CM 的 keymap——
  // 它和块内那条是两份实现，漏一份就是「块里能重做、点一下别处就不能」。
  for (const key of REDO_KEYS) {
    await roundTrip(
      '块档（焦点离开 CM 后全局重做）',
      key,
      () => focusParagraph(1),
      async () => {
        await page.evaluate(() => document.activeElement?.blur())
        await page.waitForTimeout(150)
      },
    )
  }

  // ── 4. 重做键在**没有**可重做内容时不该改动正文 ──
  for (const key of REDO_KEYS) {
    await page.goto(URL_ARG, { waitUntil: 'load' })
    await page.waitForSelector('#content > .block:not(.gap)', { timeout: 15000 })
    await focusParagraph(1)
    const before = await page.evaluate(() => document.getElementById('content')?.innerText ?? '')
    await page.keyboard.press(key.keys)
    await page.waitForTimeout(350)
    const after = await page.evaluate(() => document.getElementById('content')?.innerText ?? '')
    if (before !== after) fail(`${key.keys} 在无可重做时改动了正文`)
  }
  info('无可重做时按重做键不改动正文')
} catch (e) {
  fail(`用例异常：${e.message}`)
}

if (pageErrors.length) fail(`页面报错：${pageErrors.join(' | ')}`)
await browser.close()

if (errors) {
  console.error(`\n重做回归：${errors} 处失败`)
  process.exit(1)
}
console.log('重做回归：通过')
