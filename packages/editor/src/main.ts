import {
  applyEncoding,
  createSourceDocument,
  adjacentFocusableId,
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlocks,
  parseBlockRoots,
  parseOne,
  serialize,
  type BlockKind,
  type BlockView,
  countText,
  formatCount,
  readingMinutes,
  type SourceDocument,
} from '@lector/core'
import {
  bindTitlebar,
  detectEnv,
  pickAndRead,
  pickSavePath,
  read,
  save,
  watch,
  type SaveResult,
  takePendingOpen,
  bindDocument,
  saveImage,
  onOpen,
  onFileChanged,
  onMenu,
  shellAssetResolver,
  openExternal,
} from '@lector/shell-web'
import { mountEditor, type CmHandle } from './cm.ts'
import type { EditorView } from '@codemirror/view'
import { renderBlockHtml, safeHref, preRenderMath } from './mdastHtml.ts'
import { renderMermaidSvg } from './mermaid.ts'
import { setAssetResolver, setCurrentMdPath } from './asset.ts'
import { initSettings, resetFontSize, stepFontSize, getSettings } from './settings.ts'
import { openSettingsModal } from './settingsModal.ts'
import { findBar, escapeRegExp } from './findBar.ts'
import { redo, undo } from '@codemirror/commands'
import { iconSvg } from './icons.ts'
import { mountHeaderScrollState, mountTitlebarInset, mountWindowControls } from './chrome.ts'
import { createSidebar } from './sidebar.ts'
import { openTableEditor } from './tableEditor.ts'
import { mountTip } from './tip.ts'
import { mountLightbox, showInLightbox, showSvgInLightbox } from './lightbox.ts'
import { hideContextMenu, showContextMenu, type ContextMenuItem } from './contextMenu.ts'
import { renderEmptyState as renderEmptyStateView, renderLoadingState as renderLoadingStateView } from './loadState.ts'
import {
  getPosition,
  parsePositions,
  prunePositions,
  recordPosition,
  type PositionMap,
} from './readingPosition.ts'
import { t } from './i18n.ts'
import { mod, modShift } from './keys.ts'
import { openAppearancePop } from './appearancePop.ts'
import { chooseConflict, confirmDiscard } from './dialog.ts'
import { applyKeyedChildren } from './reconcile.ts'
import { createUndoStack } from './undoStack.ts'
import { sessionIsDirty } from './sessionDirty.ts'
import {
  fileToBase64,
  imageContentHash,
  imageMarkdown,
  isImageMime,
  pastedFileName,
  safeDropName,
  findDedupImage,
  rememberImage,
} from './imageInsert.ts'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/source-serif-4'
import './styles/app.css'

interface Session {
  source: SourceDocument | null
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean
  /** 插入/删除块后，即使各块 raw 未改也算脏。 */
  structuralDirty: boolean
  /** 解析时的原始 raw，用于判定 dirty（还原到原文即不算脏）。 */
  originals: Map<string, string>
}

const session: Session = {
  source: null,
  blocks: [],
  focusedId: null,
  dirty: false,
  structuralDirty: false,
  originals: new Map(),
}

const contentEl = document.getElementById('content')!
const dirtyDot = document.getElementById('dirty-dot')!
const fileNameEl = document.getElementById('file-name')!
const openBtn = document.getElementById('open-btn')!
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const modeSwitchEl = document.getElementById('mode-switch')!
const appearanceBtn = document.getElementById('appearance-btn')!
const settingsBtn = document.getElementById('settings-btn')!
const outlineBtn = document.getElementById('outline-btn')!
const findBtn = document.getElementById('find-btn')!
const statusLeft = document.getElementById('status-left')!
const statusRight = document.getElementById('status-right')!

openBtn.innerHTML = iconSvg('folder', 16)
openBtn.setAttribute('aria-label', t('openAria'))
openBtn.dataset.tip = t('openAria')
saveBtn.innerHTML = iconSvg('save', 16)
saveBtn.setAttribute('aria-label', t('saveAria'))
saveBtn.dataset.tip = t('saveAria')
// 保存按钮的禁用态由 refreshSaveButton() 按 dirty 维护（见下）。
saveBtn.disabled = true
outlineBtn.innerHTML = iconSvg('outline', 16)
outlineBtn.setAttribute('aria-label', t('outlineAria'))
outlineBtn.dataset.tip = `${t('outlineAria')} (${modShift('O')})`
findBtn.innerHTML = iconSvg('search', 16)
findBtn.setAttribute('aria-label', t('findAria'))
findBtn.dataset.tip = `${t('findAria')} (${mod('F')})`
// 「外观」按钮：图标用 Aa（打字/排版），不是月亮/太阳——
// 它打开的不只是明暗，还有阅读主题。太阳月亮会把功能说小一半。
appearanceBtn.innerHTML = iconSvg('type', 16)
appearanceBtn.setAttribute('aria-label', t('themeAria'))
appearanceBtn.dataset.tip = t('themeAria')
settingsBtn.innerHTML = iconSvg('settings', 16)
settingsBtn.setAttribute('aria-label', t('settingsAria'))
settingsBtn.dataset.tip = `${t('settingsAria')} (${mod(',')})`
openBtn.dataset.tip = `${t('openAria')} (${mod('O')})`
dirtyDot.dataset.tip = t('dirtyTitle')
// 无标题栏：整条顶栏是拖拽区。绑定与双击语义都在 bindTitlebar / chrome.ts，
// 这里只负责把元素交出去（旧版是一个 .titlebar-drag 覆盖层，已并入顶栏本身）。
const titlebarEl = document.getElementById('titlebar')
if (titlebarEl) bindTitlebar(titlebarEl)

// ───────────── 三视图模式 read / edit / source ─────────────
//
// 默认 read——多数场景是「读」不是「改」。
//
// read:   只读预览。点块不进编辑；mermaid / 图片点开放大。
// edit:   预览 + 点块就地编辑（改哪块点哪块）。这是「顺手能改」的主路径。
// source: 全篇等宽源码，点块进该块的源码编辑。通读原文 / 批量改格式用。
//
// 三档**常驻**在顶栏右侧的分段控件里，当前档一眼可见。
// 旧版是一个三态循环按钮，按钮上画的是「下一个模式」的图标，用户永远要问
// 「我现在在哪一档」；而且第三档叫「分屏」——屏幕上并没有第二条栏，
// 名字在承诺一件不存在的事。名字与档位一起改了：阅读 / 编辑 / 源码。
//
// 状态走 html[data-mode]——样式 / 点击 / 快捷键都只看这一个属性。
// 快捷键：⌘1 / ⌘2 / ⌘3 直选，⌘E 循环。
type ViewMode = 'read' | 'edit' | 'source'
let viewMode: ViewMode = 'read'

/** 顺序 = 分段控件里的顺序 = ⌘1/⌘2/⌘3 的顺序。 */
const VIEW_MODES: readonly ViewMode[] = ['read', 'edit', 'source']
const VIEW_ICON: Record<ViewMode, string> = { read: 'eye', edit: 'pencil', source: 'code' }
const VIEW_NUM: Record<ViewMode, string> = { read: '1', edit: '2', source: '3' }

function viewLabel(m: ViewMode): string {
  return m === 'read' ? t('modeLabelRead') : m === 'edit' ? t('modeLabelEdit') : t('modeLabelSource')
}

function nextViewMode(m: ViewMode): ViewMode {
  return VIEW_MODES[(VIEW_MODES.indexOf(m) + 1) % VIEW_MODES.length]!
}

/**
 * 分段控件：三档常驻，当前档常亮。
 *
 * 图标 + 文字都上：只有图标时「哪一档是什么」要靠猜（旧版图标画的还是下一档，
 * 更猜不出来）；只有文字时顶栏会变成一排字。窄窗口下只留图标，由 CSS 决定。
 */
function buildModeSwitch(): void {
  modeSwitchEl.replaceChildren()
  modeSwitchEl.setAttribute('role', 'radiogroup')
  modeSwitchEl.setAttribute('aria-label', t('modeAria'))
  for (const m of VIEW_MODES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mode-opt'
    btn.dataset.mode = m
    btn.setAttribute('role', 'radio')
    btn.dataset.tip = `${viewLabel(m)} (${mod(VIEW_NUM[m])})`
    const icon = document.createElement('span')
    icon.className = 'mode-opt-icon'
    icon.innerHTML = iconSvg(VIEW_ICON[m], 15)
    const label = document.createElement('span')
    label.className = 'mode-opt-label'
    label.textContent = viewLabel(m)
    btn.append(icon, label)
    btn.addEventListener('click', () => setViewMode(m))
    modeSwitchEl.appendChild(btn)
  }
}

function applyModeUI(): void {
  document.documentElement.dataset.mode = viewMode
  for (const btn of modeSwitchEl.querySelectorAll<HTMLButtonElement>('.mode-opt')) {
    const on = btn.dataset.mode === viewMode
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-checked', String(on))
    // 分段控件是单选组：Tab 落在当前档上
    btn.tabIndex = on ? 0 : -1
  }
  refreshSaveButton()
  renderStatus()
}

/**
 * 保存按钮：**始终在位**，只在「确实有东西可存」时点亮。
 *
 * 旧版是 read 模式下整个隐藏——于是「编辑过一篇 → ⌘1 切回阅读 → 想存」
 * 时按钮凭空消失。一个会消失的动作按钮比一个灰着的更让人困惑：
 * 用户不知道是自己看错了，还是文档没了。
 *
 * 可用性只跟 dirty 有关，跟视图模式无关：存盘是写文件，不是视图动作。
 */
function refreshSaveButton(): void {
  const canSave = session.dirty
  saveBtn.disabled = !canSave
  saveBtn.dataset.tip = canSave ? `${t('saveAria')} (${mod('S')})` : t('saveNothing')
}

function setViewMode(next: ViewMode): void {
  if (viewMode === next) return
  const prev = viewMode
  viewMode = next
  if (next === 'read') {
    // 退出可编辑态：清 focus，否则那个块仍作为 CM 嵌着，下次回 read 还在
    defocus()
  }
  applyModeUI()
  // 源码与预览是两套渲染，来去都要重画
  if (next === 'source' || prev === 'source') void render()
}

function toggleMode(): void {
  setViewMode(nextViewMode(viewMode))
}

buildModeSwitch()
// 初始状态：默认只读。applyModeUI 设好 data-mode / 分段选中态 / 保存按钮。
applyModeUI()

// 侧栏 = 当前文档的目录。停靠/浮层两种形态由 sidebar.ts 按窗口宽度决定。
const sidebar = createSidebar({
  onToggle: (open) => {
    outlineBtn.classList.toggle('active', open)
    outlineBtn.setAttribute('aria-pressed', String(open))
  },
})

/**
 * 大纲签名：标题的 id / 级别 / 文字。变了就说明大纲该重建。
 * 紧挨着侧栏声明放：这个变量在模块初始化期就可能被读到，声明位置不能再往下挪。
 */
let lastOutlineSignature = ''


/** 从块内 mdast 提取纯文本（标题用）。 */
function headingText(mdast: unknown): string {
  if (Array.isArray(mdast)) return mdast.map(headingText).join(' ')
  const walk = (n: unknown): string => {
    if (!n || typeof n !== 'object') return ''
    const node = n as { type?: string; value?: string; children?: unknown[] }
    if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
    return (node.children ?? []).map(walk).join('')
  }
  return walk(mdast)
}

// 大纲行 → 块 id，供滚动时反查当前小节
const outlineRows = new Map<string, HTMLButtonElement>()
/**
 * 折叠状态：key 是「层级:标题文字」，不是块 id。
 * 块 id 在每次重新解析后都会变（改一个字就换一批 id），拿 id 存折叠状态
 * 等于每次编辑都丢失。层级 + 文字是读者能感知的稳定键。
 */
const outlineCollapsed = new Set<string>()
/** 每个标题节点的 DOM 句柄：折叠时要就地改属性，不能重建整棵树（会丢焦点）。 */
const outlineNodes = new Map<string, { node: HTMLElement; key: string }>()
let activeHeadingId: string | null = null

const OUTLINE_COLLAPSE_KEY = 'lector-outline-collapsed'

function outlineKey(depth: number, text: string): string {
  return `${depth}:${text}`
}

function readCollapsedPref(): void {
  try {
    const raw = localStorage.getItem(OUTLINE_COLLAPSE_KEY)
    if (!raw) return
    const list = JSON.parse(raw) as unknown
    if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') outlineCollapsed.add(k)
  } catch {
    /* 偏好读不出来就当全展开，不影响阅读 */
  }
}

function writeCollapsedPref(): void {
  try {
    localStorage.setItem(OUTLINE_COLLAPSE_KEY, JSON.stringify([...outlineCollapsed]))
  } catch {
    /* 存不下就当本次会话有效 */
  }
}

interface OutlineHeading {
  id: string
  depth: number
  text: string
}

interface OutlineNode extends OutlineHeading {
  children: OutlineNode[]
}

/**
 * 标题列表 → 树。用栈而不是递归：depth 回退时弹栈，
 * 一段循环就能说清「谁是谁的子节」，递归反而要传递上下文。
 */
function buildOutlineTree(headings: OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const h of headings) {
    const node: OutlineNode = { ...h, children: [] }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= h.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

/** 把折叠状态贴到一个节点上（数据 → DOM 的唯一出口）。 */
function applyCollapsed(nodeEl: HTMLElement, key: string): void {
  const collapsed = outlineCollapsed.has(key)
  nodeEl.dataset.collapsed = String(collapsed)
  const twisty = nodeEl.querySelector<HTMLButtonElement>(':scope > .outline-line > .outline-twisty')
  if (!twisty) return
  twisty.setAttribute('aria-expanded', String(!collapsed))
  twisty.dataset.tip = collapsed ? t('outlineExpand') : t('outlineCollapse')
  twisty.setAttribute('aria-label', collapsed ? t('outlineExpand') : t('outlineCollapse'))
}

function setOutlineCollapsed(key: string, collapsed: boolean): void {
  if (collapsed) outlineCollapsed.add(key)
  else outlineCollapsed.delete(key)
  writeCollapsedPref()
  // 就地更新，不重建：键盘用户在三角上按 Enter 之后，焦点不能丢
  for (const [, entry] of outlineNodes) {
    if (entry.key === key) applyCollapsed(entry.node, key)
  }
}

/**
 * 把当前小节所在的那条分支展开。
 *
 * 只在「读到哪」变化时调用（setActiveHeading / 重建大纲），不在每次贴类名时调用——
 * 否则用户手动收起当前所在的那一组，下一次滚动立刻又被展开，等于收不起来。
 */
function revealActiveBranch(): void {
  if (!activeHeadingId) return
  let parent = outlineRows.get(activeHeadingId)?.closest('.outline-node')?.parentElement ?? null
  let changed = false
  while (parent) {
    const nodeEl = parent.closest<HTMLElement>('.outline-node')
    if (!nodeEl) break
    const row = nodeEl.querySelector<HTMLButtonElement>(':scope > .outline-line > .outline-row')
    const id = row?.dataset.blockId
    const entry = id ? outlineNodes.get(id) : undefined
    if (entry && outlineCollapsed.has(entry.key)) {
      outlineCollapsed.delete(entry.key)
      changed = true
      applyCollapsed(nodeEl, entry.key)
    }
    parent = nodeEl.parentElement
  }
  if (changed) writeCollapsedPref()
}

function renderOutline() {
  const headings: OutlineHeading[] = session.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => {
      return { id: b.id, depth: headingDepth(b) ?? 1, text: headingText(b.mdast) || b.raw.trim() }
    })
  sidebar.body.innerHTML = ''
  outlineRows.clear()
  outlineNodes.clear()
  if (headings.length === 0) {
    const p = document.createElement('p')
    p.className = 'outline-empty'
    p.textContent = t('outlineEmpty')
    sidebar.body.appendChild(p)
    return
  }

  const list = document.createElement('div')
  list.className = 'outline-list'

  const build = (nodes: OutlineNode[], host: HTMLElement): void => {
    for (const n of nodes) {
      const nodeEl = document.createElement('div')
      nodeEl.className = 'outline-node'
      const line = document.createElement('div')
      line.className = 'outline-line'

      const key = outlineKey(n.depth, n.text)
      const hasKids = n.children.length > 0

      // 三角与占位同宽：没有子节的标题也要让出这一列，否则同一级的文字对不齐
      const twisty = document.createElement('button')
      twisty.type = 'button'
      twisty.className = hasKids ? 'outline-twisty' : 'outline-twisty outline-twisty-empty'
      if (hasKids) {
        twisty.innerHTML = iconSvg('chevronDown', 14)
        twisty.addEventListener('click', (e) => {
          e.stopPropagation()
          setOutlineCollapsed(key, !outlineCollapsed.has(key))
        })
      } else {
        twisty.tabIndex = -1
        twisty.setAttribute('aria-hidden', 'true')
      }

      const row = document.createElement('button')
      row.className = 'outline-row'
      row.dataset.depth = String(n.depth)
      row.dataset.blockId = n.id
      row.textContent = n.text
      // 长标题在窄侧栏里会被截断，tips 让悬停能看全
      row.dataset.tip = n.text
      row.addEventListener('click', () => {
        // 定位到页面最上，不是居中。
        // 「跳到某一节」在阅读器里的含义是「从这一节开始读」，居中会把上一节
        // 的尾巴留在上方，读者还得自己往回找。文档站的锚点跳转（MDN、GitHub）
        // 也一律是顶部对齐，这是读者的既有预期。
        jumpToHeading(n.id)
      })

      line.append(twisty, row)
      nodeEl.appendChild(line)

      // 登记必须在递归子节点**之前**。
      // outlineRows 的插入序就是全文档顺序，两个地方依赖它：
      //   1. applyActiveClasses 从当前项往前扫，靠「深度严格递减」找祖先链；
      //   2. updateActiveHeading 按这个顺序找「已越过阅读线的最后一个标题」。
      // 先递归再登记就成了后序（子节点在前、父节点在后），
      // 表现是「读到 h2 时上级不高亮」「滚动反查定位到错误的小节」——
      // 都是静默错，只有断言和肉眼对照大纲才看得出来。
      outlineRows.set(n.id, row)
      outlineNodes.set(n.id, { node: nodeEl, key })
      applyCollapsed(nodeEl, key)

      if (hasKids) {
        const kids = document.createElement('div')
        kids.className = 'outline-kids'
        nodeEl.appendChild(kids)
        build(n.children, kids)
      }
      host.appendChild(nodeEl)
    }
  }

  build(buildOutlineTree(headings), list)
  sidebar.body.appendChild(list)
  // 重绘后必须把高亮重新贴回新行：
  // setActiveHeading 里有「id 未变则跳过」的短路，而这里的行是新建的、
  // 不带任何类——所以要先无条件贴一次，再让滚动反查刷新。
  revealActiveBranch()
  applyActiveClasses()
  updateActiveHeading()
}

/** 跳到某小节：顶部对齐，并留一点呼吸（由 #content 的 scroll-padding-top 提供）。 */
function jumpToHeading(id: string): void {
  const el = blocksEl.get(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // 立刻把高亮切过去：平滑滚动期间用户已经认为自己在那一节了，
  // 等滚动结束再变会显得迟滞。
  setActiveHeading(id, { reveal: true })
}

/**
 * 把「当前小节」与「它所属的上级小节」贴到行上。
 *
 * 上级高亮解决的是长文档的方向感：读到一个 h3 时，能一眼看出它挂在哪个 h2/h1 下。
 * 只用文字变深表达，不加指示条——指示条是「你在这里」，上级只是「你在这条线上」。
 */
function applyActiveClasses(): void {
  const ids = [...outlineRows.keys()]
  const idx = activeHeadingId ? ids.indexOf(activeHeadingId) : -1
  const ancestors = new Set<string>()
  if (idx > 0) {
    // 从当前项往前找，深度严格递减的那些就是它的祖先链
    let depth = Number(outlineRows.get(ids[idx]!)?.dataset.depth ?? 1)
    for (let i = idx - 1; i >= 0 && depth > 1; i--) {
      const id = ids[i]!
      const d = Number(outlineRows.get(id)?.dataset.depth ?? 1)
      if (d < depth) {
        ancestors.add(id)
        depth = d
      }
    }
  }
  for (const [rowId, row] of outlineRows) {
    const on = rowId === activeHeadingId
    row.classList.toggle('active', on)
    row.classList.toggle('ancestor', !on && ancestors.has(rowId))
    if (on) row.setAttribute('aria-current', 'true')
    else row.removeAttribute('aria-current')
  }
}

function setActiveHeading(id: string | null, opts: { reveal?: boolean } = {}): void {
  if (id === activeHeadingId && !opts.reveal) return
  activeHeadingId = id
  // 读到的小节若藏在收起的分支里，先把它所在的分支展开——否则「读到哪了」看不见
  revealActiveBranch()
  applyActiveClasses()
  if (opts.reveal && id) {
    // 大纲很长时，当前项要自动滚进可视区（只滚侧栏，不动正文）
    outlineRows.get(id)?.scrollIntoView({ block: 'nearest' })
  }
}

/**
 * 滚动反查当前小节：取「已经越过阅读线」的最后一个标题。
 *
 * 阅读线定在容器顶部下方 72px：标题刚进视口时就切过去太早
 * （读者还在看上一节的最后一段），太晚则高亮总是慢半拍。
 */
function updateActiveHeading(): void {
  if (outlineRows.size === 0) return
  const headingIds = [...outlineRows.keys()]
  const contentTop = contentEl.getBoundingClientRect().top
  const scrollTop = contentEl.scrollTop
  const atBottom =
    contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2

  let active: string | null = null
  if (atBottom) {
    // 到底了：最后一节未必能滚到阅读线（后面内容不够），
    // 不特判的话最后一节永远高亮不到。
    active = headingIds[headingIds.length - 1] ?? null
  } else {
    const line = scrollTop + 72
    for (const id of headingIds) {
      const el = blocksEl.get(id)
      if (!el) continue
      const top = el.getBoundingClientRect().top - contentTop + scrollTop
      if (top <= line) active = id
      else break
    }
  }
  setActiveHeading(active)
}

function toggleOutline() {
  sidebar.toggle()
  if (sidebar.isOpen()) renderOutline()
}

const blocksEl = new Map<string, HTMLElement>()
let cm: CmHandle | null = null

const liveText = new Map<string, string>()
let seq = 0
function nextId(): string {
  seq += 1
  return `e${seq}`
}

/** 取文件名：Windows 路径是反斜杠，只 split('/') 会把整条路径留在标题上。 */
// ── 阅读位置记忆 ──
// 阅读器的刚需：长文档关掉再打开不该回到顶部。
// 存 localStorage 而不是设置里：这是每次滚动都在变的会话状态，不属于用户配置。
const POSITIONS_KEY = 'lector-positions'

function loadPositions(): PositionMap {
  try {
    return parsePositions(localStorage.getItem(POSITIONS_KEY))
  } catch {
    return {}
  }
}

function savePositions(map: PositionMap): void {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(prunePositions(map)))
  } catch {
    /* 忽略持久化失败：位置记忆丢了不影响正确性 */
  }
}

let positions: PositionMap = loadPositions()
let restoreTimer: number | null = null

/** 取回并应用上次的阅读位置。只在有记录且位置仍合理时滚动。 */
function restoreReadingPosition(): void {
  const path = session.source?.path
  if (!path) return
  const top = getPosition(positions, path, contentEl.scrollHeight)
  if (top === null) return
  // 等一帧：render() 刚改完 DOM，同一帧里设 scrollTop 会被随后的布局吃掉
  requestAnimationFrame(() => {
    contentEl.scrollTop = top
    updateActiveHeading()
  })
}

/**
 * 记录当前位置。
 *
 * 防抖 400ms：滚动时每帧写 localStorage 会拖慢滚动，
 * 而这个值只需要在「用户停下来」时准确。
 * 写之前按文档长度裁剪：编辑让文档变长后，旧的绝对偏移仍能用，
 * 所以这里不按比例换算（换算反而会把位置算丢）。
 */
function scheduleRecordPosition(): void {
  if (restoreTimer !== null) window.clearTimeout(restoreTimer)
  restoreTimer = window.setTimeout(() => {
    restoreTimer = null
    const path = session.source?.path
    if (!path) return
    positions = recordPosition(positions, path, contentEl.scrollTop, contentEl.scrollHeight)
    savePositions(positions)
  }, 400)
}


// ───────────── 块级操作（右键菜单用） ─────────────
// 与 splitBlock/mergeBlock 同一套约定：改 session.blocks、标 structuralDirty、
// 同步 originals、重新 render。写盘仍由 serialize 按块拼装，所以这里不碰原文偏移。

/** 找到块在 session.blocks 里的下标。 */
function blockIndex(id: string): number {
  return session.blocks.findIndex((b) => b.id === id)
}

/** 合成一个空段落块与其后的空白缝。 */
function makeEmptyParagraph(at: number): { para: BlockView; gap: BlockView } {
  const para: BlockView = {
    id: nextId(),
    kind: 'paragraph',
    start: at,
    end: at,
    raw: '',
    mdast: parseOne(''),
    dirty: true,
  }
  const gap: BlockView = {
    id: nextId(),
    kind: 'unknown',
    start: at,
    end: at,
    raw: '\n\n',
    mdast: null,
    dirty: true,
  }
  return { para, gap }
}

/** 在块后插入空段落并聚焦，方便直接开始写。 */
function insertParagraphAfter(id: string): void {
  const i = blockIndex(id)
  if (i < 0) return
  const at = session.blocks[i]!.end
  const { para, gap } = makeEmptyParagraph(at)
  session.blocks.splice(i + 1, 0, para, gap)
  session.originals.set(para.id, para.raw)
  session.originals.set(gap.id, gap.raw)
  blockUndoStack.push(t('menuUndoInsert'), () => {
    const removed = takeBlocks([para.id, gap.id])
    if (removed.length) forgetBlocks(removed)
  })
  session.structuralDirty = true
  markDirty()
  render()
  focusBlock(para.id)
}

/** 在块前插入空段落并聚焦。 */
function insertParagraphBefore(id: string): void {
  const i = blockIndex(id)
  if (i < 0) return
  const at = session.blocks[i]!.start
  const { para, gap } = makeEmptyParagraph(at)
  session.blocks.splice(i, 0, para, gap)
  session.originals.set(para.id, para.raw)
  session.originals.set(gap.id, gap.raw)
  blockUndoStack.push(t('menuUndoInsert'), () => {
    const removed = takeBlocks([para.id, gap.id])
    if (removed.length) forgetBlocks(removed)
  })
  session.structuralDirty = true
  markDirty()
  render()
  focusBlock(para.id)
}

/**
 * 块级撤销栈。
 *
 * 右键菜单能一键删掉整块，而 CodeMirror 的 undo 只管聚焦块内部——
 * 删完就没有后悔药了。对一个「文件是唯一真相」的产品来说这是不能留的风险，
 * 所以删除、插入、勾选都压栈，⌘Z（且不在编辑器里）时撤回。
 *
 * 每项是一个「怎么退回去」的闭包而不是快照：闭包带着操作发生时的位置和对象身份，
 * 退回去时不必猜「当时它是第几块」。
 *
 * 只压结构操作，不压文字编辑（那是 CM 的事）。栈上限 20，够用且不积内存。
 */
const BLOCK_UNDO_MAX = 20
const blockUndoStack = createUndoStack(BLOCK_UNDO_MAX)

/** 把一批块插回原位（撤销删除用）。 */
function restoreBlocks(at: number, blocks: BlockView[]): void {
  const index = Math.max(0, Math.min(at, session.blocks.length))
  session.blocks.splice(index, 0, ...blocks)
  for (const b of blocks) {
    if (!session.originals.has(b.id)) session.originals.set(b.id, b.raw)
  }
  session.structuralDirty = true
}

/** 块离开会话后，DOM、聚焦中的 CM、原文缓存都不能留下孤儿。 */
function forgetBlocks(removed: BlockView[]): void {
  for (const r of removed) {
    session.originals.delete(r.id)
    blocksEl.get(r.id)?.remove()
    blocksEl.delete(r.id)
  }
  if (session.focusedId && removed.some((r) => r.id === session.focusedId)) {
    if (cm) {
      cm.destroy()
      cm = null
    }
    session.focusedId = null
  }
}

/** 按 id 摘块（撤销插入用），其余块保持相对顺序。 */
function takeBlocks(ids: string[]): BlockView[] {
  const wanted = new Set(ids)
  const removed: BlockView[] = []
  session.blocks = session.blocks.filter((b) => {
    if (!wanted.has(b.id)) return true
    removed.push(b)
    return false
  })
  return removed
}

/** 弹一次撤销并重绘；没有可撤的就返回 false，让 ⌘Z 回到正常路径。 */
function undoBlockOp(): boolean {
  const label = blockUndoStack.undo()
  if (label === null) return false
  markDirty()
  render()
  showToast(label)
  return true
}

/**
 * 删除块。
 *
 * 连同其后紧邻的空白缝一起删——只删内容会留下孤立的空行，
 * 用户看到的是「删了但版面又多空了一截」。
 * 首块删掉时把「前置」缝也带走（缝在它前面）。
 */
function deleteBlock(id: string): void {
  const i = blockIndex(id)
  if (i < 0) return
  const block = session.blocks[i]!
  const isGap = (b: BlockView | undefined) => b?.kind === 'unknown' && b.raw.trim() === ''
  let from = i
  let count = 1
  if (isGap(session.blocks[i + 1])) {
    count += 1 // 带走后面的缝
  } else if (isGap(session.blocks[i - 1])) {
    from = i - 1
    count += 1 // 末块：带走前面的缝
  }
  const removed = session.blocks.splice(from, count)
  blockUndoStack.push(t('menuUndoBlock'), () => restoreBlocks(from, removed))
  forgetBlocks(removed)
  session.structuralDirty = true
  markDirty()
  render()
}

/** 把块的原文写回并标脏（用于任务勾选这类「只改一小处」的操作）。 */
function setBlockRaw(block: BlockView, raw: string): void {
  block.raw = raw
  const original = session.originals.get(block.id) ?? ''
  block.dirty = raw !== original
  const roots = parseBlockRoots(raw)
  block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
  block.kind = kindFromMdast(roots[0]) as BlockKind
  markDirty()
}

/**
 * 勾选/取消任务项。
 *
 * 列表整块是一个 block，所以要按「渲染出来的第 n 个任务项」去源码里找第 n 个
 * `- [ ]` 行。用序号对应而不是文本匹配：两条任务文字相同时文本匹配会改错行。
 */
function toggleTaskItem(block: BlockView, itemIndex: number, checked: boolean): void {
  const lines = block.raw.split('\n')
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)/)
    if (!m) continue
    if (seen === itemIndex) {
      const before = block.raw
      lines[i] = `${m[1]}${checked ? 'x' : ' '}${m[3]}${lines[i]!.slice(m[0].length)}`
      setBlockRaw(block, lines.join('\n'))
      // 勾错了要能撤回来。勾选不经过 CM，所以得自己进撤销链。
      blockUndoStack.push(t('menuUndoCheck'), () => setBlockRaw(block, before))
      render()
      return
    }
    seen += 1
  }
}


// ───────────── 表格网格编辑 ─────────────
// 表格是「结构上想网格、存储上要源码」的典型：弹窗管网格，写回走块原文。

/** 网格弹窗的结果写回块原文，并进块级撤销链（表格不经过 CM，得自己进）。 */
function applyTableMarkdown(block: BlockView, md: string): void {
  if (md === block.raw) return
  const before = block.raw
  setBlockRaw(block, md)
  blockUndoStack.push(t('menuUndoTable'), () => setBlockRaw(block, before))
  render()
}

function openTableForBlock(block: BlockView): void {
  openTableEditor({
    source: block.raw,
    onDone: (md) => applyTableMarkdown(block, md),
    onEditSource: (md) => {
      applyTableMarkdown(block, md)
      // 网格不够用时的退路：写回网格结果后切到该块的源码编辑
      focusBlock(block.id)
    },
  })
}

// ───────────── 右键菜单 ─────────────
// 分场景给菜单：读代码的要「复制」，改文档的要「删除/插入」，点了任务的想「勾选」。
// 同一个菜单套所有场景会让每一项都显得可疑。

/** 编辑器（聚焦块）内的菜单：标准编辑动作。 */
function editorMenuItems(): ContextMenuItem[] {
  const run = (cmd: string) => () => {
    try {
      document.execCommand(cmd)
    } catch {
      showToast(t('codeCopyFailed'))
    }
  }
  return [
    { label: t('menuUndo'), hint: mod('Z'), run: () => cm?.view && undo(cm.view) },
    { label: t('menuRedo'), hint: modShift('Z'), run: () => cm?.view && redo(cm.view) },
    { separatorBefore: true, label: t('menuCut'), hint: mod('X'), run: run('cut') },
    { label: t('menuCopy'), hint: mod('C'), run: run('copy') },
    {
      label: t('menuPaste'),
      hint: mod('V'),
      run: () => {
        // 剪贴板读取在部分 webview 里被拒；失败就给明确提示，
        // 不要让用户以为是应用坏了。
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!text || !cm) return
            const view = cm.view
            const sel = view.state.selection.main
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: text },
              selection: { anchor: sel.from + text.length },
              userEvent: 'input',
            })
          })
          .catch(() => showToast(t('menuPasteFailed')))
      },
    },
    { label: t('menuSelectAll'), hint: mod('A'), run: run('selectAll') },
  ]
}

/** 预览块上的菜单：整块的读/改动作。 */
function blockMenuItems(block: BlockView, el: HTMLElement): ContextMenuItem[] {
  const preview = el.querySelector('.preview')
  const raw = block.raw
  const tableItems: ContextMenuItem[] =
    block.kind === 'table' ? [{ label: t('menuEditTable'), run: () => openTableForBlock(block) }] : []
  return [
    ...tableItems,
    {
      separatorBefore: tableItems.length > 0,
      label: t('menuCopyBlock'),
      hint: 'Markdown',
      run: () => void copyText(raw, t('menuCopied')),
    },
    {
      label: t('menuCopyText'),
      // 渲染后的纯文本：粘进聊天窗口时不该带 ** 和 #
      run: () => void copyText(preview?.textContent ?? '', t('menuCopied')),
    },
    {
      label: t('menuCopyHtml'),
      // HTML 片段：粘进邮件/富文本编辑器时保留结构与表格
      run: () => void copyText(preview?.innerHTML ?? '', t('menuCopied')),
    },
    {
      separatorBefore: true,
      label: t('menuCutBlock'),
      run: () => {
        void copyText(raw, t('menuCopied'))
        deleteBlock(block.id)
      },
    },
    {
      label: t('menuDeleteBlock'),
      danger: true,
      run: () => deleteBlock(block.id),
    },
    { separatorBefore: true, label: t('menuInsertBefore'), run: () => insertParagraphBefore(block.id) },
    { label: t('menuInsertAfter'), run: () => insertParagraphAfter(block.id) },
  ]
}

/** 任务项上的菜单。 */
function taskMenuItems(block: BlockView, itemIndex: number, checked: boolean): ContextMenuItem[] {
  return [
    {
      label: checked ? t('menuUncheck') : t('menuCheck'),
      run: () => toggleTaskItem(block, itemIndex, !checked),
    },
    { separatorBefore: true, label: t('menuCopyText'), run: () => void copyText(block.raw, t('menuCopied')) },
  ]
}

/** 链接上的菜单。 */
function linkMenuItems(href: string): ContextMenuItem[] {
  const safe = safeHref(href)
  return [
    {
      label: t('menuOpenLink'),
      disabled: !safe,
      run: () => {
        if (!safe) return
        void openExternal(safe).catch(() => showToast(t('menuOpenLinkFailed')))
      },
    },
    { label: t('menuCopyLink'), run: () => void copyText(href, t('menuCopied')) },
  ]
}

/** 图片上的菜单。 */
function imageMenuItems(img: HTMLImageElement): ContextMenuItem[] {
  return [
    { label: t('menuZoomImage'), run: () => img.click() },
    { label: t('menuCopyImagePath'), run: () => void copyText(img.getAttribute('src') ?? '', t('menuCopied')) },
  ]
}

/** 右键入口：按目标决定给哪套菜单。 */
function onContextMenu(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  if (!target) return

  // 编辑器内
  if (target.closest('.cm-content')) {
    e.preventDefault()
    showContextMenu(editorMenuItems(), e.clientX, e.clientY)
    return
  }

  // 表单输入保留系统菜单：那里需要系统级的粘贴、输入法候选、拼写检查，
  // 这些我们没实现，抢过来只会把功能变少。
  if (target.closest('input, textarea, [contenteditable="true"]')) return

  // 其余位置**一律**拦掉浏览器菜单。
  //
  // 这里是桌面应用：右键一块段间空白弹出「刷新 / 另存为 / 打印 / 检查元素」，
  // 会让人瞬间怀疑自己开错了东西（Tauri 的 WebView 默认就带这套菜单）。
  // 拦掉之后必须给出我们自己的东西，否则「右键没反应」和「弹出网页菜单」
  // 一样糟——所以下面每一个分支都要有出口，最后一个分支兜住「空白处」。
  e.preventDefault()

  // 图片
  if (target.tagName === 'IMG' && target.closest('.reading-prose')) {
    showContextMenu(imageMenuItems(target as HTMLImageElement), e.clientX, e.clientY)
    return
  }

  // 链接
  const link = target.closest('a') as HTMLAnchorElement | null
  if (link && link.closest('.reading-prose')) {
    showContextMenu(linkMenuItems(link.getAttribute('href') ?? ''), e.clientX, e.clientY)
    return
  }

  // 任务项：按渲染顺序定位到源码里第几条任务
  const li = target.closest('li.task') as HTMLLIElement | null
  if (li) {
    const blockEl = li.closest('.block') as HTMLElement | null
    const id = blockEl?.dataset.blockId
    const block = id ? session.blocks.find((b) => b.id === id) : undefined
    if (block && blockEl) {
      const items = Array.from(blockEl.querySelectorAll('li.task'))
      const idx = items.indexOf(li)
      const box = li.querySelector('input[type=checkbox]') as HTMLInputElement | null
      showContextMenu(taskMenuItems(block, idx, !!box?.checked), e.clientX, e.clientY)
      return
    }
  }

  // 预览块
  const blockEl = target.closest('.block') as HTMLElement | null
  const id = blockEl?.dataset.blockId
  const block = id ? session.blocks.find((b) => b.id === id) : undefined
  if (block && blockEl && block.kind !== 'unknown') {
    showContextMenu(blockMenuItems(block, blockEl), e.clientX, e.clientY)
    return
  }

  // 没落在任何块上：段间空白缝（.block.gap 没有 blockId）、正文列的两侧留白、
  // 最后一段之后的那片空。右键这里想做的事，八成还是「在这儿加一段」，
  // 所以贴着最近的内容块给一份短菜单。
  const nearest = nearestBlockBefore(target)
  showContextMenu(blankAreaMenuItems(nearest), e.clientX, e.clientY)
}

/**
 * 在正文里向上找最近的一个内容块。
 *
 * 从「点在哪个块上」出发而不是从坐标算：块的顺序在 DOM 里就是文档顺序，
 * 找上一个兄弟比拿 y 坐标去遍历所有块更省也更稳。
 */
function nearestBlockBefore(target: HTMLElement): BlockView | null {
  const content = target.closest('#content')
  if (!content) return null
  let node: Element | null = target.closest('.block') ?? target
  while (node && node !== content) {
    let prev = node.previousElementSibling
    while (prev) {
      const pid = (prev as HTMLElement).dataset?.blockId
      const b = pid ? session.blocks.find((x) => x.id === pid) : undefined
      if (b && b.kind !== 'unknown') return b
      prev = prev.previousElementSibling
    }
    node = node.parentElement
  }
  return null
}

/** 段间空白 / 正文留白上的菜单：不锚定具体块，只给「继续写」相关的动作。 */
function blankAreaMenuItems(nearest: BlockView | null): ContextMenuItem[] {
  return [
    {
      label: nearest ? t('menuInsertAfter') : t('menuInsertFirst'),
      disabled: !nearest,
      run: () => nearest && insertParagraphAfter(nearest.id),
    },
    { separatorBefore: true, label: t('menuCopyAll'), run: () => void copyText(allRawText(), t('menuCopied')) },
    { label: t('findAria'), hint: mod('F'), run: () => openFind() },
    { label: t('menuSelectAll'), hint: mod('A'), run: () => selectAllText() },
  ]
}

/** 当前会把什么写回磁盘——与状态行的字数取自同一份文本。 */
function allRawText(): string {
  return session.blocks.map((b) => b.raw).join('')
}

/**
 * 全选正文。
 *
 * 不能用 document.execCommand('selectAll')：它选的是整个 document，
 * 会把顶栏与侧栏的文字也圈进去。范围必须钉在 #content 上。
 */
function selectAllText(): void {
  const range = document.createRange()
  range.selectNodeContents(contentEl)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function outlineSignature(): string {
  return session.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => `${b.id}:${headingDepth(b) ?? 1}:${headingText(b.mdast)}`)
    .join('|')
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * 状态行：文档的一行自述。
 *
 * 数字取自「当前会把什么写回磁盘」——脏块用编辑器里的文本、净块用磁盘原文，
 * 所以它和保存后的结果是同一个数，不会出现「状态行说 100 字、保存后变 98」。
 */
function renderStatus() {
  const blocks = session.blocks
  if (blocks.length === 0) {
    statusLeft.replaceChildren()
    statusRight.replaceChildren()
    return
  }
  const text = blocks.map((b) => b.raw).join('')
  const stats = countText(text)
  const sections = blocks.filter((b) => b.kind === 'heading').length
  const minutes = readingMinutes(stats)

  // 项目之间补一个空格字符：视觉间隔由 CSS gap 负责，
  // 但读屏与「选中状态行复制」拿到的是 textContent，不能连成一串。
  const item = (text: string, strong = false) => {
    const el = document.createElement('span')
    el.className = 'status-item'
    if (strong) el.dataset.strong = 'true'
    el.textContent = text
    el.append(' ')
    return el
  }

  statusLeft.replaceChildren()
  if (stats.words === 0) {
    statusLeft.append(item(t('statEmpty')))
  } else {
    statusLeft.append(item(t('statWords', { n: formatCount(stats.words) })))
    if (sections > 0) statusLeft.append(item(t('statSections', { n: sections })))
    if (minutes > 0) statusLeft.append(item(t('statReading', { n: minutes })))
  }

  statusRight.replaceChildren()
  // 状态行右侧：当前档 + 保存状态 + 文件名。
  // 当前档这里只写「编辑 / 源码」，阅读档不写——阅读是默认态，
  // 给默认态也挂一个标签，等于在每篇文档右下角常驻一个「你在阅读」的噪音。
  if (viewMode !== 'read') statusRight.append(item(viewLabel(viewMode), true))
  statusRight.append(item(session.dirty ? t('statUnsaved') : t('statSavedAt'), session.dirty))
  // 保存状态与文件名在同一行：这是「这份文件现在是什么状态」的完整答案
  statusRight.append(item(fileNameEl.textContent ?? ''))
}

function markDirty() {
  // 编辑可能增删标题、改级别或改文字（分裂/合并会换 id），
  // 大纲不重建就会指着一批不存在的块——表现为高亮消失、点击无反应。
  const sig = outlineSignature()
  if (sig !== lastOutlineSignature) {
    lastOutlineSignature = sig
    if (sidebar.isOpen()) renderOutline()
  }
  session.dirty = sessionIsDirty(session.blocks, session.structuralDirty)
  // 显隐交给样式（html.dirty .dirty-dot），这里只翻一个类，避免两处真相
  document.documentElement.classList.toggle('dirty', session.dirty)
  // 保存按钮跟着脏状态亮/灭（见 refreshSaveButton）
  refreshSaveButton()
  renderStatus()
}

/** 聚焦段末回车 → 分裂成两段（前段 + 空段）。返回 true 表示已处理。 */
function splitBlock(block: BlockView, view: EditorView): boolean {
  const doc = view.state.doc.toString()
  const pos = view.state.selection.main.head
  if (block.kind !== 'paragraph' && block.kind !== 'heading') return false
  if (pos !== doc.length) return false // 只在块末分裂，规避光标映射复杂度
  const i = session.blocks.findIndex((b) => b.id === block.id)
  if (i < 0) return false
  // 其后应是空白缝（段落间必有）
  const gap = session.blocks[i + 1]
  if (!gap || gap.kind !== 'unknown' || gap.raw.trim() !== '') return false
  const gapRaw = gap.raw || '\n\n'
  const emptyPara: BlockView = {
    id: nextId(),
    kind: 'paragraph',
    start: gap.start,
    end: gap.start,
    raw: '',
    mdast: parseOne(''),
    dirty: true,
  }
  const extraGap: BlockView = {
    id: nextId(),
    kind: 'unknown',
    start: gap.start,
    end: gap.start,
    raw: gapRaw,
    mdast: null,
    dirty: true,
  }
  session.blocks.splice(i + 2, 0, emptyPara, extraGap)
  session.originals.set(emptyPara.id, emptyPara.raw)
  session.originals.set(extraGap.id, extraGap.raw)
  session.structuralDirty = true
  session.focusedId = emptyPara.id
  if (cm) {
    cm.destroy()
    cm = null
  }
  markDirty()
  render()
  return true
}

/** 空段块首 Backspace → 删除该空段并上移，与上一内容块合并。 */
function mergeBlock(block: BlockView, view: EditorView): boolean {
  const doc = view.state.doc.toString()
  if (doc.trim() !== '') return false
  if (view.state.selection.main.head !== 0) return false
  const i = session.blocks.findIndex((b) => b.id === block.id)
  if (i < 0) return false
  // 删除该空段与其前的空白缝
  const remove: number[] = []
  let prevContent: BlockView | null = null
  for (let k = i - 1; k >= 0; k--) {
    const b = session.blocks[k]!
    if (b.kind === 'unknown') {
      remove.push(k)
    } else {
      prevContent = b
      break
    }
  }
  remove.push(i)
  for (const k of remove.sort((a, b) => b - a)) {
    session.blocks.splice(k, 1)
  }
  session.structuralDirty = true
  if (prevContent) {
    caretIntent = { mode: 'end' }
    session.focusedId = prevContent.id
  } else {
    session.focusedId = null
  }
  if (cm) {
    cm.destroy()
    cm = null
  }
  markDirty()
  render()
  caretIntent = null
  return true
}

function showToast(msg: string) {
  let toast = document.getElementById('lector-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'lector-toast'
    toast.className = 'lector-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.classList.add('show')
  window.setTimeout(() => toast?.classList.remove('show'), 2400)
}

function loadSession(path: string, raw: string, mtimeMs = Date.now()) {
  if (cm) {
    cm.destroy()
    cm = null
  }
  blocksEl.clear()
  liveText.clear()
  session.source = createSourceDocument(path, raw, mtimeMs)
  setCurrentMdPath(session.source.path)
  session.blocks = parseBlocks(session.source.text)
  session.originals = new Map(session.blocks.map((b) => [b.id, b.raw] as const))
  session.focusedId = null
  session.dirty = false
  session.structuralDirty = false
  fileNameEl.textContent = baseName(path)
  fileNameEl.dataset.untitled = 'false'
  document.title = `${baseName(path)} — Lector`
  contentEl.innerHTML = ''
  contentEl.scrollTop = 0
  render()
  markDirty()
  // 恢复上次的阅读位置。放在 render 之后：需要块已经进 DOM 才能滚到位。
  // 用 rAF 等一帧，避免和 render 的布局在同一帧里打架。
  restoreReadingPosition()
  // 换文档后大纲要重建：标题变了（在 render() 之后，此时 blocksEl 才填好）
  if (sidebar.isOpen()) renderOutline()
  setDocPresent(true)
  // 通知外框复位（顶栏的滚动分隔影）
  window.dispatchEvent(new Event('lector:doc-changed'))
  if (detectEnv() === 'shell') {
    void bindDocument(path)
    void watch(path)
  }
}

async function render() {
  // 预渲染 KaTeX：走一次 katex 库加载 + 所有 math 节点并行渲染,之后 renderBlockHtml 同步读 cache。
  // 文档无 math 节点时,这步 0 开销。
  await preRenderMath(session.blocks)
  const desired: HTMLElement[] = []
  const seen = new Set<string>()
  for (const block of session.blocks) {
    seen.add(block.id)
    let el = blocksEl.get(block.id)
    if (!el) {
      el = createBlockEl(block)
      blocksEl.set(block.id, el)
    }
    desired.push(el)
  }
  for (const [id, el] of blocksEl) {
    if (!seen.has(id)) {
      el.remove()
      blocksEl.delete(id)
    }
  }
  applyKeyedChildren(contentEl, desired)
  for (const block of session.blocks) {
    const el = blocksEl.get(block.id)
    if (el) renderBlockContent(el, block)
  }
}

function headingDepth(block: BlockView): number | null {
  if (block.kind !== 'heading') return null
  const node = Array.isArray(block.mdast) ? block.mdast[0] : block.mdast
  const d = (node as { depth?: number } | null)?.depth
  return d == null ? 1 : d
}

function applyBlockMeta(el: HTMLElement, block: BlockView) {
  el.dataset.kind = block.kind
  // 把块 id 写进 DOM：大纲行、测试、排障都要能自证「这一行指的是哪个块」。
  // 曾经出现过大纲行指着已被替换的旧 id 的情况（表现为高亮消失、点击无反应），
  // 没有这个属性就只能靠猜。
  el.dataset.blockId = block.id
  const depth = headingDepth(block)
  if (depth != null) el.dataset.depth = String(depth)
  else delete el.dataset.depth
}

function createBlockEl(block: BlockView): HTMLElement {
  const el = document.createElement('div')
  el.className = 'block'
  el.dataset.blockId = block.id
  applyBlockMeta(el, block)
  if (isWhitespaceGap(block)) el.classList.add('gap')
  return el
}

/** 点击或方向键跨块后，光标要落到哪里。 */
type CaretIntent =
  | { mode: 'coords'; x: number; y: number }
  | { mode: 'start'; x?: number }
  | { mode: 'end'; x?: number }

let caretIntent: CaretIntent | null = null

function placeCaret(view: EditorView, intent: CaretIntent) {
  const doc = view.state.doc
  let pos: number | null = null
  if (intent.mode === 'coords') {
    pos = view.posAtCoords({ x: intent.x, y: intent.y })
  } else if (intent.mode === 'start') {
    if (intent.x == null) pos = 0
    else {
      const line = doc.line(1)
      const c = view.coordsAtPos(line.from)
      pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : 0
    }
  } else if (intent.x == null) {
    pos = doc.length
  } else {
    const line = doc.line(doc.lines)
    const c = view.coordsAtPos(line.to)
    pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : doc.length
  }
  if (pos == null) pos = intent.mode === 'end' ? doc.length : 0
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
}

function caretX(view: EditorView): number | undefined {
  return view.coordsAtPos(view.state.selection.main.head)?.left
}

function atVisualVerticalEdge(view: EditorView, down: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const moved = view.moveVertically(sel, down)
  if (moved.head === sel.head) return true
  // 单行块上 moveVertically 常把光标挪到行尾，head 变了但还在同一视觉行
  const a = view.coordsAtPos(sel.head)
  const b = view.coordsAtPos(moved.head)
  if (!a || !b) return true
  return a.top < b.bottom && b.top < a.bottom
}

function atHorizontalEdge(view: EditorView, right: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  return right ? sel.head === view.state.doc.length : sel.head === 0
}

/** 方向键顶到块边界 → 跳到相邻可聚焦块，并接上光标列。 */
function moveAcrossBlocks(
  block: BlockView,
  view: EditorView,
  dir: 'up' | 'down' | 'left' | 'right',
): boolean {
  const vertical = dir === 'up' || dir === 'down'
  const forward = dir === 'down' || dir === 'right'
  if (vertical ? !atVisualVerticalEdge(view, forward) : !atHorizontalEdge(view, forward)) {
    return false
  }
  const nextId = adjacentFocusableId(session.blocks, block.id, forward ? 1 : -1)
  if (!nextId) return false
  const x = vertical ? caretX(view) : undefined
  const intent: CaretIntent = forward
    ? x == null ? { mode: 'start' } : { mode: 'start', x }
    : x == null ? { mode: 'end' } : { mode: 'end', x }
  // 必须等当前 keydown 结束再切块，否则新 CM 会吃到同一记方向键，单行块会被连跳两次。
  window.setTimeout(() => {
    focusBlock(nextId, intent)
    blocksEl.get(nextId)?.scrollIntoView({ block: 'nearest' })
  }, 0)
  return true
}

function renderBlockContent(el: HTMLElement, block: BlockView) {
  if (isWhitespaceGap(block)) {
    el.className = 'block gap'
    el.replaceChildren()
    return
  }
  applyBlockMeta(el, block)
  el.classList.remove('gap')
  el.classList.toggle('focused', block.id === session.focusedId)
  const focus = block.id === session.focusedId
  el.replaceChildren()
  if (focus) {
    const host = document.createElement('div')
    host.className = 'cm-host'
    applyBlockMeta(host, block)
    el.appendChild(host)
    const config = {
      autoCharacterPairs: getSettings().autoCharacterPairs,
      showWhitespace: getSettings().showWhitespace,
      // 块内历史见底后，⌘Z 接着撤块级操作（见 cm.ts 的 Mod-z）
      onUndoFallback: () => undoBlockOp(),
      // 代码块里不做 HTML→Markdown：那里要的是代码原文
      pasteHtmlAsMarkdown: block.kind !== 'code',
      structuralKeymap: {
        Enter: (view: EditorView) => splitBlock(block, view),
        Backspace: (view: EditorView) => mergeBlock(block, view),
        ArrowUp: (view: EditorView) => moveAcrossBlocks(block, view, 'up'),
        ArrowDown: (view: EditorView) => moveAcrossBlocks(block, view, 'down'),
        ArrowLeft: (view: EditorView) => moveAcrossBlocks(block, view, 'left'),
        ArrowRight: (view: EditorView) => moveAcrossBlocks(block, view, 'right'),
      },
    }
    cm = mountEditor(
      host,
      block.raw,
      (text) => {
        liveText.set(block.id, text)
        syncBlockText(block, text)
      },
      config,
    )
    const intent = caretIntent
    requestAnimationFrame(() => {
      if (!cm) return
      cm.view.focus()
      if (intent) placeCaret(cm.view, intent)
    })
  } else if (viewMode === 'source') {
    // 源码模式：每块以等宽源码呈现，不走 mdast HTML。
    // mermaid / 图片的渲染属于预览路径，源码模式不解释。
    const src = document.createElement('pre')
    src.className = 'source-view'
    const code = document.createElement('code')
    code.textContent = block.raw
    src.appendChild(code)
    el.appendChild(src)
  } else {
    const preview = document.createElement('div')
    preview.className = 'preview reading-prose'
    preview.innerHTML = renderBlockHtml(block.mdast, block.raw)
    el.appendChild(preview)
    if (block.kind === 'code') decorateCodeBlock(el, preview)
  }
}

/**
 * 代码块加「语言标签 + 复制」。
 *
 * 读代码时的实际需求：想知道这是什么语言、想把这段拿走。
 * 复制走 DOM 的文本而不是 block.raw——raw 含围栏与缩进，复制出来是源码片段而不是代码。
 */
function decorateCodeBlock(el: HTMLElement, preview: HTMLElement): void {
  const code = preview.querySelector('pre code')
  if (!code) return
  const lang = (code.className.match(/language-([\w+#-]+)/)?.[1] ?? '').toLowerCase()

  // mermaid 走另一条路径：拆 <pre><code>，改挂 mermaid-diagram 容器；
  // 拷贝按钮复用，复制的是源码。
  if (lang === 'mermaid') {
    const source = code.textContent ?? ''
    const pre = code.parentElement
    const host = pre?.parentElement
    if (!host) return

    const bar = document.createElement('div')
    bar.className = 'code-bar'
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = 'mermaid'
    bar.appendChild(label)
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'code-copy'
    copy.textContent = t('codeCopy')
    copy.addEventListener('click', (e) => {
      e.stopPropagation()
      void copyText(source, t('codeCopied'))
    })
    bar.appendChild(copy)

    const diagram = document.createElement('div')
    diagram.className = 'mermaid-diagram'
    const status = document.createElement('div')
    status.className = 'mermaid-status'
    status.textContent = t('mermaidLoading')
    diagram.appendChild(status)

    if (pre) pre.remove()
    host.appendChild(bar)
    host.appendChild(diagram)

    // 点击放大：与 notefast 一致，把**内联的 SVG 标记**交给灯箱（不转 data URL）。
    // 停上后由 outer-content click 统一处理返回。
    diagram.addEventListener('click', (e) => {
      e.stopPropagation()
      const svgEl = diagram.querySelector('svg')
      if (!svgEl) return
      showSvgInLightbox(new XMLSerializer().serializeToString(svgEl), 'mermaid')
    })

    const theme: 'light' | 'dark' =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    let cancelled = false
    renderMermaidSvg(source, theme)
      .then((svg) => {
        if (cancelled) return
        diagram.replaceChildren()
        const inner = document.createElement('div')
        inner.className = 'mermaid-svg'
        inner.innerHTML = svg
        diagram.appendChild(inner)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        diagram.replaceChildren()
        const errBox = document.createElement('div')
        errBox.className = 'mermaid-error'
        errBox.textContent = t('mermaidFailedWith', { error: msg })
        const fallback = document.createElement('pre')
        fallback.className = 'mermaid-source'
        const fallbackCode = document.createElement('code')
        fallbackCode.textContent = source
        fallback.appendChild(fallbackCode)
        diagram.appendChild(errBox)
        diagram.appendChild(fallback)
      })

    return
  }

  const bar = document.createElement('div')
  bar.className = 'code-bar'
  if (lang) {
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = lang
    bar.appendChild(label)
  }
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'code-copy'
  copy.textContent = t('codeCopy')
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    void copyText(code.textContent ?? '')
  })
  bar.appendChild(copy)
  // 挂在块的预览容器上（不是 pre 里面）：pre 的内容是代码，塞按钮会污染复制结果
  const pre = code.parentElement
  pre?.parentElement?.insertBefore(bar, pre)
}

/** 复制文本：优先 Clipboard API，失败退回 execCommand（壳里的老 WebView 可能不支持前者）。 */
async function copyText(text: string, okMessage?: string): Promise<void> {
  const done = okMessage ?? t('codeCopied')
  try {
    await navigator.clipboard.writeText(text)
    showToast(done)
    return
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    showToast(ok ? done : t('codeCopyFailed'))
  } catch {
    showToast(t('codeCopyFailed'))
  }
}

/**
 * 把编辑器里的文本同步回块，并立刻重算脏状态。
 *
 * 打字时就调用，而不是等失焦：
 *   - 状态行的字数/小节数读的是块文本，失焦才同步等于「打字时数字不动」；
 *   - 「保存」按钮的可用性也读脏状态——打了半屏字按钮还是灰的，会被读成没响应。
 * 解析（mdast / kind）仍然留给失焦：那一步贵，且打字过程中没人需要新的大纲。
 */
function syncBlockText(block: BlockView, text: string): void {
  const original = session.originals.get(block.id) ?? block.raw
  block.raw = text
  block.dirty = text !== original
  markDirty()
}

function finalizeFocused() {
  if (session.focusedId === null || !cm) return
  const block = session.blocks.find((b) => b.id === session.focusedId)
  if (!block) return
  const text = cm.view.state.doc.toString()
  const original = session.originals.get(block.id) ?? block.raw
  block.raw = text
  block.dirty = text !== original
  if (block.dirty) {
    const roots = parseBlockRoots(text)
    block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
    block.kind = kindFromMdast(roots[0]) as BlockKind
  }
  markDirty()
}

function focusBlock(id: string, intent?: CaretIntent) {
  if (session.focusedId === id) {
    if (intent && cm) {
      placeCaret(cm.view, intent)
      cm.view.focus()
    }
    return
  }
  const next = session.blocks.find((b) => b.id === id)
  if (!next || !isFocusableBlock(next)) return
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = id
  caretIntent = intent ?? null
  render()
  caretIntent = null
}

function defocus() {
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = null
  render()
}

async function confirmOpenIfDirty(): Promise<boolean> {
  if (!session.dirty) return true
  return confirmDiscard()
}

/**
 * 「打开文件」：**先选文件，再动当前文档**。
 *
 * 旧顺序是「先清屏 → 选文件」：点开对话框的瞬间当前文档就没了（标题变回 Lector、
 * 正文清空、侧栏下线），取消选择也回不来——脏文档还在这之前被确认丢弃过，
 * 于是用户看到的是「我什么都没选，文章没了」。这是数据丢失级的顺序错误，不是观感问题。
 *
 * 对话框本身是模态的，它就是「正在打开」的反馈，不需要先把屏幕擦干净来示意。
 * 选到文件之后才问「要不要丢弃未保存的修改」，被拒绝就原样留在原文档上。
 */
let openInFlight = false
async function openFromShellOrDialog() {
  // 双击/连点不该弹出两个对话框
  if (openInFlight) return
  openInFlight = true
  try {
    let picked: Awaited<ReturnType<typeof pickAndRead>> = null
    try {
      picked = await pickAndRead()
    } catch (err) {
      // 读失败：当前文档一个字都不动，只报一次
      console.error('[lector] open failed', err)
      showToast(`${t('openFailed')}：${String(err)}`)
      return
    }
    // 取消选择：原样退出。不换标题、不清正文、不出空态
    if (!picked) return
    // 这时才轮到「未保存的修改」——新文件已经拿在手里，用户知道自己要换掉什么
    if (!(await confirmOpenIfDirty())) return
    loadSession(picked.path, picked.content, picked.mtime_ms)
  } finally {
    openInFlight = false
  }
}

contentEl.addEventListener('click', (e) => {
  // 拖选之后松开鼠标：click 事件仍会触发，handler 会跑去 focusBlock()，
  // 而 focusBlock 会 render()，把选中的节点清掉——视觉上就是「选中瞬间消失」。
  // mouseup 不会清选区；到 click 触发时 sel 仍是非折叠的，拦下即可。
  // 真点击（点空白、点链接、点进块）sel 是折叠的，行为不变。
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().length > 0) {
    return
  }
  const link = (e.target as HTMLElement).closest('a')
  if (link && !link.closest('.cm-host')) {
    e.preventDefault()
    const href = link.getAttribute('href')
    if (href && /^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
    return
  }
  // 只读模式：块点击不抢 focus，只在末车是「点上」时（mermaid 容器、表格预览）交给各自处理。
  // 表格预览在只读下不打开（想改就进编辑模式），别在读路径上引另一个跳转。
  if (viewMode === 'read') {
    return
  }
  const target = (e.target as HTMLElement).closest<HTMLElement>('.block:not(.gap)')
  if (!target) {
    if (session.focusedId !== null) defocus()
    return
  }
  const id = target.dataset.blockId
  if (!id) return
  // 表格块点预览 = 打开网格编辑弹窗（改表格在纯文本里太痛苦；
  // 想直接改源码，弹窗里有「编辑源码」退路）。
  // **只在「编辑」档**：源码档的承诺是「每个块都以源码呈现，点它改它的源码」，
  // 在那一档弹出网格面板会打断这个承诺——用户点表格想看源码，却拿到一个面板。
  const block = session.blocks.find((b) => b.id === id)
  if (block?.kind === 'table' && viewMode === 'edit') {
    openTableForBlock(block)
    return
  }
  focusBlock(id, { mode: 'coords', x: e.clientX, y: e.clientY })
})

const MAX_IMAGE_BYTES = 15 * 1024 * 1024

function appendImageParagraph(md: string) {
  const onlyEmpty =
    session.blocks.length === 1 &&
    session.blocks[0] &&
    isFocusableBlock(session.blocks[0]) &&
    session.blocks[0].raw === ''
  if (onlyEmpty) {
    const b = session.blocks[0]!
    b.raw = md
    b.dirty = true
    b.mdast = parseOne(md)
    b.kind = kindFromMdast(b.mdast)
    markDirty()
    render()
    return
  }
  const last = session.blocks[session.blocks.length - 1]
  if (last && !isWhitespaceGap(last)) {
    const gapId = nextId()
    session.blocks.push({
      id: gapId,
      kind: 'unknown',
      start: 0,
      end: 0,
      raw: '\n\n',
      mdast: null,
      dirty: true,
    })
    session.originals.set(gapId, '')
  }
  const para: BlockView = {
    id: nextId(),
    kind: 'paragraph',
    start: 0,
    end: 0,
    raw: md,
    mdast: parseOne(md),
    dirty: true,
  }
  session.blocks.push(para)
  session.originals.set(para.id, '')
  session.structuralDirty = true
  markDirty()
  render()
}

function insertImageMarkdownAtCaret(md: string) {
  if (cm && session.focusedId) {
    const pos = cm.view.state.selection.main.head
    cm.view.dispatch({
      changes: { from: pos, insert: md },
      selection: { anchor: pos + md.length },
    })
    return
  }
  appendImageParagraph(md)
}

async function ingestImageFile(file: File, name: string | null) {
  if (!name) return
  if (file.size > MAX_IMAGE_BYTES) {
    showToast(t('imageTooLarge'))
    return
  }
  if (detectEnv() !== 'shell' || !session.source) {
    showToast(t('imageNeedFile'))
    return
  }
  try {
    const bytes = await file.arrayBuffer()
    // 同一张图在本会话内粘 N 次只占一份磁盘：按内容 hash 复用上次返回的路径。
    // 跨会话的 map 会重置——按 hash 查 image-assets 目录里是下个迭代的事。
    const hash = await imageContentHash(bytes)
    const existing = findDedupImage(hash)
    if (existing) {
      insertImageMarkdownAtCaret(imageMarkdown(existing))
      return
    }
    const bytes_base64 = fileToBase64(bytes)
    const { relative_path } = await saveImage(session.source.path, name, bytes_base64)
    rememberImage(hash, relative_path)
    insertImageMarkdownAtCaret(imageMarkdown(relative_path))
  } catch (err) {
    showToast(`${t('imageFailed')}：${String(err)}`)
  }
}

function imageFilesFromList(list: FileList | DataTransferItemList | undefined | null): File[] {
  if (!list) return []
  const out: File[] = []
  for (const item of list) {
    if (item instanceof File) {
      if (isImageMime(item.type) || safeDropName(item.name)) out.push(item)
      continue
    }
    if (item.kind === 'file' && isImageMime(item.type)) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

window.addEventListener(
  'paste',
  (e) => {
    const files = imageFilesFromList(e.clipboardData?.items)
    if (files.length === 0) return
    e.preventDefault()
    void (async () => {
      for (const f of files) {
        await ingestImageFile(f, pastedFileName(new Date(), f.type) ?? safeDropName(f.name))
      }
    })()
  },
  true,
)

window.addEventListener('dragover', (e) => {
  if (imageFilesFromList(e.dataTransfer?.files).length > 0 || e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
  }
})

window.addEventListener('drop', (e) => {
  const files = imageFilesFromList(e.dataTransfer?.files)
  if (files.length === 0) return
  e.preventDefault()
  void (async () => {
    for (const f of files) {
      await ingestImageFile(f, safeDropName(f.name) ?? pastedFileName(new Date(), f.type))
    }
  })()
})

// 块级撤销：只有没聚焦编辑器时才接管 ⌘Z（编辑器里那是 CM 的文字撤销）
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return
  if (e.key.toLowerCase() !== 'z') return
  if (session.focusedId !== null || cm) return
  if (undoBlockOp()) {
    e.preventDefault()
    e.stopPropagation()
  }
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session.focusedId !== null) {
    e.preventDefault()
    defocus()
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveAsFlow()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    // 直接走存盘，不通过按钮的 click：
    // 按钮在「没有未保存改动」时是禁用的，而禁用的按钮 click() 不会触发任何东西——
    // 快捷键因此会被自己的禁用态吃掉。存盘是文档级动作，不该受控件状态影响。
    void persistToDisk()
  }
})

// Windows / Linux 上不设原生菜单（避免初始化闪现）：原菜单里这些快捷键
// 由 Web 层接管。macOS 上同名的菜单项仍有这些快捷键，双重注册不冲突——
// 菜单项是系统级的，这里是 web 级的，各管各的。
//
// 第一行的 defaultPrevented 守卫是 Windows 上必须有的：聚焦块里的裸 CM
// 会接管自己认识的那些键并 preventDefault（Ctrl+E 行内代码、Ctrl+B 粗体…），
// 而本监听挂在 window 的冒泡阶段——不守卫的话，Windows 用户按 Ctrl+E 会
// **同时**给选中文字加行内代码并把视图切到源码档。CM 不负责 stopPropagation，
// 这层守卫是我们自己的责任。
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  // ⌘O 打开
  if (!e.shiftKey && e.key === 'o') {
    e.preventDefault()
    openBtn.click()
    return
  }
  // ⌘R 从磁盘重载
  if (!e.shiftKey && e.key === 'r') {
    e.preventDefault()
    void reloadFromDisk()
    return
  }
  // ⌘⇧O 大纲
  if (e.shiftKey && e.key.toLowerCase() === 'o') {
    e.preventDefault()
    outlineBtn.click()
    return
  }
  // ⌘, 设置
  if (!e.shiftKey && e.key === ',') {
    e.preventDefault()
    settingsBtn.click()
    return
  }
  // ⌘0 恢复默认字号（⌘0 在部分键盘上与 ⌘) 同位）
  if (!e.shiftKey && (e.key === '0' || e.key === ')')) {
    e.preventDefault()
    resetFontSize()
    return
  }
  // ⌘= / ⌘+ 放大，⌘- 缩小。⌘= 是主键（不用 Shift 也能按到）
  if (!e.shiftKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    stepFontSize(1)
    return
  }
  if (!e.shiftKey && e.key === '-') {
    e.preventDefault()
    stepFontSize(-1)
    return
  }
})

openBtn.addEventListener('click', () => void openFromShellOrDialog())

// 「外观」= 明暗 + 阅读主题。不是一个「切换深浅色」按钮：
// 那个按钮把两件事（白天/晚上、读起来像什么）压成了一个开关。
appearanceBtn.addEventListener('click', () => openAppearancePop(appearanceBtn))
// 再点一次收起（浮层自己处理 toggle），Esc / 点外面也收
settingsBtn.addEventListener('click', () => openSettingsModal())
outlineBtn.addEventListener('click', () => toggleOutline())

function openFind() {
  if (document.querySelector('.find-bar')) {
    document.querySelector<HTMLInputElement>('.find-input')?.focus()
    return
  }
  findBar({
    getBlocks: () => session.blocks,
    replaceInBlock: (id, from, to) => {
      const b = session.blocks.find((x) => x.id === id)
      if (!b) return
      const re = new RegExp(escapeRegExp(from), 'gi')
      b.raw = b.raw.replace(re, () => to)
      b.dirty = true
      const roots = parseBlockRoots(b.raw)
      b.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
      b.kind = kindFromMdast(roots[0]) as BlockKind
      markDirty()
      if (session.focusedId === id && cm) {
        cm.destroy()
        cm = null
      }
      render()
    },
    scrollTo: (id) => blocksEl.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  })
}

findBtn.addEventListener('click', () => openFind())
window.addEventListener('keydown', (e) => {
  // 同上：块内编辑器已接管的键不再走全局（见上面那段注释）
  if (e.defaultPrevented) return
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    openFind()
  }
  // ⌘E 循环 read → edit → source → read
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'e') {
    e.preventDefault()
    toggleMode()
    return
  }
  // ⌘1/2/3 直选档位——循环要按很多次才能到位，直选不用
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
    e.preventDefault()
    setViewMode(VIEW_MODES[Number(e.key) - 1]!)
    return
  }
})

async function persistToDisk(force = false): Promise<boolean> {
  if (!session.source) return false
  finalizeFocused()
  const normalized = serialize(session.blocks)
  const finalText = applyEncoding(session.source, normalized)
  let res: SaveResult
  try {
    res = await save(session.source.path, finalText, session.source.mtimeMs, force)
  } catch (err) {
    // 壳「权限拒绝 / 磁盘满 / 文件被占用」等错误不包不能废——
    // 错误字符串原样透传过来（shell-web ADR-1 语义：reject 原样抛），会进 toString。
    // 这里只在原来吞掉 void() 路径上加一层人看的提示。
    console.error('[lector] save failed', err)
    showToast(`${t('saveFailed')}：${String(err)}`)
    return false
  }
  if (res.conflict) {
    const choice = await chooseConflict()
    if (choice === 'reload') {
      await reloadFromDisk()
      return false
    }
    if (choice === 'overwrite') return persistToDisk(true)
    return false
  }
  if (!res.ok) {
    showToast(t('saveFailed'))
    return false
  }
  session.blocks.forEach((b) => {
    session.originals.set(b.id, b.raw)
    b.dirty = false
  })
  session.structuralDirty = false
  if (typeof res.current_mtime_ms === 'number') {
    session.source.mtimeMs = res.current_mtime_ms
  }
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = null
  markDirty()
  render()
  showToast(t('saved'))
  return true
}

saveBtn.addEventListener('click', () => void persistToDisk())

/** 另存为：选新路径 → 强制写（系统对话框已确认覆盖）→ 会话切到新文件。 */
async function saveAsFlow() {
  if (!session.source) return
  if (detectEnv() !== 'shell') {
    await persistToDisk()
    return
  }
  finalizeFocused()
  const normalized = serialize(session.blocks)
  const finalText = applyEncoding(session.source, normalized)
  const defaultName = baseName(session.source.path) || 'untitled.md'
  let target: string | null = null
  try {
    target = await pickSavePath(defaultName)
  } catch (err) {
    console.error('[lector] save-as dialog', err)
    return
  }
  if (!target) return
  try {
    const res = await save(target, finalText, 0, true)
    if (!res.ok) {
      showToast(t('saveFailed'))
      return
    }
    loadSession(target, finalText, res.current_mtime_ms ?? Date.now())
    showToast(t('saved'))
  } catch (err) {
    console.error('[lector] save-as failed', err)
    showToast(`${t('saveFailed')}：${String(err)}`)
  }
}

async function reloadFromDisk() {
  if (!session.source) return
  try {
    const res = await read(session.source.path)
    loadSession(res.path, res.content, res.mtime_ms)
  } catch {
    showToast(t('reloadFailed'))
  }
}

function bindShellEvents() {
  if (detectEnv() !== 'shell') return
  // 壳把最终路径交给 web（双击 / 单实例转发）
  void onOpen(async (e) => {
    // 与「打开文件」同一条顺序：先把新文件读进来，再问要不要丢弃当前文档。
    // 反过来（先确认、后读取）在读取失败时会让用户白丢一次修改决定。
    let res: Awaited<ReturnType<typeof read>>
    try {
      res = await read(e.path)
    } catch {
      showToast(t('readFailed'))
      return
    }
    if (!(await confirmOpenIfDirty())) return
    loadSession(res.path, res.content, res.mtime_ms)
  })
  // 外部变更（watch 回调）
  void onFileChanged(async (e) => {
    if (session.source && e.path === session.source.path && !session.dirty) {
      await reloadFromDisk()
    } else if (session.source && e.path === session.source.path && session.dirty) {
      showToast(t('diskChanged'))
    }
  })
  // 原生菜单
  void onMenu((action) => {
    switch (action) {
      case 'open':
        void openFromShellOrDialog()
        break
      case 'save':
        saveBtn.click()
        break
      case 'save-as':
        void saveAsFlow()
        break
      case 'find':
        openFind()
        break
      case 'theme':
        // 菜单里的「外观」与顶栏 Aa 按钮是同一个浮层（原生菜单也走同一条路）
        openAppearancePop(appearanceBtn)
        break
      case 'outline':
        toggleOutline()
        break
      case 'reload':
        void reloadFromDisk()
        break
      case 'settings':
        openSettingsModal()
        break
      case 'zoom-in':
        stepFontSize(1)
        break
      case 'zoom-out':
        stepFontSize(-1)
        break
      case 'zoom-reset':
        resetFontSize()
        break
    }
  })
}

// 初始化：壳环境注入资源解析器 + 绑定事件
if (detectEnv() === 'shell') {
  setAssetResolver(shellAssetResolver)
}
bindShellEvents()

// 关闭脏文档前的浏览器级守卫（原生窗口关闭确认属壳侧后续项）
window.addEventListener('beforeunload', (e) => {
  if (getSettings().closeAlwaysConfirmsChanges && session.dirty && session.source) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// 加载 / 空态已抽到 loadState.ts。这里提供 main.ts 的 facade,把所有
// 用到的依赖(全局引用 + 打开回调)一次性注入,避免 loadState 知道 main.ts 的
// 内部状态,反过来也避免主流程再散落两份 empty/loading 模板。
const loadStateDeps = {
  contentEl,
  fileNameEl,
  blocksEl,
  onOpen: () => openFromShellOrDialog(),
}
function renderEmptyState(): void {
  session.blocks = []
  setDocPresent(false)
  renderEmptyStateView(loadStateDeps)
}
function renderLoadingState(): void {
  session.blocks = []
  setDocPresent(false)
  renderLoadingStateView(loadStateDeps)
}

/**
 * 「现在有没有文档」——没有文档时侧栏整块下线。
 *
 * 初版在空态里仍留着 288px 的侧栏轨道，于是首屏左边是一条空白栏 +
 * 一条竖线，读起来像「这里本该有内容，加载失败了」。首屏是最贵的一屏，
 * 该只有一件事：打开一个文件。
 *
 * 用类而不是直接改 sidebar 的状态：用户的开合偏好要留着——
 * 打开文件后侧栏该按他上次的选择回来，而不是被空态改写成「关」。
 */
function setDocPresent(present: boolean): void {
  document.documentElement.classList.toggle('no-doc', !present)
}

// 预览用的媒体样例：图片放大与代码块复制都要能在这里验
const mediaSample = `# 媒体预览

下面这张图点击应当放大查看（Esc / 点背景 / 点右上角关闭）：

![示例图片](./images/sample.png)

## 代码块

代码块右上角悬停出现语言标签与复制按钮：

\`\`\`ts
export function countText(text: string): DocStats {
  const cjk = (text.match(CJK) ?? []).length
  return { words: cjk + latinWords(text), chars: text.length, lines: 1 }
}
\`\`\`

普通段落用于对比高度。
`

// 预览用的 frontmatter 样例：属性卡 + 标签列表两种形状都要能看到
const frontmatterSample = `---
title: 开源文档工具最佳选择
author: Beta
date: 2026-09-12
tags:
  - markdown
  - 阅读器
  - 设计
draft: false
---

# 属性卡预览

上面这段 frontmatter 在预览里渲染成属性表；点击它即可回到原始 YAML 编辑。
`

// 预览用的 mermaid 样例：图要撑满栏宽，点击放大后要按屏幕尺寸铺开（不是一两百 px）
const mermaidSample = `# 图表预览

流程图默认应当撑满正文栏宽，点击后放大到屏幕尺寸：

\`\`\`mermaid
flowchart LR
  A[读文件] --> B{切片}
  B -->|内容| C[预览块]
  B -->|缝隙| D[unknown 块]
  C --> E[写回原路径]
\`\`\`

只有两个节点的图也不该缩成一小团：

\`\`\`mermaid
graph TD
  X[输入] --> Y[输出]
\`\`\`
`

const sample = `# 阅读体验展示

> Lector —— 阅读优先的纯 Markdown 编辑器。未聚焦块以预览显示，点击任意块进入源码编辑。

## 中西文混排与行内

在 AI 时代，**读** 远大于 **写**。Markdown 是 AI 内容的事实格式，\`inline code\` 里可以放 \`const a = 1\`，链接请看 [CommonMark](https://commonmark.org)，编号 2026 与指标 1.618 也要排得顺眼。中文段落里混排 Latin 与数字，应当平滑而不突兀。

## 任务列表

- [ ] 未完成任务，后面还有一段未勾选
- [x] 已完成的任务，会显示为勾选态
- [x] 支持多行任务项，当文本足够长而换行时，续行应当对齐在复选框之后而不是回到 bullet 起点缩进。

## 一个表格

| 引擎 | 语言 | 体积 | 定位 |
| --- | --- | --- | --- |
| CodeMirror 6 | TS | ~4MB | 焦点块源码编辑 |
| ProseMirror | TS | 重 | 被排除（保真原罪） |
| Vditor | JS | 重 | 被排除（内核绑定） |

下面这张图点击可放大查看：

![示例图片](./images/sample.png)

## 代码块

\`\`\`ts
export function parseBlocks(text: string): BlockView[] {
  const tree = fromMarkdown(text, { extensions, mdastExtensions })
  return sliceSeamless(tree, text)
}
\`\`\`

---
第二段，用于测试「只改这一块」的切片保真。
`

void (async () => {
  await initSettings()
  // 大纲的折叠偏好（localStorage）要在第一次 renderOutline 之前读进来
  readCollapsedPref()
  // 窗口外框（无标题栏）：平台判定 + Windows 自绘控件 + 顶栏滚动分隔。
  // 浏览器预览也会走这里，按 UA 预演对应平台的版式。
  mountWindowControls()
  mountHeaderScrollState()
  mountLightbox()
  mountTip()
  // 右键菜单：capture 阶段接管，避免被块自身的点击处理先吃掉
  document.addEventListener('contextmenu', onContextMenu)
  // 视图切换（换文档、点空白）时收起菜单
  window.addEventListener('lector:doc-changed', hideContextMenu)
  // 阅读位置 → 大纲高亮。挂在正文容器上（骨架里滚动发生在正文里）。
  // 同步在滚动中给 html 加 is-scrolling 类，滚动停后 600ms 移除——
  // 滚动条只在「正在滚」时短暂露出，其他时候隐形，干净。
  let spyTick = false
  let scrollIdleTimer: number | null = null
  contentEl.addEventListener(
    'scroll',
    () => {
      document.documentElement.classList.add('is-scrolling')
      if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer)
      scrollIdleTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('is-scrolling')
        scrollIdleTimer = null
      }, 600)

      if (spyTick) return
      spyTick = true
      requestAnimationFrame(() => {
        spyTick = false
        updateActiveHeading()
      })
      scheduleRecordPosition()
    },
    { passive: true },
  )
  // 顶栏左侧与正文列对齐（窗口变化时自动重算；侧栏开合另见下方 onToggle）
  mountTitlebarInset()
  // 窗口尺寸变化时重判侧栏该停靠还是浮层。
  // 用 rAF 折叠连续事件，避免拖拽窗口时每帧都重排。
  let resizeTick = false
  window.addEventListener(
    'resize',
    () => {
      if (resizeTick) return
      resizeTick = true
      requestAnimationFrame(() => {
        resizeTick = false
        const wasDocked = document.documentElement.classList.contains('sidebar-docked')
        sidebar.sync()
        const isDocked = document.documentElement.classList.contains('sidebar-docked')
        if (wasDocked !== isDocked) renderStatus()
      })
    },
    { passive: true },
  )
  if (detectEnv() === 'shell') {
    // 冷启动时不默认走空态——壳可能有 argv 要打开文件。先进加载态，
    // 有 pending 才走 loadSession，没有 pending 才回空态。
    renderLoadingState()
    try {
      const pending = await takePendingOpen()
      if (pending) {
        const res = await read(pending)
        loadSession(res.path, res.content, res.mtime_ms)
      } else {
        renderEmptyState()
      }
    } catch (err) {
      console.error('[lector] pending open', err)
      renderEmptyState()
    }
  } else {
    // 浏览器预览（vite dev）：默认载入内置样例，方便脱离壳调版式。
    // ?doc=empty 可切回空态，检查首屏。
    const params = new URLSearchParams(location.search)
    const which = params.get('doc')
    if (which === 'empty') renderEmptyState()
    else if (which === 'frontmatter') loadSession('frontmatter.md', frontmatterSample)
    else if (which === 'media') loadSession('media.md', mediaSample)
    else if (which === 'mermaid') loadSession('mermaid.md', mermaidSample)
    else loadSession(which || 'sample.md', sample)
  }
})()
