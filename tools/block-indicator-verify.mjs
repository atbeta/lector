// 块指示器回归：左缘轨道 + 把手 + 聚焦描边。
//
// 为什么要单独一份：这三样都是「给块加 DOM 子节点」，而块内容是每轮渲染
// `replaceChildren` 重造的。这里挡的正是那条最脆的线——指示器会不会被清掉、
// 会不会在只读档冒出来、点把手会不会顺手把块聚焦了。
//
// 用法：先起 Vite（端口 5199），再 `node tools/block-indicator-verify.mjs http://localhost:5199/`
import assert from 'node:assert/strict'
import { launchBrowser, exitSkipped } from './browser.mjs'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const SHOT_DIR = process.env.SHOT_DIR ?? ''

// 没有浏览器就跳过：这些脚本量的是真实渲染，服务器上跑不了是常态。
const browser = await launchBrowser()
if (!browser) exitSkipped('渲染层验证', process.argv.includes('--strict'))
// 钉住界面语言：菜单项断言要读标签，跟着机器语言飘会让这条检查时红时绿。
const page = await browser.newPage({
  viewport: { width: 1360, height: 900 },
  locale: 'zh-CN',
  // 明暗是 token 的两套值，断言里写了具体颜色，就得钉住它
  colorScheme: 'light',
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const railOpacity = (sel) =>
  page.$eval(sel, (el) => Number(getComputedStyle(el.querySelector('.block-rail')).opacity))
const handleDisplay = (sel) =>
  page.$eval(sel, (el) => getComputedStyle(el.querySelector('.block-handle')).display)
const railDisplay = (sel) =>
  page.$eval(sel, (el) => getComputedStyle(el.querySelector('.block-rail')).display)

await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block:not(.gap)', { timeout: 15000 })

// ── 1. 每个内容块都有指示器，段间空白缝没有 ──
const counts = await page.evaluate(() => {
  const content = [...document.querySelectorAll('#content > .block:not(.gap)')]
  return {
    blocks: content.length,
    // unknown 是解析不出内容的降级块，它没有块菜单，因此也不该长把手
    menuBlocks: content.filter((b) => b.dataset.kind !== 'unknown').length,
    rails: content.filter((b) => b.querySelector(':scope > .block-rail')).length,
    handles: content.filter((b) => b.querySelector(':scope > .block-handle')).length,
    gaps: document.querySelectorAll('#content > .block.gap').length,
    strayRails: document.querySelectorAll('#content > .block.gap > .block-rail').length,
    strayHandles: document.querySelectorAll('#content > .block.gap > .block-handle').length,
  }
})
assert.ok(counts.blocks > 3, `样例块太少，验不出东西：${counts.blocks}`)
assert.equal(counts.rails, counts.blocks, '每个内容块都该有一条轨道')
assert.equal(counts.handles, counts.menuBlocks, '把手只该长在有块菜单的块上')
assert.equal(counts.strayRails, 0, '段间空白缝不该有轨道')
assert.equal(counts.strayHandles, 0, '段间空白缝不该有把手')
assert.ok(counts.gaps > 0, '默认样例应当含段间空白缝，否则这条断言是空跑')

// ── 2. 只读档：轨道在、把手不在 ──
// 「只读的阅读面上不放可点的控件」是产品决定，不是样式细节，所以钉在这里。
const list = '#content > .block[data-kind="list"]'
assert.equal(await page.getAttribute('html', 'data-mode'), 'read')
assert.equal(await handleDisplay('#content > .block:not(.gap)'), 'none', '只读档不该出现块把手')
assert.equal(await railDisplay(list), 'block', '只读档的边界只能靠轨道说')
assert.equal(await railOpacity(list), 0, '没悬停时轨道应当不可见')

await page.hover(list)
await page.waitForTimeout(400)
assert.equal(await railOpacity(list), 1, '只读档悬停应当出现轨道')
const readHoverBg = await page.$eval(list, (el) => getComputedStyle(el).backgroundColor)
assert.equal(readHoverBg, 'rgba(0, 0, 0, 0)', '只读档悬停仍不该有衬底（原来的决定不能被带坏）')
// 引用块自己那条 3px 竖线已经在说边界，轨道再出现就是并排两条线
assert.equal(
  await railDisplay('#content > .block[data-kind="blockquote"]'),
  'none',
  '只读档的引用块不该再出轨道',
)
if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/read-hover.png` })

// ── 3. 编辑档：把手出现，轨道让位（每档只出一样东西）──
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForTimeout(100)
assert.equal(await handleDisplay('#content > .block:not(.gap)'), 'flex', '编辑档应当出现块把手')
await page.hover('#content > .block[data-kind="blockquote"]')
await page.waitForTimeout(400)
assert.equal(
  await page.$eval('#content > .block[data-kind="blockquote"] .block-handle', (el) =>
    Number(getComputedStyle(el).opacity),
  ),
  1,
  '编辑档悬停应当出现把手',
)
// 编辑档的边界由悬停衬底 + 聚焦描边说，轨道再出现就是第三个说法（也是「线上串珠子」那个观感）
assert.equal(
  await railDisplay('#content > .block[data-kind="blockquote"]'),
  'none',
  '编辑档不该再出轨道：把手与轨道同时出现会读成两个标记',
)
if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/edit-hover.png` })

// ── 4. 点把手：弹块菜单，但**不**聚焦这一块 ──
const target = '#content > .block[data-kind="blockquote"]'
await page.click(`${target} .block-handle`)
await page.waitForSelector('.context-menu', { timeout: 5000 })
const labels = await page.$$eval('.context-item', (bs) => bs.map((b) => b.textContent ?? ''))
assert.ok(labels.some((l) => l.includes('复制本块')), `块菜单没弹出来：${JSON.stringify(labels)}`)
assert.ok(labels.some((l) => l.includes('删除本块')), '块菜单缺少删除项')
assert.equal(
  await page.$$eval('#content > .block.focused', (bs) => bs.length),
  0,
  '点把手只该弹菜单，不该把块切进编辑',
)
assert.equal(await page.$$eval('.cm-host', (bs) => bs.length), 0, '点把手不该挂上 CodeMirror')

// 菜单能关掉：Esc
await page.keyboard.press('Escape')
await page.waitForTimeout(100)
assert.equal(await page.$$eval('.context-menu:not([hidden])', (bs) => bs.length), 0, 'Esc 应当关掉块菜单')

// ── 5. 点块正文仍然聚焦，且聚焦块有一圈描边（方案 B） ──
await page.click(`${target} .preview`)
await page.waitForSelector('.cm-host', { timeout: 5000 })
const focused = await page.$eval('#content > .block.focused', (el) => getComputedStyle(el).boxShadow)
assert.notEqual(focused, 'none', '聚焦块应当有一圈描边')
assert.equal(await railDisplay('#content > .block.focused'), 'none', '编辑档聚焦后也不该冒出轨道')
if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/edit-focused.png` })

// ── 5b. 源码档：只有把手。.source-view 自己就有悬停左边线，
//        再叠一条轨道就是两条几乎一样的竖线并排（曾经真的这样上过屏）──
await page.click('.mode-opt[data-mode="source"]')
await page.waitForTimeout(200)
const para = page.locator('#content > .block[data-kind="paragraph"]').first()
await para.hover()
await page.waitForTimeout(400)
assert.equal(
  await para.locator('.source-view').evaluate((el) => getComputedStyle(el).borderLeftColor),
  'rgba(140, 136, 128, 0.5)',
  '源码档的悬停左边线本来就该在（它是既有约定，不是要被删掉的东西）',
)
assert.equal(
  await para.locator('.block-rail').evaluate((el) => getComputedStyle(el).display),
  'none',
  '源码档不该再冒出第二条竖线',
)
assert.equal(
  await para.locator('.block-handle').evaluate((el) => Number(getComputedStyle(el).opacity)),
  1,
  '源码档悬停应当出现把手',
)
if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/source-hover.png` })
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForTimeout(100)

// 聚焦块上的指示器不能被 CodeMirror 的挂载清掉（这是最容易漏的一条）
assert.equal(
  await page.$$eval('#content > .block.focused > .block-rail', (bs) => bs.length),
  1,
  '聚焦后轨道不能被重渲染清掉',
)

// ── 6. 换文件不留幽灵把手 ──
await page.goto(`${URL_ARG}?doc=media`, { waitUntil: 'load' })
await page.waitForSelector('#content > .block:not(.gap)', { timeout: 15000 })
const after = await page.evaluate(() => {
  const content = [...document.querySelectorAll('#content > .block:not(.gap)')]
  return {
    blocks: content.length,
    menuBlocks: content.filter((b) => b.dataset.kind !== 'unknown').length,
    handles: document.querySelectorAll('#content .block-handle').length,
    rails: document.querySelectorAll('#content .block-rail').length,
  }
})
assert.equal(after.handles, after.menuBlocks, '换文件后把手数量应当等于有菜单的块数（不留上一份文件的幽灵）')
assert.equal(after.rails, after.blocks, '换文件后轨道数量应当等于内容块数量')

assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)

await browser.close()
console.log('PASS  块指示器：轨道 / 把手 / 聚焦描边 / 点把手不聚焦 / 换文件无幽灵')
