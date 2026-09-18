import type { BlockView } from '@lector/core'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { applyFindHighlight, clearFindHighlight, focusFindHit } from './findHighlight.ts'
import { compileFind, DEFAULT_FIND_OPTIONS, type FindOptions, countFind } from './findMatch.ts'

export interface FindHost {
  getBlocks: () => BlockView[]
  /** 在块里替换并标脏、重解析、重渲染。 */
  replaceInBlock: (id: string, from: string, to: string, all: boolean, opts: FindOptions) => void
  /** 滚动到块。 */
  scrollTo: (id: string) => void
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 当前打开着的查找栏的「关闭器」。换文档 / 关文档时要能主动拆掉它，
// 而不是靠查 DOM 手动清理——那样会漏掉实例自己的 keydown 监听，留下幽灵。
let activeClose: (() => void) | null = null

/** 主动关闭当前查找栏：换文档 / 关文档时调用（与 X、Esc 走同一条清理路径）。 */
export function closeFindBar(): void {
  activeClose?.()
}

export function findBar(host: FindHost) {
  const bar = document.createElement('div')
  bar.className = 'find-bar'
  // 三个开关用 Aa / \b / .* 这组符号而不是文字：
  // 它们是查找界面里跨语言通用的写法（VS Code、浏览器都是这套），
  // 翻译成「区分大小写」反而占宽且不一眼可辨。含义交给 tooltip。
  bar.innerHTML = `
    <div class="find-row">
      <button class="find-expand btn-icon" aria-expanded="false" aria-label="${t('findToggleReplace')}">${iconSvg('chevronDown', 16)}</button>
      <input class="find-input" type="text" placeholder="${t('findPlaceholder')}" aria-label="${t('findPlaceholder')}" />
      <div class="find-toggles">
        <button class="find-toggle find-case" data-tip="${t('findCase')}" aria-label="${t('findCase')}" aria-pressed="false">Aa</button>
        <button class="find-toggle find-word" data-tip="${t('findWhole')}" aria-label="${t('findWhole')}" aria-pressed="false">\\b</button>
        <button class="find-toggle find-regex" data-tip="${t('findRegex')}" aria-label="${t('findRegex')}" aria-pressed="false">.*</button>
      </div>
      <div class="find-nav">
        <span class="find-count" aria-live="polite"></span>
        <button class="btn-icon find-prev" aria-label="${t('findPrev')}">${iconSvg('chevronUp', 16)}</button>
        <button class="btn-icon find-next" aria-label="${t('findNext')}">${iconSvg('chevronDown', 16)}</button>
      </div>
      <button class="find-close btn-icon" aria-label="${t('close')}">${iconSvg('close', 16)}</button>
    </div>
    <div class="find-replace-row" hidden>
      <input class="find-replace" type="text" placeholder="${t('replacePlaceholder')}" aria-label="${t('replacePlaceholder')}" />
      <button class="btn btn-ghost find-replaceall">${t('replaceAll')}</button>
    </div>
  `
  const q = bar.querySelector<HTMLInputElement>('.find-input')!
  const count = bar.querySelector<HTMLElement>('.find-count')!
  const rep = bar.querySelector<HTMLInputElement>('.find-replace')!
  const repAll = bar.querySelector<HTMLButtonElement>('.find-replaceall')!
  const close = bar.querySelector<HTMLButtonElement>('.find-close')!
  const expand = bar.querySelector<HTMLButtonElement>('.find-expand')!
  const replaceRow = bar.querySelector<HTMLElement>('.find-replace-row')!
  const prev = bar.querySelector<HTMLButtonElement>('.find-prev')!
  const next = bar.querySelector<HTMLButtonElement>('.find-next')!
  const caseBtn = bar.querySelector<HTMLButtonElement>('.find-case')!
  const wordBtn = bar.querySelector<HTMLButtonElement>('.find-word')!
  const regexBtn = bar.querySelector<HTMLButtonElement>('.find-regex')!

  let cursor = 0 // 当前匹配序号（0-based）
  const opts: FindOptions = { ...DEFAULT_FIND_OPTIONS }

  function matches(): Array<{ id: string; count: number }> {
    const query = q.value
    if (!query) return []
    return host
      .getBlocks()
      .map((b) => ({ id: b.id, count: countFind(b.raw, query, opts) }))
      .filter((m) => m.count > 0)
  }

  /**
   * 命中展开成「按处」的列表：{块, 块内第几个}。
   *
   * 旧版是按**块**跳转的——一个块里有 5 处命中，翻页时却只跳一次，
   * 用户按下一处会「卡住不动」；而且计数只报总数，看不出现在是第几处。
   * 查找的最小单位是「一处命中」，不是「一个块」。
   */
  function occurrences(): Array<{ id: string; nth: number }> {
    const out: Array<{ id: string; nth: number }> = []
    for (const m of matches()) {
      for (let i = 0; i < m.count; i++) out.push({ id: m.id, nth: i })
    }
    return out
  }

  /** 正文容器：高亮只落在正文区，不碰顶栏/侧栏/浮层 */
  const contentRoot = (): HTMLElement => document.getElementById('content') ?? document.body

  function blockEl(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#content .block[data-block-id="${id}"]`)
  }

  /** 高亮 + 把第 cursor 处标成当前（找不到就退回第 0 处） */
  function paint(list: Array<{ id: string; nth: number }>): void {
    applyFindHighlight(contentRoot(), q.value, opts)
    const target = list[cursor]
    if (!target) return
    const el = blockEl(target.id)
    if (el) focusFindHit(el, target.nth)
  }

  function updateCount(total: number): void {
    const c = compileFind(q.value, opts)
    if (q.value && !c.ok) {
      // 无效/危险模式**明说**，不要静默当成 0 处：那会让人以为"文档里没有"
      count.textContent = c.error === 'risky-regex' ? t('findRiskyRegex') : t('findInvalidRegex')
      count.dataset.bad = 'true'
      return
    }
    delete count.dataset.bad
    if (total === 0) {
      count.textContent = q.value ? t('noResults') : ''
      return
    }
    // 短格式 1/12：长句会把浮层撑开一截，空查询时还占着 52px 空洞
    count.textContent = t('matchPosition', { i: cursor + 1, n: total })
  }

  function refresh(): void {
    const ms = matches()
    const total = ms.reduce((a, m) => a + m.count, 0)
    if (cursor >= total) cursor = 0
    updateCount(total)
    prev.disabled = next.disabled = total === 0
    repAll.disabled = total === 0
    for (const m of ms) host.scrollTo(m.id)
    // 空查询/无效模式时先把上一轮的标记拆干净（否则残留在正文里）
    if (total === 0) clearFindHighlight(contentRoot())
    else paint(occurrences())
  }

  function goto(dir: 1 | -1): void {
    const list = occurrences()
    if (list.length === 0) {
      refresh()
      return
    }
    cursor = (cursor + dir + list.length) % list.length
    updateCount(list.length)
    const target = list[cursor]!
    host.scrollTo(target.id)
    const el = blockEl(target.id)
    if (el) focusFindHit(el, target.nth)
    // scrollTo 会触发重绘时标记会被清掉，重画一次兜住
    paint(list)
  }

  /** 开关：翻状态 + 同步 aria + 从头重新搜（光标位置在原模式下无意义） */
  function toggle(btn: HTMLButtonElement, key: keyof FindOptions): void {
    opts[key] = !opts[key]
    btn.setAttribute('aria-pressed', String(opts[key]))
    btn.classList.toggle('active', opts[key])
    cursor = 0
    refresh()
  }

  q.addEventListener('input', () => {
    cursor = 0
    refresh()
  })
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goto(e.shiftKey ? -1 : 1)
  })
  caseBtn.addEventListener('click', () => toggle(caseBtn, 'caseSensitive'))
  wordBtn.addEventListener('click', () => toggle(wordBtn, 'wholeWord'))
  regexBtn.addEventListener('click', () => toggle(regexBtn, 'regex'))
  next.addEventListener('click', () => goto(1))
  prev.addEventListener('click', () => goto(-1))
  // 替换默认收起：多数时候只是找，不替换。展开后把焦点给替换框。
  expand.addEventListener('click', () => {
    const open = replaceRow.hidden
    replaceRow.hidden = !open
    expand.setAttribute('aria-expanded', String(open))
    if (open) rep.focus()
  })
  repAll.addEventListener('click', () => {
    const from = q.value
    const to = rep.value
    if (!from) return
    for (const m of matches()) host.replaceInBlock(m.id, from, to, true, { ...opts })
    refresh()
  })
  close.addEventListener('click', closeBar)
  activeClose = closeBar

  function closeBar(): void {
    // 关掉查找就把标记拆干净：留在正文里的黄色块会让人以为文档里真有高亮
    clearFindHighlight(contentRoot())
    bar.remove()
    document.removeEventListener('keydown', onKey)
    if (activeClose === closeBar) activeClose = null
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close.click()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      q.focus()
      q.select()
    }
  }
  document.addEventListener('keydown', onKey)

  document.body.appendChild(bar)
  refresh()
  q.focus()
}
