import assert from 'node:assert/strict'
import { launchBrowser, exitSkipped } from './browser.mjs'

const URL_ARG = process.argv[2] ?? 'http://localhost:5199/'

// 没有浏览器就跳过：这些脚本量的是真实渲染，服务器上跑不了是常态。
const browser = await launchBrowser()
if (!browser) exitSkipped('渲染层验证', process.argv.includes('--strict'))
const results = []
const ok = (name) => results.push(['PASS', name])
const fail = (name, err) => results.push(['FAIL', `${name}: ${err?.message ?? err}`])

async function newPage(url, init) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  if (init) await page.addInitScript(init)
  await page.goto(url, { waitUntil: 'load' })
  return { page, errors }
}

const mountPreferenceOutline = async () => {
  const { createOutline } = await import('/src/outline.ts')
  const mk = (id, depth, text) => ({
    id,
    kind: 'heading',
    start: 0,
    end: 0,
    raw: `${'#'.repeat(depth)} ${text}`,
    dirty: false,
    mdast: { type: 'heading', depth, children: [{ type: 'text', value: text }] },
  })
  const blocks = [mk('a', 1, 'A'), mk('b', 2, 'B'), mk('c', 1, 'C'), mk('d', 2, 'D')]
  const body = document.createElement('div')
  body.id = 'pref-outline'
  const content = document.createElement('div')
  content.style.cssText = 'height:100px;overflow:auto'
  const inner = document.createElement('div')
  inner.style.height = '1000px'
  content.appendChild(inner)
  document.body.append(body, content)
  const inst = createOutline({
    sidebar: { body, isOpen: () => true, toggle: () => {} },
    contentEl: content,
    getBlocks: () => blocks,
    getBlockElement: () => undefined,
    isLargeDocument: () => false,
  })
  inst.readCollapsedPref()
  inst.renderOutline()
}

{
  const { page, errors } = await newPage(URL_ARG, () => {
    localStorage.setItem('lector-sidebar', 'open')
  })
  try {
    await page.waitForSelector('.outline-row', { timeout: 15000 })
    const rowIds = await page.$$eval('.outline-row', (rs) => rs.map((r) => r.dataset.blockId))
    const headIds = await page.$$eval('#content .block[data-kind="heading"]', (bs) =>
      bs.map((b) => b.dataset.blockId),
    )
    assert.deepEqual(rowIds, headIds, 'outline rows must match heading blocks in DOM order')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('default sample: outline ids match heading blocks')
  } catch (e) {
    fail('default sample: outline ids match heading blocks', e)
  }

  try {
    const row = await page.waitForSelector('.outline-node:has(.outline-kids) .outline-row', { timeout: 5000 })
    await page.evaluate((el) => {
      window.__row = el
    }, row)
    const twisty = await page.$('.outline-node:has(.outline-kids) > .outline-line > .outline-twisty')
    const before = await twisty.getAttribute('aria-expanded')
    await twisty.click()
    const collapsed = await page.evaluate(() => ({
      same: document.contains(window.__row),
      data: window.__row.closest('.outline-node').dataset.collapsed,
      expanded: window.__row
        .closest('.outline-node')
        .querySelector(':scope > .outline-line > .outline-twisty')
        .getAttribute('aria-expanded'),
    }))
    assert.equal(collapsed.same, true, 'row element must not be rebuilt')
    assert.equal(collapsed.data, 'true')
    assert.equal(collapsed.expanded, 'false')
    await twisty.click()
    const expanded = await page.evaluate(() => ({
      same: document.contains(window.__row),
      data: window.__row.closest('.outline-node').dataset.collapsed,
      expanded: window.__row
        .closest('.outline-node')
        .querySelector(':scope > .outline-line > .outline-twisty')
        .getAttribute('aria-expanded'),
    }))
    assert.equal(expanded.same, true)
    assert.equal(expanded.data, 'false')
    assert.equal(expanded.expanded, 'true')
    assert.notEqual(before, collapsed.expanded)
    ok('collapse/expand: in-place, same row, aria-expanded flips')
  } catch (e) {
    fail('collapse/expand twisty', e)
  }

  try {
    const rows = await page.$$('.outline-row')
    const last = rows[rows.length - 1]
    await last.click()
    await page.waitForFunction(
      (el) => el.getAttribute('aria-current') === 'true',
      last,
      { timeout: 10000 },
    )
    const ancestors = await page.$$eval('.outline-row.ancestor', (rs) => rs.length)
    assert.ok(ancestors >= 1, 'expected at least one ancestor row highlighted')
    ok('click last heading: aria-current + ancestor classes')
  } catch (e) {
    fail('click last heading', e)
  }

  try {
    await page.click('.mode-opt[data-mode="source"]')
    await page.waitForSelector('#content .source-view', { timeout: 10000 })
    await page.click('.mode-opt[data-mode="read"]')
    await page.waitForSelector('#content .preview', { timeout: 10000 })
    const rows = await page.$$('.outline-row')
    const target = rows[Math.min(2, rows.length - 1)]
    const targetId = await target.evaluate((el) => el.dataset.blockId)
    await target.click()
    await page.waitForFunction(
      (id) => document.querySelector(`.outline-row[data-block-id="${id}"]`)?.getAttribute('aria-current') === 'true',
      targetId,
      { timeout: 10000 },
    )
    ok('source/read switch: outline still navigates')
  } catch (e) {
    fail('source/read switch', e)
  }
  try {
    const box = await page.waitForSelector('.preview li.task input[type=checkbox]', { timeout: 10000 })
    await box.click()
    await page.waitForFunction(
      () => document.documentElement.classList.contains('dirty'),
      null,
      { timeout: 5000 },
    )
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await page.waitForFunction(
      () =>
        !document.documentElement.classList.contains('dirty') &&
        !document.querySelector('.preview li.task input[type=checkbox]')?.checked,
      null,
      { timeout: 5000 },
    )
    ok('task toggle: dirty then mod+z restores checkbox and clean')
  } catch (e) {
    fail('task toggle undo', e)
  }
  assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=empty')
  try {
    await page.waitForSelector('#content', { timeout: 15000 })
    await page.evaluate(mountPreferenceOutline)
    const twistySel = '#pref-outline > .outline-list > .outline-node:first-child > .outline-line > .outline-twisty'
    await page.waitForSelector(twistySel, { timeout: 5000 })
    await page.click(twistySel)
    const afterClick = await page.evaluate(() => ({
      expanded: document
        .querySelector('#pref-outline > .outline-list > .outline-node:first-child > .outline-line > .outline-twisty')
        .getAttribute('aria-expanded'),
      stored: localStorage.getItem('lector-outline-collapsed'),
    }))
    assert.equal(afterClick.expanded, 'false')
    assert.ok(afterClick.stored?.includes('1:A'), `collapse key not persisted: ${afterClick.stored}`)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('#content', { timeout: 15000 })
    await page.evaluate(mountPreferenceOutline)
    await page.waitForSelector(twistySel, { timeout: 5000 })
    const afterReload = await page.evaluate(() => {
      const nodes = document.querySelectorAll('#pref-outline > .outline-list > .outline-node')
      const state = (n) => ({
        collapsed: n.dataset.collapsed,
        expanded: n.querySelector(':scope > .outline-line > .outline-twisty')?.getAttribute('aria-expanded'),
      })
      return { first: state(nodes[0]), second: state(nodes[1]) }
    })
    assert.equal(afterReload.first.collapsed, 'true')
    assert.equal(afterReload.first.expanded, 'false')
    assert.equal(afterReload.second.collapsed, 'false')
    assert.equal(afterReload.second.expanded, 'true')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('collapsed preference: click-collapse persists across reload')
  } catch (e) {
    fail('collapsed preference roundtrip', e)
  }
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=media', () => {
    window.__copied = []
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => (window.__copied.push(t), Promise.resolve()) },
      })
    } catch {
      navigator.clipboard.writeText = (t) => (window.__copied.push(t), Promise.resolve())
    }
  })
  try {
    await page.waitForSelector('.code-card .code-copy', { timeout: 15000 })
    await page.click('.code-card .code-copy')
    await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 5000 })
    const expected = await page.$eval('.code-card pre code', (el) => el.textContent)
    const got = await page.evaluate(() => window.__copied[0])
    assert.equal(got, expected, 'copied text must equal pre code text (no fence/toolbar)')
    const mode = await page.evaluate(() => document.documentElement.dataset.mode)
    assert.equal(mode, 'read')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('media sample: copy button copies code text, mode stays read')
  } catch (e) {
    fail('media sample copy', e)
  }
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=mermaid')
  try {
    await page.waitForSelector('.mermaid-diagram svg', { timeout: 30000 })
    await page.click('.mermaid-diagram')
    await page.waitForSelector('.lightbox', { timeout: 5000 })
    ok('mermaid sample: svg renders, click opens lightbox')
  } catch (e) {
    fail('mermaid sample', e)
  }
  assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=empty')
  try {
    await page.waitForSelector('#content', { timeout: 15000 })
    const out = await page.evaluate(async () => {
      const { createOutline } = await import('/src/outline.ts')
      const blocks = [
        { id: 'h1', kind: 'heading', start: 0, end: 4, raw: '# A', dirty: false,
          mdast: { type: 'heading', depth: 1, children: [{ type: 'text', value: 'A' }] } },
        { id: 'h2', kind: 'heading', start: 4, end: 9, raw: '## B', dirty: false,
          mdast: { type: 'heading', depth: 2, children: [{ type: 'text', value: 'B' }] } },
      ]
      const make = () => {
        const body = document.createElement('div')
        const content = document.createElement('div')
        const els = new Map(blocks.map((b) => [b.id, document.createElement('div')]))
        const inst = createOutline({
          sidebar: { body, isOpen: () => true, toggle: () => {} },
          contentEl: content,
          getBlocks: () => blocks,
          getBlockElement: (id) => els.get(id),
          isLargeDocument: () => false,
        })
        document.body.append(body, content)
        return { inst, body }
      }
      const a = make()
      const b = make()
      a.inst.renderOutline()
      b.inst.renderOutline()
      const bCurrentBefore = b.body.querySelector('.outline-row[aria-current]')?.dataset.blockId ?? null
      a.body.querySelector('.outline-twisty').click()
      a.body.querySelector('.outline-row').click()
      const aCollapsed = a.body.querySelector('.outline-node').dataset.collapsed
      const bCollapsed = b.body.querySelector('.outline-node').dataset.collapsed
      const aCurrent = a.body.querySelector('.outline-row[aria-current]')?.dataset.blockId ?? null
      const bCurrent = b.body.querySelector('.outline-row[aria-current]')?.dataset.blockId ?? null
      return { aCollapsed, bCollapsed, aCurrent, bCurrentBefore, bCurrent }
    })
    assert.equal(out.aCollapsed, 'true')
    assert.equal(out.bCollapsed, 'false', 'instance B collapsed state leaked from A')
    assert.equal(out.aCurrent, 'h1')
    assert.equal(out.bCurrent, out.bCurrentBefore, 'instance B active heading leaked from A')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('outline factory: two isolated instances, no state leak')
  } catch (e) {
    fail('outline factory isolation', e)
  }
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=empty')
  try {
    await page.waitForSelector('#content', { timeout: 15000 })
    const out = await page.evaluate(async () => {
      const { createReadingPositionController } = await import('/src/readingPositionController.ts')
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      localStorage.setItem(
        'lector-positions',
        JSON.stringify({ '/a.md': { top: 300, length: 1000, at: 1 } }),
      )
      const scroller = document.createElement('div')
      Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
      let restored = 0
      const ctl = createReadingPositionController({
        getPath: () => '/a.md',
        getScroller: () => scroller,
        onRestore: () => restored++,
      })
      ctl.restoreReadingPosition()
      const before = scroller.scrollTop
      await raf()
      await raf()
      const after = scroller.scrollTop
      scroller.scrollTop = 500
      ctl.scheduleRecordPosition()
      scroller.scrollTop = 800
      ctl.scheduleRecordPosition()
      await sleep(600)
      const stored = JSON.parse(localStorage.getItem('lector-positions'))['/a.md'].top
      localStorage.setItem('lector-positions', '{{not json')
      let corruptOk = true
      try {
        createReadingPositionController({ getPath: () => '/a.md', getScroller: () => scroller, onRestore: () => {} })
      } catch {
        corruptOk = false
      }
      return { before, after, restored, stored, corruptOk }
    })
    assert.equal(out.before, 0)
    assert.equal(out.after, 300, 'saved top must be restored after rAF')
    assert.equal(out.restored, 1, 'onRestore must fire once after restore')
    assert.equal(out.stored, 800, 'debounced record must store the latest scrollTop')
    assert.equal(out.corruptOk, true)
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('readingPositionController: restore + debounce + corrupt storage')
  } catch (e) {
    fail('readingPositionController', e)
  }
  await page.close()
}

{
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('**/src/main.ts*', (route) => route.abort())
  await page.addInitScript(() => {
    window.__lectorTitle = 'bootstrap-title.md'
  })
  try {
    await page.goto(URL_ARG, { waitUntil: 'load' })
    assert.equal(await page.title(), 'bootstrap-title.md')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('title bootstrap: __lectorTitle applied before app script')
  } catch (e) {
    fail('title bootstrap', e)
  }
  await page.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=empty')
  try {
    await page.waitForSelector('#content', { timeout: 15000 })
    await page.evaluate(async () => {
      const { createDocumentEditor } = await import('/src/documentEditor.ts')
      const { createFileController } = await import('/src/fileController.ts')
      const { createRecoveryController } = await import('/src/recoveryController.ts')
      const contentEl = document.createElement('div')
      const fileNameEl = document.createElement('div')
      document.body.append(contentEl, fileNameEl)
      let viewMode = 'read'
      const saveCalls = []
      const saveQueue = []
      const io = {
        detectEnv: () => 'browser',
        pickAndRead: async () => null,
        pickSavePath: async () => null,
        read: async () => {
          throw new Error('no io')
        },
        save: async (path, text, mtimeMs, force) => {
          saveCalls.push({ path, text, mtimeMs, force })
          return saveQueue.length ? saveQueue.shift() : { ok: true, current_mtime_ms: 9 }
        },
        watch: async () => {},
        bindDocument: async () => {},
        recentList: async () => [],
        recentClear: async () => {},
        onOpen: async () => () => {},
        onFileChanged: async () => () => {},
        onCloseRequest: async () => () => {},
        openWithDefault: async () => {},
        revealInFolder: async () => {},
      }
      const editor = createDocumentEditor({
        contentEl,
        getViewMode: () => viewMode,
        setViewMode: (m) => {
          viewMode = m
        },
        forceSourceMode: () => {
          viewMode = 'source'
        },
        setDocumentTitle: () => {},
        setDocPresent: () => {},
        beforeDirty: () => {},
        onDirty: () => {},
        resetOutline: () => {},
        renderOutline: () => {},
        restoreReadingPosition: () => {},
        scheduleRecordPosition: () => {},
      })
      const recovery = createRecoveryController({
        getSession: () => editor.getSession(),
        isLarge: () => editor.isLarge(),
        loadSession: (p, r, m) => files.loadSession(p, r, m),
        markStructuralDirty: () => editor.markStructuralDirty(),
      })
      const files = createFileController({
        editor,
        chrome: { elements: { contentEl, fileNameEl }, setDocPresent: () => {} },
        recovery,
        io,
      })
      window.__it = { editor, files, saveCalls, saveQueue, io, getViewMode: () => viewMode }
    })

    const r1 = await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 标题\r\n\r\n甲段\r\n\r\n乙段\r\n'
      it.files.loadSession('/tmp/it-a.md', fixture, 1000)
      const ok = await it.files.persistToDisk()
      return { ok, call: it.saveCalls[0], dirty: it.editor.getSession().dirty, fixture }
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.call.path, '/tmp/it-a.md')
    assert.equal(r1.call.text, r1.fixture, 'unedited save must be byte-exact (BOM+CRLF)')
    assert.equal(r1.dirty, false, 'clean after successful save')

    const r2 = await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 标题\r\n\r\n甲段\r\n\r\n乙段\r\n'
      it.files.loadSession('/tmp/it-b.md', fixture, 1000)
      const session = it.editor.getSession()
      const para = session.blocks.find((b) => b.kind === 'paragraph' && b.raw === '甲段')
      it.editor.operations.setBlockRaw(para, '改写')
      const ok = await it.files.persistToDisk()
      return { ok, call: it.saveCalls[it.saveCalls.length - 1], dirty: it.editor.getSession().dirty }
    })
    assert.equal(r2.ok, true)
    assert.equal(r2.call.text, '﻿# 标题\r\n\r\n改写\r\n\r\n乙段\r\n', 'edited save must carry encoded serialization')
    assert.equal(r2.dirty, false)

    const r3 = await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 标题\r\n\r\n甲段\r\n\r\n乙段\r\n'
      it.files.loadSession('/tmp/it-c.md', fixture, 1000)
      const session = it.editor.getSession()
      const para = session.blocks.find((b) => b.kind === 'paragraph' && b.raw === '甲段')
      it.editor.operations.setBlockRaw(para, '改写')
      const baseline = new Map(session.originals)
      it.saveQueue.push({ ok: false })
      const failOk = await it.files.persistToDisk()
      const dirtyAfterFail = it.editor.getSession().dirty
      const originalsAfterFail = {
        size: session.originals.size,
        same: [...session.originals.entries()].every(([k, v]) => baseline.get(k) === v),
      }
      it.saveQueue.push(Promise.reject(new Error('disk full')))
      const threw = await it.files.persistToDisk()
      const dirtyAfterThrow = it.editor.getSession().dirty
      const originalsAfterThrow = {
        size: session.originals.size,
        same: [...session.originals.entries()].every(([k, v]) => baseline.get(k) === v),
      }
      return { failOk, dirtyAfterFail, originalsAfterFail, threw, dirtyAfterThrow, originalsAfterThrow, baselineSize: baseline.size }
    })
    assert.equal(r3.failOk, false)
    assert.equal(r3.dirtyAfterFail, true, 'failed save must keep dirty')
    assert.equal(r3.originalsAfterFail.size, r3.baselineSize, 'failed save must keep originals baseline')
    assert.equal(r3.originalsAfterFail.same, true)
    assert.equal(r3.threw, false)
    assert.equal(r3.dirtyAfterThrow, true, 'thrown save must keep dirty')
    assert.equal(r3.originalsAfterThrow.size, r3.baselineSize, 'thrown save must keep originals baseline')
    assert.equal(r3.originalsAfterThrow.same, true)

    const r4 = await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 标题\r\n\r\n甲段\r\n\r\n乙段\r\n'
      it.files.loadSession('/tmp/it-d.md', fixture, 1000)
      const session = it.editor.getSession()
      const para = session.blocks.find((b) => b.kind === 'paragraph' && b.raw === '甲段')
      it.editor.operations.setBlockRaw(para, '改写')
      const before = session.blocks.map((b) => b.raw).join('')
      const dirtyBefore = session.dirty
      it.io.pickAndRead = async () => null
      await it.files.openFromShellOrDialog()
      const afterCancel = {
        path: session.source?.path,
        text: session.blocks.map((b) => b.raw).join(''),
        dirty: session.dirty,
      }
      it.io.pickAndRead = async () => {
        throw new Error('denied')
      }
      await it.files.openFromShellOrDialog()
      const afterReject = {
        path: session.source?.path,
        text: session.blocks.map((b) => b.raw).join(''),
        dirty: session.dirty,
      }
      it.io.detectEnv = () => 'shell'
      it.files.loadSession('未命名.md', 'x', 1000)
      it.editor.operations.setBlockRaw(session.blocks[0], '改名')
      const unnamedSave = await it.files.persistToDisk()
      it.io.detectEnv = () => 'browser'
      return { before, dirtyBefore, afterCancel, afterReject, unnamedSave, dirtyAfterUnnamed: session.dirty }
    })
    assert.equal(r4.afterCancel.path, '/tmp/it-d.md')
    assert.equal(r4.afterCancel.text, r4.before)
    assert.equal(r4.afterCancel.dirty, r4.dirtyBefore)
    assert.equal(r4.afterReject.path, '/tmp/it-d.md')
    assert.equal(r4.afterReject.text, r4.before)
    assert.equal(r4.afterReject.dirty, r4.dirtyBefore)
    assert.equal(r4.unnamedSave, false, 'cancelled save-as dialog must not write')
    assert.equal(r4.dirtyAfterUnnamed, true)

    await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 标题\r\n\r\n甲段\r\n\r\n乙段\r\n'
      it.files.loadSession('/tmp/it-e.md', fixture, 1000)
      const session = it.editor.getSession()
      const para = session.blocks.find((b) => b.kind === 'paragraph' && b.raw === '甲段')
      it.editor.operations.setBlockRaw(para, '改写')
      window.__callsBefore = it.saveCalls.length
      it.saveQueue.push({ conflict: true }, { ok: true, current_mtime_ms: 9 })
      window.__p = it.files.persistToDisk()
    })
    await page.waitForSelector('.modal-backdrop .modal-footer .btn-primary', { timeout: 5000 })
    await page.click('.modal-backdrop .modal-footer .btn-primary')
    const cancelRes = await page.evaluate(async () => ({
      res: await window.__p,
      dirty: window.__it.editor.getSession().dirty,
      added: window.__it.saveCalls.slice(window.__callsBefore),
    }))
    assert.equal(cancelRes.res, false, 'cancelled conflict must not write')
    assert.equal(cancelRes.dirty, true)
    assert.equal(cancelRes.added.length, 1, 'exactly one attempted save before cancel')
    assert.equal(cancelRes.added[0].force, false)

    await page.evaluate(async () => {
      const it = window.__it
      it.saveQueue.length = 0
      window.__callsBefore = it.saveCalls.length
      it.saveQueue.push({ conflict: true }, { ok: true, current_mtime_ms: 9 })
      window.__p = it.files.persistToDisk()
    })
    await page.waitForSelector('.modal-backdrop .modal-footer .btn-danger', { timeout: 5000 })
    await page.click('.modal-backdrop .modal-footer .btn-danger')
    const overRes = await page.evaluate(async () => ({
      res: await window.__p,
      dirty: window.__it.editor.getSession().dirty,
      added: window.__it.saveCalls.slice(window.__callsBefore),
    }))
    assert.equal(overRes.res, true)
    assert.equal(overRes.added.length, 2, 'conflict then forced retry')
    assert.deepEqual(overRes.added.map((c) => c.force), [false, true])
    assert.equal(overRes.added[1].text, '﻿# 标题\r\n\r\n改写\r\n\r\n乙段\r\n')
    assert.equal(overRes.dirty, false)

    const r5 = await page.evaluate(async () => {
      const it = window.__it
      const fixture = '﻿# 大标题\r\n\r\n长行内容\r\n'
      it.files.loadSession('/tmp/it-big.md', fixture, 5, 4 * 1024 * 1024)
      const modeLocked = it.getViewMode() === 'source'
      const isLarge = it.editor.isLarge()
      const ok = await it.files.persistToDisk()
      const call = it.saveCalls[it.saveCalls.length - 1]
      return { modeLocked, isLarge, ok, call, fixture }
    })
    assert.equal(r5.isLarge, true)
    assert.equal(r5.modeLocked, true, 'large doc must lock source mode')
    assert.equal(r5.ok, true)
    assert.equal(r5.call.text, r5.fixture, 'unedited large save must be byte-exact')

    await page.click('.large-doc-host .cm-content')
    await page.keyboard.press('Home')
    await page.keyboard.insertText('X')
    const r6 = await page.evaluate(async () => {
      const it = window.__it
      const ok = await it.files.persistToDisk()
      return { ok, call: it.saveCalls[it.saveCalls.length - 1] }
    })
    assert.equal(r6.ok, true)
    assert.equal(r6.call.text, '﻿# 大标题\r\n\r\n长行内容\r\nX', 'edited large save must carry CM text with encoding')

    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('fileController+documentEditor: save/load/conflict/large integration')
  } catch (e) {
    fail('controller integration', e)
  }
  await page.close()
}

{
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(() => {
    window.__counts = { controls: 0, scroll: 0 }
    const origReplace = Element.prototype.replaceChildren
    Element.prototype.replaceChildren = function (...args) {
      if (this.matches?.('.window-controls')) window.__counts.controls++
      return origReplace.apply(this, args)
    }
    const origListen = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (type === 'scroll' && this instanceof HTMLElement && this.id === 'content') {
        window.__counts.scroll++
      }
      return origListen.call(this, type, ...rest)
    }
  })
  try {
    await page.goto(URL_ARG, { waitUntil: 'load' })
    await page.waitForSelector('.outline-row', { timeout: 15000 })
    const counts = await page.evaluate(() => window.__counts)
    assert.equal(counts.controls, 1, 'window controls must mount exactly once')
    assert.equal(counts.scroll, 2, 'content scroll listeners: header state + reading events')
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('startup: window controls and scroll handlers mounted once')
  } catch (e) {
    fail('startup duplicate init', e)
  }
  await ctx.close()
}

{
  const { page, errors } = await newPage(URL_ARG + '?doc=huge')
  try {
    await page.waitForSelector('.large-doc-host .cm-editor', { timeout: 30000 })
    ok('huge: .large-doc-host .cm-editor mounted')
  } catch (e) {
    fail('huge doc', e)
  }
  assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
  await page.close()
}
{
  const { page, errors } = await newPage(URL_ARG + '?doc=blank')
  try {
    await page.waitForSelector('#content .cm-content', { timeout: 15000 })
    const mode = await page.evaluate(() => document.documentElement.dataset.mode)
    assert.equal(mode, 'edit', 'blank doc must land in editable mode')
    ok('blank: editable empty doc')
  } catch (e) {
    fail('blank doc', e)
  }
  assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
  await page.close()
}
{
  const { page, errors } = await newPage(URL_ARG + '?doc=empty')
  try {
    await page.waitForSelector('#content', { timeout: 15000 })
    assert.equal(errors.length, 0, `pageerrors: ${errors.join(' | ')}`)
    ok('empty state: no pageerrors')
  } catch (e) {
    fail('empty state', e)
  }
  await page.close()
}

await browser.close()
for (const [s, m] of results) console.log(`${s}  ${m}`)
const failed = results.filter(([s]) => s === 'FAIL')
console.log(failed.length === 0 ? '\nall checks passed' : `\n${failed.length} check(s) failed`)
process.exit(failed.length === 0 ? 0 : 1)
