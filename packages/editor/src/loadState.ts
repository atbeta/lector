// 空态 / 加载态渲染。从 main.ts 抽出,展示按 controller 拆分的模式:
//
// - 这两个函数「无依赖」:不读写 session.blocks 之外的状态,操作局限在
//   contentEl / fileNameEl / blocksEl / document.documentElement / document.title。
// - 不需要新文件 import 大量跨模块状态——所以拆出来能瘦下来的行不多,
//   但作为拆分样板(显式 deps / 显式 side-effects / 不污染 main.ts 顶部)值得。
// - 留 main.ts 单独持有: 状态、UI、行为(渲染、focus、defocus 等)的胶水。

import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { baseName, dirName } from './paths.ts'

interface LoadStateDeps {
  contentEl: HTMLElement
  fileNameEl: HTMLElement
  blocksEl: { clear: () => void }
  onOpen: () => void | Promise<void>
  /** 「新建」入口。不给就不渲染这个按钮（空态仍然是完整的）。 */
  onNew?: () => void | Promise<void>
  /** 最近打开（新在前）。空数组 = 不显示这一块。 */
  recentFiles?: string[]
  onOpenRecent?: (path: string) => void | Promise<void>
  /** 清空最近打开。不给就不渲染清空按钮。 */
  onClearRecent?: () => void | Promise<void>
}

/** 标题栏副标题 / document.title / session 标题占位:三处保持一致。 */
function resetTitle(fileNameEl: HTMLElement): void {
  // 空态：回到应用名。但**如果壳已经把文档名交给页面**（正在打开某个文件），
  // 就不能写回占位——那正是"先闪 Lector、再出现文档"的中间态。
  const boot = (window as { __lectorTitle?: string }).__lectorTitle
  fileNameEl.textContent = boot ?? 'Lector'
  fileNameEl.dataset.untitled = boot ? 'false' : 'true'
  document.title = boot ?? 'Lector'
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
 *
 * 一条都没有时不留空：放一句轻引导。空态本就是极简扉页，但"空得没有任何信息"
 * 会被读成没做完；这句话把空白变成有意义的留白，也顺带告诉用户这里会长出什么。
 */
function recentBlock(deps: LoadStateDeps): HTMLElement | null {
  if (!deps.onOpenRecent) return null
  const files = deps.recentFiles ?? []
  const box = document.createElement('div')
  box.className = 'recent-block'
  if (files.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'recent-empty'
    hint.textContent = t('recentEmptyHint')
    box.appendChild(hint)
    return box
  }
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
    // 不设 data-tip：列表项本身内联显示文件名 + 目录，悬浮再弹一遍完整路径是噪音。
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

/**
 * 空态：真 logo + 定位语 + 主/次按钮。
 * 扉页上不印字标——应用名在窗口标题里淡淡地待着就够了，
 * 这里让 logo 和一句定位语说话，比再喊一遍名字安静。
 */
export function renderEmptyState(deps: LoadStateDeps): void {
  deps.contentEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'empty-state'
  const logo = document.createElement('img')
  logo.className = 'empty-logo'
  logo.src = '/lector-mark.svg'
  logo.alt = t('emptyTitle')
  const tagline = document.createElement('p')
  tagline.className = 'empty-tagline'
  tagline.textContent = t('emptyTagline')
  const btn = document.createElement('button')
  btn.className = 'empty-open'
  // 按钮上不印快捷键：键位查询统一在键盘面板（见 shortcutsPanel.ts）。
  // 印在按钮上会让每个按钮都拖一条尾巴，而且两处（按钮 + 面板）迟早不一致。
  btn.innerHTML = `${iconSvg('fileText', 16)}<span>${t('openFile')}</span>`
  btn.addEventListener('click', () => void deps.onOpen())
  // 「新建」与「打开文件」主次分明：打开是主要动作（阅读优先），新建是次要动作。
  // 记事本能新建，阅读器却只能打开，用户"想创建却创建不了"是真实会遇到的。
  const actions = document.createElement('div')
  actions.className = 'empty-actions'
  actions.appendChild(btn)
  if (deps.onNew) {
    const newBtn = document.createElement('button')
    newBtn.className = 'empty-new'
    newBtn.innerHTML = `${iconSvg('filePlus', 16)}<span>${t('newFile')}</span>`
    newBtn.addEventListener('click', () => void deps.onNew?.())
    actions.appendChild(newBtn)
  }
  wrap.append(logo, tagline, actions)
  const recent = recentBlock(deps)
  if (recent) wrap.appendChild(recent)
  deps.contentEl.appendChild(wrap)
  resetTitle(deps.fileNameEl)
  deps.blocksEl.clear()
  // 空态撤掉「纸页」：#content 的纸面底色与两侧描边在正文阅读时是页面感，
  // 在空态里则是两条死灰带——整窗都是画布，内容才像「印在书上」而不是「贴在框里」。
  document.documentElement.classList.add('is-empty')
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
  document.documentElement.classList.remove('is-empty')
  document.documentElement.classList.add('is-loading')
}
