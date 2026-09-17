import type { BlockView } from '@lector/core'
import type { Sidebar } from './sidebar.ts'
import {
  buildOutlineTree,
  headingDepth,
  headingText,
  outlineSignature,
  type OutlineHeading,
  type OutlineNode,
} from './outlineModel.ts'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'

interface OutlineDeps {
  sidebar: Pick<Sidebar, 'body' | 'isOpen' | 'toggle'>
  contentEl: HTMLElement
  getBlocks(): readonly BlockView[]
  getBlockElement(id: string): HTMLElement | undefined
  isLargeDocument(): boolean
}

export function createOutline({ sidebar, contentEl, getBlocks, getBlockElement, isLargeDocument }: OutlineDeps) {
  /**
   * 大纲签名：标题的 id / 级别 / 文字。变了就说明大纲该重建。
   * 紧挨着侧栏声明放：这个变量在模块初始化期就可能被读到，声明位置不能再往下挪。
   */
  let lastOutlineSignature = ''

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
    if (isLargeDocument()) {
      // 大文件不建块，也就没有现成的标题列表。这里明确说明「不可用」，
      // 而不是留一片空白让人以为文档��有标题。
      sidebar.body.innerHTML = ''
      const p = document.createElement('p')
      p.className = 'outline-empty'
      p.textContent = t('outlineLargeUnavailable')
      sidebar.body.appendChild(p)
      return
    }
    const headings: OutlineHeading[] = getBlocks()
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
        // 文字要包一层：.outline-row 是 flex 容器，text-overflow 对它的匿名文本子项
        // 不生效，长标题只会被硬切（没有省略号）。包成带 min-width:0 的 flex 子项才省略。
        const rowText = document.createElement('span')
        rowText.className = 'outline-text'
        rowText.textContent = n.text
        row.appendChild(rowText)
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
    const el = getBlockElement(id)
    if (!el) return
    // 瞬时跳转：浏览器的 smooth 时长不受控，长距离能滑 1s+，导航要的是立刻到达
    // （与 findHighlight 的跳转同一取舍）。
    el.scrollIntoView({ behavior: 'auto', block: 'start' })
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
   * 阅读线定在容器顶部���方 72px：标题刚进视口时就切过去太早
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
        const el = getBlockElement(id)
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

  function refresh(): void {
    const sig = outlineSignature(getBlocks())
    if (sig !== lastOutlineSignature) {
      lastOutlineSignature = sig
      if (sidebar.isOpen()) renderOutline()
    }
  }

  function reset(): void {
    lastOutlineSignature = ''
  }

  return { readCollapsedPref, renderOutline, updateActiveHeading, toggleOutline, refresh, reset }
}
