import type { BlockView } from '@lector/core'
import { undo, redo } from '@codemirror/commands'
import { openExternal, readClipboard } from '@lector/shell-web'
import { safeHref } from './mdastHtml.ts'
import { copyText, showToast } from './feedback.ts'
import { showContextMenu, hideContextMenu, isContextMenuOpenFor, type ContextMenuItem } from './contextMenu.ts'
import { resolveMenuDecision } from './menuTarget.ts'
import { t } from './i18n.ts'
import { mod, modShift } from './keys.ts'
import type { DocumentEditor } from './documentEditor.ts'
import type { FileController } from './fileController.ts'
import type { ViewMode } from './editorChrome.ts'

export function createDocumentMenus({
  editor,
  files,
  imageMenuItems,
  contentEl,
  getViewMode,
  exportPdf,
}: {
  editor: Pick<DocumentEditor, 'getSession' | 'getCmView' | 'allRawText' | 'openFind' | 'operations'>
  files: Pick<FileController, 'currentDiskPath' | 'openDefaultApp' | 'openWithLabel' | 'revealCurrent' | 'closeFile'>
  imageMenuItems: (img: HTMLImageElement) => ContextMenuItem[]
  contentEl: HTMLElement
  getViewMode: () => ViewMode
  /** 导出 PDF：实现在 editorChrome，菜单只负责把它挂进「更多文件操作」。 */
  exportPdf: () => Promise<void>
}) {
  // ───────────── 右键菜单 ─────────────
  // 分场景给菜单：读代码的要「复制」，改文档的要「删除/插入」，点了任务的想「勾选」。
  // 同一个菜单套所有场景会让每一项都显得可疑。

  /**
   * 只读档（阅读）只给「读」的动作。
   *
   * 阅读是主路径，编辑只是「顺手能改」。**右键菜单是两档唯一共用的入口**——
   * 点块进入编辑那条路本来就在只读档 return 了（见 appBindings 的 click 处理），
   * 而这份菜单一直没分档，于是阅读档右键表格会端出「编辑表格…」，
   * 等于从侧门把编辑能力放回了只读档。
   *
   * 规矩只有这一条：标了 mutates 的项在阅读档一律不出现。新增会改文档的菜单项时
   * 必须自己标上——所以下面每一项的 mutates 都是刻意写的，不是漏的。
   */
  function forMode(items: ContextMenuItem[]): ContextMenuItem[] {
    if (getViewMode() !== 'read') return items
    const kept = items.filter((i) => !i.mutates)
    // 过滤后第一项不能还挂着分隔线，否则菜单顶上多一条横线
    if (kept.length > 0 && kept[0]!.separatorBefore) {
      kept[0] = { ...kept[0]!, separatorBefore: false }
    }
    return kept
  }

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
      // 撤销/重做/剪切/粘贴都会改文档，标上 mutates：它们在阅读档结构上就到不了
      // （阅读档没有嵌着的 CM，见 editorChrome.setViewMode 的 defocus），
      // 标了只是让「阅读档不给改文档的动作」这条规矩没有例外可钻。
      { label: t('menuUndo'), hint: mod('Z'), mutates: true, run: () => editor.getCmView() && undo(editor.getCmView()!) },
      { label: t('menuRedo'), hint: modShift('Z'), mutates: true, run: () => editor.getCmView() && redo(editor.getCmView()!) },
      { separatorBefore: true, label: t('menuCut'), hint: mod('X'), mutates: true, run: run('cut') },
      { label: t('menuCopy'), hint: mod('C'), run: run('copy') },
      {
        label: t('menuPaste'),
        hint: mod('V'),
        mutates: true,
        run: () => {
          // 走 readClipboard()：壳里是 IPC 命令（webview 自己的 readText 在 macOS 上
          // 一律被拒，菜单里那一项因此长期只会弹「请用 ⌘V」）。
          // 仍然留失败回执：浏览器预览和真的读不到时，要告诉用户走 ⌘V，别让人以为应用坏了。
          void readClipboard()
            .then((text) => {
              const view = editor.getCmView()
              if (!text || !view) return
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
    // 源码档没有 .preview，而「纯文本」在那里就是源码本身——早先这里只读
    // preview，结果源码档复制到的是空串，剪贴板 API 对空串照样成功，于是
    // 弹「已复制」却什么都没进剪贴板。有过选区时优先复制选区（同其他应用里
    // 「复制为纯文本」的语义），没有才回退整块。
    const selection = window.getSelection()?.toString() ?? ''
    const plain = selection || preview?.textContent || raw
    const tableItems: ContextMenuItem[] =
      block.kind === 'table'
        ? [{ label: t('menuEditTable'), mutates: true, run: () => editor.operations.openTableForBlock(block) }]
        : []
    return [
      ...tableItems,
      {
        separatorBefore: tableItems.length > 0,
        // 不写 hint：标签自己已经说清是 Markdown（同下面两条「纯文本 / HTML」），
        // 再在右端放一个 Markdown 就是同一句话说两遍；hint 那一栏留给快捷键。
        label: t('menuCopyBlock'),
        run: () => void copyText(raw, t('menuCopied')),
      },
      {
        label: t('menuCopyText'),
        // 渲染后的纯文本：粘进聊天窗口时不该带 ** 和 #
        run: () => void copyText(plain, t('menuCopied')),
      },
      // HTML 只在预览档才有：源码档没有渲染结果，留着就是一个只会复制空串的项。
      ...(preview
        ? [
            {
              label: t('menuCopyHtml'),
              // HTML 片段：粘进邮件/富文本编辑器时保留结构与表格
              run: () => void copyText(preview.innerHTML, t('menuCopied')),
            },
          ]
        : []),
      {
        separatorBefore: true,
        label: t('menuCutBlock'),
        mutates: true,
        run: () => {
          void copyText(raw, t('menuCopied'))
          editor.operations.deleteBlock(block.id)
        },
      },
      {
        label: t('menuDeleteBlock'),
        danger: true,
        mutates: true,
        run: () => editor.operations.deleteBlock(block.id),
      },
      {
        separatorBefore: true,
        label: t('menuInsertBefore'),
        mutates: true,
        run: () => editor.operations.insertParagraphBefore(block.id),
      },
      {
        label: t('menuInsertAfter'),
        mutates: true,
        run: () => editor.operations.insertParagraphAfter(block.id),
      },
      {
        label: t('menuInsertMermaid'),
        mutates: true,
        run: () => editor.operations.insertMermaidAfter(block.id),
      },
    ]
  }

  /**
   * 在 (x, y) 弹出某个块的块级菜单。返回是否弹出了。
   *
   * 右键与左侧块把手共用这一份：把手存在的意义就是让这份菜单可被发现
   * （此前它只能靠右键猜）。菜单内容只有一份真相，两条入口不许各写一套。
   *
   * 返回 false 让右键那条路继续往下走（落到「段间空白」菜单），
   * 不能悄悄吞掉——右键本来就没有反馈，吞了等于点了没反应。
   */
  function openBlockMenu(blockEl: HTMLElement, x: number, y: number): boolean {
    const id = blockEl.dataset.blockId
    const block = id ? editor.getSession().blocks.find((b) => b.id === id) : undefined
    // unknown 类是解析不出内容的块，给它一份「复制/删除本块」菜单只会让人误判
    if (!block || block.kind === 'unknown') return false
    const items = forMode(blockMenuItems(block, blockEl))
    // 只读档过滤后可能一个都不剩（理论上不会：复制三项永远在），那就别弹空菜单
    if (items.length === 0) return false
    appendSelectionCopy(items)
    showContextMenu(items, x, y)
    return true
  }

  /**
   * 任务项上的菜单。
   *
   * ⚠ 有意不标 mutates：勾选任务在阅读档也允许。理由是「勾一下」是读的时候最顺手的动作，
   * 为了它先切编辑档再切回来不合理（同一条决定见 appBindings 的复选框点击处理）。
   * 这是「阅读档不给改文档」这条规矩唯一的例外，所以写在这里，不藏在标记里。
   */
  function taskMenuItems(block: BlockView, itemIndex: number, checked: boolean): ContextMenuItem[] {
    return [
      {
        label: checked ? t('menuUncheck') : t('menuCheck'),
        run: () => editor.operations.toggleTaskItem(block, itemIndex, !checked),
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

  /**
   * 表单输入框（设置里的图床命令、查找框…）上的菜单：标准编辑动作。
   *
   * 不能放行 webview 默认菜单——它端出来的是浏览器的那份（刷新 / 打印 / 检查元素），
   * 而这里真正需要的是剪切 / 复制 / 粘贴 / 全选。
   */
  function fieldMenuItems(field: HTMLElement): ContextMenuItem[] {
    const box =
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null
    const hasSelection = box
      ? box.selectionStart !== null && box.selectionStart !== box.selectionEnd
      : !window.getSelection()?.isCollapsed
    const exec = (cmd: string) => () => {
      document.execCommand(cmd)
    }
    return [
      { label: t('menuUndo'), hint: mod('Z'), run: exec('undo') },
      { label: t('menuRedo'), hint: modShift('Z'), run: exec('redo') },
      { separatorBefore: true, label: t('menuCut'), hint: mod('X'), disabled: !hasSelection, run: exec('cut') },
      { label: t('menuCopy'), hint: mod('C'), disabled: !hasSelection, run: exec('copy') },
      { label: t('menuPaste'), hint: mod('V'), run: () => void pasteIntoField(field) },
      {
        label: t('menuSelectAll'),
        hint: mod('A'),
        run: () => {
          if (box) box.select()
          else document.execCommand('selectAll')
        },
      },
    ]
  }

  /** 把剪贴板文本插到输入框光标处。execCommand('paste') 在 webview 里被禁，只能自己读（走壳的命令）。 */
  async function pasteIntoField(field: HTMLElement): Promise<void> {
    try {
      const text = await readClipboard()
      if (!text) return
      field.focus()
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        const start = field.selectionStart ?? field.value.length
        const end = field.selectionEnd ?? start
        field.setRangeText(text, start, end, 'end')
        field.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        document.execCommand('insertText', false, text)
      }
    } catch {
      showToast(t('menuPasteFailed'))
    }
  }

  /** 正文里已选中文字时，往菜单末尾补一条「复制选中的文字」。 */
  function appendSelectionCopy(items: ContextMenuItem[]): void {
    const text = window.getSelection()?.toString() ?? ''
    if (!text) return
    items.push({
      separatorBefore: true,
      label: t('menuCopySelection'),
      hint: mod('C'),
      run: () => void copyText(text, t('menuCopied')),
    })
  }

  /**
   * 文件级菜单：低频文件动作的**唯一真相**。
   *
   * 两处入口共用它——右键文件名（加速器）与文件名旁的 ⋯（可见入口，见
   * editorChrome 的 fileMoreBtn）。两处各写一份必然漂移，用户会看到同一件事
   * 两种说法。
   */
  function fileMenuItems(): ContextMenuItem[] {
    const path = files.currentDiskPath()
    const items: ContextMenuItem[] = []
    if (!path) return items
    items.push(
      // 标签跟着设置走：配了外部应用就写明是哪个，没配才说"默认应用"。
      // 标签与实际行为不一致，比没有这个入口更糟——用户会按标签预期。
      { label: files.openWithLabel(), run: () => void files.openDefaultApp() },
      { label: t('exportPdfTip'), run: () => void exportPdf() },
      { separatorBefore: true, label: t('menuReveal'), run: () => void files.revealCurrent() },
      { label: t('menuCopyPath'), run: () => void copyText(path, t('menuCopied')) },
    )
    if (editor.getSession().source) {
      items.push({
        separatorBefore: true,
        label: t('menuCloseFile'),
        run: () => void files.closeFile(),
      })
    }
    return items
  }

  /** ⋯ 按钮入口：贴按钮下沿弹同一份文件菜单；再点一次收起（toggle）。 */
  function openFileMenu(anchor: HTMLElement): void {
    if (isContextMenuOpenFor(anchor)) {
      hideContextMenu()
      return
    }
    const r = anchor.getBoundingClientRect()
    showContextMenu(fileMenuItems(), Math.round(r.left), Math.round(r.bottom + 6), anchor)
  }

  /** 右键入口：按目标决定给哪套菜单。
   *
   * 这里只做两件事：把 DOM 探测翻译成 MenuHints、按纯函数给出的结论执行。
   * **优先级规则一律不写在这**（见 menuTarget.ts 的说明）。 */
  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null
    if (!target) return

    const session = editor.getSession()
    const link = target.closest('a') as HTMLAnchorElement | null
    const blockEl = target.closest('.block') as HTMLElement | null
    const field = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null
    const task = taskHit(target)

    const decision = resolveMenuDecision({
      inTitlebarTitle: !!target.closest('.titlebar-title'),
      inEditor: !!target.closest('.cm-content'),
      inField: !!field,
      inContent: !!target.closest('#content'),
      hasSource: !!session.source,
      inProse: !!target.closest('.reading-prose'),
      isImage: target.tagName === 'IMG',
      linkHref: link ? (link.getAttribute('href') ?? '') : null,
      inTask: !!task,
      inBlock: !!blockEl,
      hasSelection: (window.getSelection()?.toString() ?? '').length > 0,
    })

    // 所有分支都要吞掉 webview 的默认菜单（刷新 / 打印 / 检查元素）——它不属于这个应用。
    // 原来的写法是在每个 return 之前各写一遍，漏一处就会从缝里漏出「检查元素」。
    e.preventDefault()

    switch (decision.kind) {
      case 'titlebar': {
        // 右键文件名 = 加速器；同一份菜单也能从 ⋯ 按钮弹出（见 openFileMenu）。
        const items = fileMenuItems()
        if (items.length > 0) showContextMenu(items, e.clientX, e.clientY)
        return
      }

      case 'editor':
        showContextMenu(forMode(editorMenuItems()), e.clientX, e.clientY)
        return

      case 'field':
        // field 由上面同一份 hints 算出，非空；用守卫而不是 `!`——类型不该靠断言维持
        if (field) showContextMenu(fieldMenuItems(field), e.clientX, e.clientY)
        return

      case 'image':
        showContextMenu(forMode(imageMenuItems(target as HTMLImageElement)), e.clientX, e.clientY)
        return

      case 'link':
        showContextMenu(linkMenuItems(decision.href), e.clientX, e.clientY)
        return

      case 'task':
        if (task) {
          showContextMenu(forMode(taskMenuItems(task.block, task.index, task.checked)), e.clientX, e.clientY)
        }
        return

      case 'block':
        // openBlockMenu 自己判断这个块有没有可给的菜单；给不出就落到下面的留白分支
        if (blockEl && openBlockMenu(blockEl, e.clientX, e.clientY)) return
        showBlankAreaMenu(target, e)
        return

      case 'blankArea':
        showBlankAreaMenu(target, e)
        return

      // 正文之外选中了文字：只给「复制」——这些地方以前被兜底糊了整份文档菜单，连复制都做不到
      case 'copySelection': {
        const selected = window.getSelection()?.toString() ?? ''
        showContextMenu(
          [{ label: t('menuCopy'), hint: mod('C'), run: () => void copyText(selected, t('menuCopied')) }],
          e.clientX,
          e.clientY,
        )
        return
      }

      // 其余地方（空白、不可选中的 chrome）：默认菜单已吞，不再弹任何东西——
      // 原生应用在非交互区域右键就是这个行为，弹一份「猜你想干什么」的菜单才是噪音。
      case 'none':
        return
    }
  }

  /** 段间空白 / 正文列留白：贴着最近的内容块给一份短菜单（八成还是「在这儿加一段」）。 */
  function showBlankAreaMenu(target: HTMLElement, e: MouseEvent): void {
    const items = forMode(blankAreaMenuItems(nearestBlockBefore(target)))
    if (items.length === 0) return
    appendSelectionCopy(items)
    showContextMenu(items, e.clientX, e.clientY)
  }

  /**
   * li.task → 它所属的块、块内第几条、当前是否勾选。
   * 定位不到块（块 id 对不上、块未知）就当没命中，交给后面的分支处理。
   */
  function taskHit(target: HTMLElement): { block: BlockView; index: number; checked: boolean } | null {
    const li = target.closest('li.task') as HTMLLIElement | null
    const blockEl = li?.closest('.block') as HTMLElement | null
    const id = blockEl?.dataset.blockId
    const block = id ? editor.getSession().blocks.find((b) => b.id === id) : undefined
    if (!li || !blockEl || !block) return null
    const items = Array.from(blockEl.querySelectorAll('li.task'))
    const box = li.querySelector('input[type=checkbox]') as HTMLInputElement | null
    return { block, index: items.indexOf(li), checked: !!box?.checked }
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
    if (node === content) {
      // 点在正文列自身的空白（最后一块之后的空片）：target 就是 #content，
      // 下面的循环会直接跳过返回 null——「在文首插入段落」于是永远灰着。
      node = content.lastElementChild
      // 末尾那块本身就是内容块：它就是离点击最近的块（插入应落在它后面）
      if (node) {
        const pid = (node as HTMLElement).dataset?.blockId
        const b = pid ? editor.getSession().blocks.find((x) => x.id === pid) : undefined
        if (b && b.kind !== 'unknown') return b
      }
      // 末尾是空白缝：从缝往前找（下面的循环）
    }
    while (node && node !== content) {
      let prev = node.previousElementSibling
      while (prev) {
        const pid = (prev as HTMLElement).dataset?.blockId
        const b = pid ? editor.getSession().blocks.find((x) => x.id === pid) : undefined
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
        mutates: true,
        run: () => nearest && editor.operations.insertParagraphAfter(nearest.id),
      },
      { separatorBefore: true, label: t('menuCopyAll'), run: () => void copyText(editor.allRawText(), t('menuCopied')) },
      { label: t('findAria'), hint: mod('F'), run: () => editor.openFind() },
      { label: t('menuSelectAll'), hint: mod('A'), run: () => selectAllText() },
    ]
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

  return { onContextMenu, openBlockMenu, selectAllText, openFileMenu }
}

export type DocumentMenus = ReturnType<typeof createDocumentMenus>
