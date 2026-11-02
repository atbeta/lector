// 源码档期间「尾巴解析」的行为回归。
//
// 长文档的首屏之后由 pumpParser 按时间片续解析。切进源码档时解析不能停：
//   - 继续跑的 paintFresh 会把块元素塞进 #content（源码档里块 DOM 不该出现）；
//   - commitSourceView / restoreWholeDocument 用整篇重解析换掉块表后，
//     旧 parser 还活着，会把旧文本的块 append 到新表尾——保存时就是重复内容。
//
// 场景固定为「打开 ?doc=tail → 立刻切源码档（尾巴还在解析）→ 文首打标记 →
// 切回块档 → 等解析收尾 → ⌘S」，断言写出去的字节与期望完全一致。
//
// 不要用 DOM 里的 .cm-line 拼正文——CodeMirror 只渲染视口内的行。
//
// 用法：先起 Vite（端口 5199），再 `node tools/source-parse-verify.mjs http://localhost:5199/`

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { launchBrowser, exitSkipped } from './browser.mjs'

const BASE = (process.argv[2] ?? 'http://localhost:5199/').replace(/\/?$/, '/')
const MARK = 'TAILMARK'
// 主修饰键与文档首尾导航按平台分（同 source-dirty-verify 的说明）。
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const DOC_HOME = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'

// ── 与 startupDocument.ts 里 `?doc=tail` 的生成逻辑逐字一致 ──
// 断言「写出去 === 文首标记 + 原文」需要独立造出原文，不读 DOM。
const SECTIONS = 8000
const PARA =
  '这一节的内容是一段普通的说明文字，用来把文档撑到时间片解析的量级。' +
  '正文刻意写得很平，不包含表格、公式或图片，让解析成本只来自篇幅。'.repeat(18) +
  '\n\n'
const original = (() => {
  const parts = []
  for (let i = 1; i <= SECTIONS; i++) parts.push(`## 第 ${i} 节\n\n${PARA}`)
  return parts.join('')
})()
const count = (text, needle) => text.split(needle).length - 1

const browser = await launchBrowser()
if (!browser) exitSkipped('源码档尾巴解析回归', process.argv.includes('--strict'))
const page = await browser.newPage({
  viewport: { width: 1360, height: 900 },
  locale: 'zh-CN',
  acceptDownloads: true,
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/** 按一次 ⌘S，读回真正写出去的正文字节。 */
async function saveAndRead() {
  const pending = page.waitForEvent('download', { timeout: 8000 })
  await page.keyboard.press(`${MOD}+s`)
  const download = await pending
  return readFile(await download.path(), 'utf8')
}

await page.goto(`${BASE}?doc=tail`, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 20000 })

// ── 1. 尾巴必须还在解析：此刻块 DOM 必然远少于总数 ──
// （pending 占位块排在已解析块之后，通常没轮到画就被收走，不能拿它当信号；
//   直接看「画出来的块数还远没到齐」。）
const blocksAt = () =>
  page.evaluate(() => document.querySelectorAll('#content > .block').length)
const atSwitch = await blocksAt()
assert.ok(
  atSwitch > 0 && atSwitch < SECTIONS,
  `打开时尾部已经齐活（${atSwitch} 块），本用例的前提（尾巴还在解析）不成立`,
)

// ── 2. 立刻切源码档：块 DOM 不许再在 #content 里长出来 ──
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(1600) // 给时间片几次机会，坏版本会在这里塞进 .block
const strayBlocks = await page.evaluate(
  () => document.querySelectorAll('#content > .block').length,
)
assert.equal(
  strayBlocks,
  0,
  `源码档期间 #content 里长出了 ${strayBlocks} 个块元素：尾巴解析还在往 DOM 里画`,
)

// ── 3. 文首打标记（验证正文没被旧文本块拼回去）──
await page.click('.source-doc-host .cm-content')
await page.keyboard.press(DOC_HOME)
await page.keyboard.type(MARK)
await page.keyboard.press('Enter')
await page.waitForTimeout(400)

// ── 4. 切回块档，等重解析与旧 parser 收尾（坏版本在此把旧块 append 进新表）──
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 10000 })
// 坏版本里旧 parser 还会跑一小段把旧块塞进来：给它充分时间再存盘。
await page.waitForFunction(
  () => !document.querySelector('.block[data-kind="pending"]'),
  null,
  { timeout: 15000 },
).catch(() => {})
await page.waitForTimeout(2500)

// ── 5. ⌘S：写出去的字节必须是「标记 + 原文」，一个字都不能多 ──
const saved = await saveAndRead()
assert.equal(count(saved, `## 第 ${SECTIONS} 节`), 1, `最后一节标题出现次数不为 1（块被重复拼接）`)
assert.equal(count(saved, '## 第 '), SECTIONS, `小节数 ${count(saved, '## 第 ')} ≠ ${SECTIONS}（解析把块拼乱了）`)
assert.equal(
  saved,
  `${MARK}\n${original}`,
  '写出去的不是「文首标记 + 原文」：尾巴解析把旧内容混进了块表',
)

assert.deepEqual(errors, [], `控制台有异常：${errors.join(' | ')}`)

console.log('源码档尾巴解析回归：通过')
await browser.close()
