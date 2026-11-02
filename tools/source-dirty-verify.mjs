// 源码档脏标记 / 存盘回归。
//
// 挡的是一条曾经真实存在、且会丢改动的线：源码档里打字，脏标记不翻、
// 保存按钮不亮、⌘S 静默空转。根因是 CM 的分发只在大文件模式下调
// onDocChanged，源码档两条通知路径都没走通，markDirty 一次没跑过。
//
// 这里从「界面信号」一路验到「写出去的字节」：预览环境的保存是 Blob 下载，
// 所以能拦下下载事件直接读正文。
//
// 不要用 DOM 里的 .cm-line 拼正文——CodeMirror 只渲染视口内的行，
// 拼出来是半截（实测 38 行的文档一开始只渲染 30 行）。
//
// 用法：先起 Vite（端口 5199），再 `node tools/source-dirty-verify.mjs http://localhost:5199/`

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { launchBrowser, exitSkipped } from './browser.mjs'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'
const MARK = 'XYZZY'

const browser = await launchBrowser()
if (!browser) exitSkipped('源码档存盘验证', process.argv.includes('--strict'))
const page = await browser.newPage({
  viewport: { width: 1360, height: 900 },
  locale: 'zh-CN',
  acceptDownloads: true,
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const signals = () =>
  page.evaluate(() => ({
    dirty: document.documentElement.classList.contains('dirty'),
    dot: getComputedStyle(document.getElementById('dirty-dot')).display,
    saveDisabled: document.getElementById('save-btn')?.disabled,
    status: document.getElementById('status-right')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
  }))

/** 按一次 ⌘S，读回真正写出去的正文字节。 */
async function saveAndRead() {
  const pending = page.waitForEvent('download', { timeout: 8000 })
  await page.keyboard.press('Control+s')
  const download = await pending
  return readFile(await download.path(), 'utf8')
}

await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 15000 })

// ── 1. 切进源码档：干净的文档不该一进来就是脏的 ──
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(400)

const clean = await signals()
assert.equal(clean.dirty, false, '刚切进源码档就出现脏标记：判脏的基线不对')
assert.equal(clean.dot, 'none', '刚切进源码档脏点就亮着')
assert.equal(clean.saveDisabled, true, '没有改动时保存按钮该是禁用的')
assert.ok(clean.status.includes('已保存'), `干净文档的状态行不该是「${clean.status}」`)

// ── 2. 没动过就存盘：必须字节级等于原文（产品红线） ──
// 判脏若拿字符串硬比，CRLF / 混合换行的文件在这一步会被判成「改过」，
// 然后被整篇重写成 LF——字节变了，但界面看不出来。只有比写出去的字节能抓住。
const baseline = await saveAndRead()
assert.ok(baseline.length > 0, '存出去是空文件')
assert.ok(!baseline.includes(MARK), '还没打字就已经有标记，样例文件不对劲')

// ── 3. 打字：脏标记、脏点、保存按钮、状态行四处必须同时翻 ──
await page.click('.source-doc-host .cm-content')
await page.keyboard.press('Control+End')
await page.keyboard.type(MARK)
await page.waitForTimeout(500)

const dirty = await signals()
assert.equal(dirty.dirty, true, '源码档打字后 html.dirty 没翻（脏标记不亮）')
assert.equal(dirty.dot, 'block', '脏点没显示')
assert.equal(dirty.saveDisabled, false, '有改动时保存按钮仍是禁用的')
assert.ok(dirty.status.includes('未保存'), `状态行没提示未保存：「${dirty.status}」`)

// ── 4. ⌘S：改动真的写出去，且原文一个字节都没被改坏 ──
const saved = await saveAndRead()
assert.equal(
  saved,
  baseline + MARK,
  '写出去的不是「原文 + 刚打的字」：\n' +
    `  原文 ${baseline.length} 字，末端 ${JSON.stringify(baseline.slice(-30))}\n` +
    `  写出去 ${saved.length} 字，末端 ${JSON.stringify(saved.slice(-30))}`,
)

// ── 5. 存盘后：脏标记收回，状态行回到已保存 ──
await page.waitForTimeout(600)
const settled = await signals()
assert.equal(settled.dirty, false, '存盘后脏标记没收回')
assert.equal(settled.saveDisabled, true, '存盘后保存按钮该重新禁用')
assert.ok(settled.status.includes('已保存'), `存盘后状态行没回到已保存：「${settled.status}」`)

// ── 6. 退回块档：改动用源码档的正文重解析，不能回滚成旧内容 ──
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(500)
const blockText = await page.evaluate(() => document.getElementById('content').innerText)
assert.ok(blockText.includes(MARK), '回到块档后改动没了：源码档的正文没交回块表')
// 块档里再存一次，字节还得对得上
const roundTrip = await saveAndRead()
assert.equal(roundTrip, saved, '从源码档退回块档后，再存盘把原文改了')

assert.deepEqual(errors, [], `控制台有异常：${errors.join(' | ')}`)

console.log('源码档脏标记 / 存盘回归：通过')
await browser.close()
