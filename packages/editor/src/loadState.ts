// 空态 / 加载态渲染。从 main.ts 抽出,展示按 controller 拆分的模式:
//
// - 这两个函数「无依赖」:不读写 session.blocks 之外的状态,操作局限在
//   contentEl / fileNameEl / blocksEl / document.documentElement / document.title。
// - 不需要新文件 import 大量跨模块状态——所以拆出来能瘦下来的行不多,
//   但作为拆分样板(显式 deps / 显式 side-effects / 不污染 main.ts 顶部)值得。
// - 留 main.ts 单独持有: 状态、UI、行为(渲染、focus、defocus 等)的胶水。

import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'

interface LoadStateDeps {
  contentEl: HTMLElement
  fileNameEl: HTMLElement
  blocksEl: { clear: () => void }
  onOpen: () => void | Promise<void>
  /** 最近打开（新在前）。空数组 = 不显示这一块。 */
  recentFiles?: string[]
  onOpenRecent?: (path: string) => void | Promise<void>
  /** 清空最近打开。不给就不渲染清空按钮。 */
  onClearRecent?: () => void | Promise<void>
}

/** 标题栏副标题 / document.title / session 标题占位:三处保持一致。 */
function resetTitle(fileNameEl: HTMLElement): void {
  fileNameEl.textContent = 'Lector'
  fileNameEl.dataset.untitled = 'true'
  document.title = 'Lector'
}

/** 只取文件名部分：列表里主标题是文件名，目录名做次要信息。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 目录部分（含末尾分隔符），用于在文件名下面标出处。 */
function dirName(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  if (parts.length === 0) return ''
  const joined = parts.join('/')
  return joined.length > 42 ? `…${joined.slice(-41)}` : joined
}

/**
 * 最近打开列表。
 *
 * 放在空态里，是因为空态本来就是「你还没打开任何东西」的那一屏，
 * 唯一该回答的问题是「那我打开什么」——最近打开过的文件是这个问题最可能的答案。
 * 之前这份数据只有 macOS 的原生菜单够得着（Windows/Linux 不建原生菜单），
 * 等于壳在维护一份谁也看不到的清单；现在 Windows 也能在这里读，也要能在这里清。
 *
 * 只列 5 条：多了就变成"又一个要滚动的列表"，而它只是空态的一个旁支。
 */
function recentBlock(deps: LoadStateDeps): HTMLElement | null {
  const files = deps.recentFiles ?? []
  if (files.length === 0 || !deps.onOpenRecent) return null
  const box = document.createElement('div')
  box.className = 'recent-block'
  const head = document.createElement('div')
  head.className = 'recent-head'
  const label = document.createElement('div')
  label.className = 'recent-label'
  label.textContent = t('recentTitle')
  head.appendChild(label)
  if (deps.onClearRecent) {
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'recent-clear'
    clear.dataset.tip = t('clearRecentTitle')
    clear.setAttribute('aria-label', t('clearRecentTitle'))
    clear.innerHTML = `${iconSvg('trash', 13)}<span>${t('clearRecent')}</span>`
    clear.addEventListener('click', () => void deps.onClearRecent?.())
    head.appendChild(clear)
  }
  const list = document.createElement('div')
  list.className = 'recent-list'
  for (const path of files.slice(0, 5)) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'recent-item'
    item.dataset.path = path
    item.dataset.tip = path
    const text = document.createElement('span')
    text.className = 'recent-text'
    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = baseName(path)
    const dir = document.createElement('span')
    dir.className = 'recent-dir'
    dir.textContent = dirName(path)
    text.append(name, dir)
    item.appendChild(text)
    item.addEventListener('click', () => void deps.onOpenRecent?.(path))
    list.appendChild(item)
  }
  box.append(head, list)
  return box
}

/** 打开按钮上的快捷键角标：macOS 用 ⌘O，其余 Ctrl O。 */
function openShortcut(): string {
  return /mac/i.test(navigator.userAgent) ? '⌘O' : 'Ctrl O'
}

/** 空态：排版主导（衬线字标 + 定位语 + 墨色主按钮），品牌色不出场。 */
export function renderEmptyState(deps: LoadStateDeps): void {
  deps.contentEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'empty-state'
  const title = document.createElement('h2')
  title.textContent = t('emptyTitle')
  const tagline = document.createElement('p')
  tagline.className = 'empty-tagline'
  tagline.textContent = t('emptyTagline')
  const btn = document.createElement('button')
  btn.className = 'empty-open'
  btn.innerHTML = `${iconSvg('folder', 16)}<span>${t('openFile')}</span><kbd>${openShortcut()}</kbd>`
  btn.addEventListener('click', () => void deps.onOpen())
  wrap.append(title, tagline, btn)
  const recent = recentBlock(deps)
  if (recent) wrap.appendChild(recent)
  deps.contentEl.appendChild(wrap)
  resetTitle(deps.fileNameEl)
  deps.blocksEl.clear()
  document.documentElement.classList.remove('is-loading')
}

/**
 * 加载中间态:中央 22px 转圈 + 「加载中…」。点「打开」/ 冷启动带 argv 时显示
 * ——这时不该有「打开文件」按钮等空态 UI(会让人误以为可以重复点)。
 * loadSession 成功 -> 走内容渲染;出错 / 取消 -> 退回 renderEmptyState。
 */
export function renderLoadingState(deps: LoadStateDeps): void {
  deps.contentEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'loading-state'
  const label = document.createElement('div')
  label.className = 'loading-spinner'
  label.setAttribute('aria-label', t('loading'))
  wrap.appendChild(label)
  deps.contentEl.appendChild(wrap)
  resetTitle(deps.fileNameEl)
  deps.blocksEl.clear()
  document.documentElement.classList.add('is-loading')
}
