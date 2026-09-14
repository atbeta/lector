import type { BlockView } from '@lector/core'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'

export interface FindHost {
  getBlocks: () => BlockView[]
  /** 在块里替换并标脏、重解析、重渲染。 */
  replaceInBlock: (id: string, from: string, to: string, all: boolean) => void
  /** 滚动到块。 */
  scrollTo: (id: string) => void
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countMatches(text: string, query: string): number {
  if (!query) return 0
  const re = new RegExp(escapeRegExp(query), 'gi')
  const m = text.match(re)
  return m ? m.length : 0
}

export function findBar(host: FindHost) {
  const bar = document.createElement('div')
  bar.className = 'find-bar'
  bar.innerHTML = `
    <input class="find-input" type="text" placeholder="${t('findPlaceholder')}" aria-label="${t('findPlaceholder')}" />
    <span class="find-count"></span>
    <button class="btn-icon find-prev" data-tip="${t('findPrev')}" aria-label="${t('findPrev')}">${iconSvg('chevronUp')}</button>
    <button class="btn-icon find-next" data-tip="${t('findNext')}" aria-label="${t('findNext')}">${iconSvg('chevronDown')}</button>
    <input class="find-replace" type="text" placeholder="${t('replacePlaceholder')}" aria-label="${t('replacePlaceholder')}" />
    <button class="btn find-replaceall">${t('replaceAll')}</button>
    <button class="find-close btn-icon" data-tip="${t('close')}" aria-label="${t('close')}">${iconSvg('close')}</button>
  `
  const q = bar.querySelector<HTMLInputElement>('.find-input')!
  const count = bar.querySelector<HTMLElement>('.find-count')!
  const rep = bar.querySelector<HTMLInputElement>('.find-replace')!
  const repAll = bar.querySelector<HTMLButtonElement>('.find-replaceall')!
  const close = bar.querySelector<HTMLButtonElement>('.find-close')!
  const prev = bar.querySelector<HTMLButtonElement>('.find-prev')!
  const next = bar.querySelector<HTMLButtonElement>('.find-next')!

  let cursor = 0 // 当前匹配序号（0-based），0 表示未定位

  function matches(): Array<{ id: string; count: number }> {
    const query = q.value
    if (!query) return []
    return host
      .getBlocks()
      .map((b) => ({ id: b.id, count: countMatches(b.raw, query) }))
      .filter((m) => m.count > 0)
  }

  function refresh() {
    const ms = matches()
    const total = ms.reduce((a, m) => a + m.count, 0)
    count.textContent = total === 0 ? t('noResults') : t('matchCount', { n: total })
    for (const m of ms) host.scrollTo(m.id)
  }

  function goto(dir: 1 | -1) {
    const ms = matches()
    if (ms.length === 0) {
      refresh()
      return
    }
    cursor = (cursor + dir + ms.length) % ms.length
    host.scrollTo(ms[cursor]!.id)
  }

  q.addEventListener('input', () => {
    cursor = 0
    refresh()
  })
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goto(e.shiftKey ? -1 : 1)
  })
  next.addEventListener('click', () => goto(1))
  prev.addEventListener('click', () => goto(-1))
  repAll.addEventListener('click', () => {
    const from = q.value
    const to = rep.value
    if (!from) return
    for (const m of matches()) host.replaceInBlock(m.id, from, to, true)
    refresh()
  })
  close.addEventListener('click', () => {
    bar.remove()
    document.removeEventListener('keydown', onKey)
  })

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
  q.focus()
}
