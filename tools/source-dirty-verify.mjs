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

// ── 1b. 源码档不提供大纲：既不留白，也不摆一份假的 ──
// 大纲每一条都挂在块上（块 id 是跳转目标、块顺序是全文档顺序、滚动反查量块的位置），
// 源码档里整篇是一个 CM，这些前提都不成立。硬撑着只会有三种错：
// 高亮停在切档那一刻、点条目跳到别处、改标题文字大纲不更新。
const outline = () =>
  page.evaluate(() => ({
    rows: document.querySelectorAll('.sidebar-body .outline-row').length,
    note: document.querySelector('.sidebar-body .outline-empty')?.textContent ?? null,
    active: document.querySelectorAll('.sidebar-body .outline-row[aria-current="true"]').length,
  }))

const inSource = await outline()
assert.equal(inSource.rows, 0, '源码档不该列出大纲条目')
assert.ok(inSource.note, '源码档的大纲区留白了：用户会以为文档没有标题')
assert.equal(inSource.active, 0, '源码档不该有高亮的大纲条目')

// ── 1c. 查找：整篇 CM 的能力，源码档不能哑 ──
// 这里挡的是「能力挂错闸门」：查找高亮曾挂在 largeDocument（性能闸门）上，
// 源码档没有那个标记 → 计数照常、Enter 照翻，但正文不画标记也不滚过去，
// 看起来像在查找，实际什么也没发生。
await page.keyboard.press('Control+f')
await page.waitForSelector('.find-input', { timeout: 5000 })
await page.fill('.find-input', 'Markdown')
await page.waitForTimeout(900)
const findState = await page.evaluate(() => ({
  count: document.querySelector('.find-count')?.textContent ?? '',
  marks: document.querySelectorAll('.source-doc-host .find-hit').length,
  current: document.querySelectorAll('.source-doc-host .find-hit--current').length,
}))
assert.ok(/\d+\/\d+/.test(findState.count), `查找没报命中数：「${findState.count}」`)
assert.ok(findState.marks > 0, '源码档查找没在正文里画命中标记')
assert.equal(findState.current, 1, '源码档查找没有标出「当前这一处」')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

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

// 大纲要跟着回到标题列表。commitSourceView 在正文没变时会提前返回，
// 少了这里的重画，收起的说明文字就会一直挂着。
const backRows = await outline()
assert.ok(backRows.rows > 0, `退回块档后大纲没恢复，停在「${backRows.note ?? ''}」`)
// 块档里再存一次，字节还得对得上
const roundTrip = await saveAndRead()
assert.equal(roundTrip, saved, '从源码档退回块档后，再存盘把原文改了')

// ── 7. 切档不许丢撤销栈 ──
// 用户在源码档删了东西，切到块档再切回来，⌘Z 仍要能撤回。
// 断掉的原因有两层：切档 destroy 掉 CM（历史随 EditorState 一起没），
// 以及 commitSourceView 整篇重解析、块 id 全换（块档的 blockHistory 也失效）。
//
// 这里比的是「撤销前后正文长度」：撤销成功 = 内容回来，而非只看按钮有没有反应。
const cmLen = () =>
  page.evaluate(() => (document.querySelector('.source-doc-host .cm-content')?.textContent ?? '').length)

await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(600)
await page.click('.source-doc-host .cm-content')
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.waitForTimeout(500)
const emptied = await cmLen()
assert.equal(emptied, 0, `全选删除后正文不是空的：${emptied} 字`)

await page.click('.mode-opt[data-mode="edit"]')
await page.waitForTimeout(1200)

await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(800)
await page.click('.source-doc-host .cm-content')
await page.keyboard.press('Control+z')
await page.waitForTimeout(700)
const restored = await cmLen()
assert.ok(restored > 200, `切档后 ⌘Z 撤不回来（正文仍是 ${restored} 字）`)

assert.deepEqual(errors, [], `控制台有异常：${errors.join(' | ')}`)

console.log('源码档脏标记 / 存盘回归：通过')
await browser.close()
