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
// 主修饰键与文档首尾导航按平台分：macOS 上 ⌘ 是 Meta，Ctrl+f / Ctrl+a
// 是 CM defaultKeymap 里的 Emacs 光标键（会被吃掉），Control+End 也不走。
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const DOC_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
const DOC_HOME = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'

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
  await page.keyboard.press(`${MOD}+s`)
  const download = await pending
  return readFile(await download.path(), 'utf8')
}

await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 15000 })

// ── 0. 块档存盘后切源码档：源码档的正文必须是刚存下去的那份 ──
// 块档 ⌘S 曾不把 session.source.text 挪到新正文——切进源码档挂的是保存前的
// 旧文本；在那里打字再存，刚保存的块档编辑会被静默丢掉。
// 放在最前面跑：后面各节的切档会污染这份前提。
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(400)
await page.click('#content > .block[data-kind="paragraph"]')
await page.waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 5000 })
await page.keyboard.press('End')
await page.keyboard.type('SAVEDMARK')
await page.waitForTimeout(500)
const withSaved = await saveAndRead()
assert.ok(withSaved.includes('SAVEDMARK'), 'SAVEDMARK 没存出去，本节前 置条件不成立')
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(600)
// SAVEDMARK 在文首段落里，一定落在 CM 渲染出的视口行内——这里读 .cm-content
// 文本就够；真正的正文字节比对在下面的存盘断言里做。
const srcDocHas = (mark) =>
  page.evaluate(
    (m) => (document.querySelector('.source-doc-host .cm-content')?.textContent ?? '').includes(m),
    mark,
  )
assert.ok(await srcDocHas('SAVEDMARK'), '块档存盘后切源码档：源码档挂的是保存前的旧文本')

await page.click('.source-doc-host .cm-content')
await page.keyboard.press(DOC_HOME)
await page.keyboard.type('SRCAFTER ')
await page.waitForTimeout(500)
const afterSrc = await saveAndRead()
assert.ok(afterSrc.includes('SAVEDMARK'), '源码档存盘丢了刚保存的块档编辑（SAVEDMARK 不在字节里）')
assert.ok(afterSrc.includes('SRCAFTER'), 'SRCAFTER 没存出去')

// 回块档，把 §1 的原定流程还回去（§1 会自己切进源码档）。
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(500)

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
await page.keyboard.press(`${MOD}+f`)
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
await page.keyboard.press(DOC_END)
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
await page.keyboard.press(`${MOD}+a`)
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
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(700)
const restored = await cmLen()
assert.ok(restored > 200, `切档后 ⌘Z 撤不回来（正文仍是 ${restored} 字）`)

// ── 8. 跨档撤销：两个方向都要能撤 ──
// 撤销历史住在各自的 EditorState 里，聚焦块和整篇 CM 互不相通。
// 所以「切档后还能⌘Z」只能靠在边界上留整篇快照，见 pushModeSwitchUndo。
const cmHas = async (mark) =>
  page.evaluate((m) => (document.querySelector('.source-doc-host .cm-content')?.textContent ?? '').includes(m), mark)

// 8a. 块档改 → 切源码档 → ⌘Z
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForTimeout(1100)
await page.click('#content > .block[data-kind="paragraph"]')
await page.waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 5000 })
await page.keyboard.press('End')
await page.keyboard.type('BLKMARK')
await page.waitForTimeout(600)
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(800)
assert.ok(await cmHas('BLKMARK'), '块档的改动没带进源码档')
await page.click('.source-doc-host .cm-content')
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(900)
assert.equal(await cmHas('BLKMARK'), false, '块档改的东西，切到源码档后 ⌘Z 撤不掉')

// 8b. 源码档改 → 切块档 → ⌘Z
await page.keyboard.press(DOC_HOME)
await page.keyboard.type('SRCMARK ')
await page.waitForTimeout(600)
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForTimeout(1200)
assert.ok(
  (await page.evaluate(() => document.getElementById('content').innerText)).includes('SRCMARK'),
  '源码档的改动没带回块档',
)
// 焦点在正文外也要能撤（⌘Z 的守卫看的是「焦点在不在编辑器里」，不是「编辑器在不在」）
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.waitForTimeout(300)
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(900)
assert.equal(
  (await page.evaluate(() => document.getElementById('content').innerText)).includes('SRCMARK'),
  false,
  '源码档改的东西，切回块档后 ⌘Z 撤不掉',
)

// ── 9. 存盘后的跨档撤销：正文要回退，脏标记必须亮起来 ──
// 挡的是 restoreWholeDocument 的一个洞：切档快照落回块档时把每个块都标成
// 干净却没重算 structuralDirty——内容确实回去了，脏标记却灭着，⌘S 静默空转。
// 这一节曾经靠前面各节留下的状态碰巧通过：换成全新加载，单独成立。
await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 15000 })
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(1100)
await page.click('#content > .block[data-kind="paragraph"]')
await page.waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 5000 })
await page.keyboard.press('End')
await page.keyboard.type('AFTERMARK')
await page.waitForTimeout(600)
// 块档 → 源码档：边界上压下「回到改之前」的切档快照
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(800)
// 源码档 → 块档（没改字，块表原样沿用）
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(1200)
// 存盘：磁盘基线 = 带 AFTERMARK 的正文。之后撤销回到旧内容，必须显示为脏。
const withMark = await saveAndRead()
assert.ok(withMark.includes('AFTERMARK'), 'AFTERMARK 没存出去，前置条件不成立')
await page.waitForTimeout(600)
// 焦点放到正文外：聚焦块里 ⌘Z 是块内文字撤销，要测的是全局路径
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(900)
const undoneText = await page.evaluate(() => document.getElementById('content').innerText)
assert.equal(undoneText.includes('AFTERMARK'), false, '存盘后的跨档撤销没有回退正文')
const undoneSignals = await signals()
assert.equal(undoneSignals.dirty, true, '撤销后内容与磁盘已不一致，脏标记却没亮（⌘S 会空转）')
assert.equal(undoneSignals.dot, 'block', '撤销后脏点没显示')

// ── 10. 查找框里的 ⌘Z 归输入框，绝不能动正文 ──
// 全局快捷键曾在「焦点不在编辑器里」时一律接管 ⌘Z：查找栏开着想撤销
// 刚敲错的查询词，结果整篇文档被回滚。
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(800)
await page.click('.source-doc-host .cm-content')
await page.keyboard.press(DOC_END)
await page.keyboard.type('FINDGUARD')
await page.waitForTimeout(500)
await page.keyboard.press(`${MOD}+f`)
await page.waitForSelector('.find-input', { timeout: 5000 })
await page.fill('.find-input', '查')
await page.waitForTimeout(300)
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(700)
// 正文读存盘字节（与前面同一口径），不读 .cm-line——CM 只渲染视口内的行
const afterFindUndo = await saveAndRead()
assert.ok(afterFindUndo.includes('FINDGUARD'), '查找框里的 ⌘Z 撤掉了正文')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// ── 10b. 统一重做：块级撤销 → 全局 ⇧⌘Z 回放，中间有改动就必须作废 ──
// 三条历史（聚焦块 CM、整篇 CM、app 自己的块级/切档栈）共用一条时序：
// 撤销按「先承载后兜底」，重做按「先兜底后承载」——兜底撤销只在承载历史
// 见底后发生，最后被撤掉的必然先在它身上重做。
await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 15000 })
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(600)

const contentText = () => page.evaluate(() => document.getElementById('content').innerText)
const firstBlockText = (await page.$eval('#content > .block:not(.gap)', (el) => el.innerText)).trim()

// 编辑档：块把手菜单删掉第一块
await page.hover('#content > .block:not(.gap)')
await page.click('#content > .block:not(.gap) .block-handle')
await page.waitForSelector('.context-menu', { timeout: 5000 })
await page.locator('.context-menu .context-item', { hasText: '删除本块' }).first().click()
await page.waitForTimeout(700)
assert.ok(!(await contentText()).includes(firstBlockText), '删除本块没生效，前置条件不成立')

// 全局 ⌘Z（焦点在正文外）：把删掉的块撤回来
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(800)
assert.ok((await contentText()).includes(firstBlockText), '全局 ⌘Z 没把删掉的块撤回来')

// 全局 ⇧⌘Z：回放删除，块再次消失
await page.keyboard.press(`${MOD}+Shift+z`)
await page.waitForTimeout(800)
assert.ok(!(await contentText()).includes(firstBlockText), '⇧⌘Z 没把删除重放回去')

// 再 ⌘Z 撤一次，然后往块里打字：撤销之后的改动让重做基线失效，
// ⇧⌘Z 宁可不放也不能拿旧闭包改现在的正文
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(800)
assert.ok((await contentText()).includes(firstBlockText), '第二次 ⌘Z 没把块撤回来')
await page.click('#content > .block[data-kind="paragraph"]')
await page.waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 5000 })
await page.keyboard.press('End')
await page.keyboard.type('REDOGONE')
await page.waitForTimeout(500)
// 退出聚焦块（⌘⇧Z 的全局路径只在没聚焦块时走），再按重做
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await page.keyboard.press(`${MOD}+Shift+z`)
await page.waitForTimeout(800)
assert.ok(
  (await contentText()).includes(firstBlockText),
  '撤销之后打过字，⇧⌘Z 仍回放了失效的重做（把删掉的又删了一遍）',
)

// ── 10c. 切档快照的撤销 → 重做：回放出去的正文，存盘字节要能跟上 ──
await page.goto(URL_ARG, { waitUntil: 'load' })
await page.waitForSelector('#content > .block', { timeout: 15000 })
await page.click('.mode-opt[data-mode="edit"]')
await page.waitForSelector('#content > .block', { timeout: 5000 })
await page.waitForTimeout(600)
// 块档打字 → 切源码档：边界上压下切档快照
await page.click('#content > .block[data-kind="paragraph"]')
await page.waitForFunction(() => document.activeElement?.classList?.contains('cm-content'), null, { timeout: 5000 })
await page.keyboard.press('End')
await page.keyboard.type('REDOMARK')
await page.waitForTimeout(600)
await page.click('.mode-opt[data-mode="source"]')
await page.waitForSelector('.source-doc-host .cm-content', { timeout: 5000 })
await page.waitForTimeout(700)
assert.ok(await cmHas('REDOMARK'), '块档的改动没带进源码档，前置条件不成立')

// 焦点拉出 CM，全局 ⌘Z → 切档快照还原（REDOMARK 撤掉）
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.keyboard.press(`${MOD}+z`)
await page.waitForTimeout(900)
assert.equal(await cmHas('REDOMARK'), false, '切档快照 ⌘Z 没把块档的改动撤掉')

// ⇧⌘Z → 兜底重做回放「撤销那一刻」的正文（REDOMARK 回来）
await page.keyboard.press(`${MOD}+Shift+z`)
await page.waitForTimeout(900)
assert.ok(await cmHas('REDOMARK'), '⇧⌘Z 没把切档前的改动放回来')

// 存盘字节：回放出去的正文必须真的能写出去
const redoneSaved = await saveAndRead()
assert.ok(redoneSaved.includes('REDOMARK'), '重做后的正文没存出去')

// ── 11. 大文件档：查找要高亮、打字要写进保存的字节 ──
// 大文件是另一个整篇 CM 承载（.large-doc-host）：正文不进块表，
// 「某个功能忘了这个承载」曾让查找不画标记、打字不算脏、⌘S 写回原文。
const hugeUrl = `${URL_ARG.split('?')[0].replace(/\/?$/, '/')}?doc=huge`
await page.goto(hugeUrl, { waitUntil: 'load' })
await page.waitForSelector('.large-doc-host .cm-content', { timeout: 15000 })
await page.waitForTimeout(800)

// 查找高亮：命中标记与当前项都得画出来
await page.keyboard.press(`${MOD}+f`)
await page.waitForSelector('.find-input', { timeout: 5000 })
await page.fill('.find-input', '大文件压测')
await page.waitForTimeout(900)
const hugeFind = await page.evaluate(() => ({
  count: document.querySelector('.find-count')?.textContent ?? '',
  marks: document.querySelectorAll('.large-doc-host .find-hit').length,
  current: document.querySelectorAll('.large-doc-host .find-hit--current').length,
}))
assert.ok(/\d+\/\d+/.test(hugeFind.count), `大文件查找没报命中数：「${hugeFind.count}」`)
assert.ok(hugeFind.marks > 0, '大文件查找没在正文里画命中标记')
assert.equal(hugeFind.current, 1, '大文件查找没有标出「当前这一处」')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 打字 → 脏标记翻 → ⌘S 写出去的是「标记 + 原文」
await page.click('.large-doc-host .cm-content')
await page.keyboard.press(DOC_HOME)
await page.keyboard.type('HUGEMARK')
await page.keyboard.press('Enter')
await page.waitForTimeout(600)
const hugeDirty = await signals()
assert.equal(hugeDirty.dirty, true, '大文件里打字后 html.dirty 没翻')

// 与 startupDocument.ts 里 ?doc=huge 的生成逻辑逐字一致（不读 .cm-line，CM 只渲染视口）
const hugeOriginal =
  '# 大文件压测\n\n' + '- 这是一行用于压测的正文内容，重复出现以撑大文件体积。\n'.repeat(50_000)
const hugeSaved = await saveAndRead()
assert.equal(hugeSaved, `HUGEMARK\n${hugeOriginal}`, '大文件存盘写出去的不是「文首标记 + 原文」')

assert.deepEqual(errors, [], `控制台有异常：${errors.join(' | ')}`)

console.log('源码档脏标记 / 存盘回归：通过')
await browser.close()
