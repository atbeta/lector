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
}

/** 标题栏副标题 / document.title / session 标题占位:三处保持一致。 */
function resetTitle(fileNameEl: HTMLElement): void {
  fileNameEl.textContent = 'Lector'
  fileNameEl.dataset.untitled = 'true'
  document.title = 'Lector'
}

/** 空态:中央放书图标 + 标题 + 提示 + 「打开文件」按钮。 */
export function renderEmptyState(deps: LoadStateDeps): void {
  deps.contentEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'empty-state'
  const icon = document.createElement('div')
  icon.className = 'empty-icon'
  icon.innerHTML = iconSvg('book', 24)
  const title = document.createElement('h2')
  title.textContent = t('emptyTitle')
  const p = document.createElement('p')
  p.textContent = t('emptyHint')
  const btn = document.createElement('button')
  btn.className = 'btn btn-primary'
  btn.innerHTML = `${iconSvg('folder', 16)} ${t('openFile')}`
  btn.addEventListener('click', () => void deps.onOpen())
  wrap.append(icon, title, p, btn)
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
