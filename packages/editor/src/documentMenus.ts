import type { BlockView } from '@lector/core'
import { undo, redo } from '@codemirror/commands'
import { openExternal } from '@lector/shell-web'
import { safeHref } from './mdastHtml.ts'
import { copyText, showToast } from './feedback.ts'
import { showContextMenu, type ContextMenuItem } from './contextMenu.ts'
import { t } from './i18n.ts'
import { mod, modShift } from './keys.ts'
import type { DocumentEditor } from './documentEditor.ts'
import type { FileController } from './fileController.ts'

export function createDocumentMenus({
  editor,
  files,
  imageMenuItems,
  contentEl,
}: {
  editor: Pick<DocumentEditor, 'getSession' | 'getCmView' | 'allRawText' | 'openFind' | 'operations'>
  files: Pick<FileController, 'currentDiskPath' | 'openDefaultApp' | 'revealCurrent' | 'closeFile'>
  imageMenuItems: (img: HTMLImageElement) => ContextMenuItem[]
  contentEl: HTMLElement
}) {
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
      { label: t('menuUndo'), hint: mod('Z'), run: () => editor.getCmView() && undo(editor.getCmView()!) },
      { label: t('menuRedo'), hint: modShift('Z'), run: () => editor.getCmView() && redo(editor.getCmView()!) },
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
    const tableItems: ContextMenuItem[] =
      block.kind === 'table' ? [{ label: t('menuEditTable'), run: () => editor.operations.openTableForBlock(block) }] : []
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
          editor.operations.deleteBlock(block.id)
        },
      },
      {
        label: t('menuDeleteBlock'),
        danger: true,
        run: () => editor.operations.deleteBlock(block.id),
      },
      { separatorBefore: true, label: t('menuInsertBefore'), run: () => editor.operations.insertParagraphBefore(block.id) },
      { label: t('menuInsertAfter'), run: () => editor.operations.insertParagraphAfter(block.id) },
      { label: t('menuInsertMermaid'), run: () => editor.operations.insertMermaidAfter(block.id) },
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
    const items = blockMenuItems(block, blockEl)
    appendSelectionCopy(items)
    showContextMenu(items, x, y)
    return true
  }

  /** 任务项上的菜单。 */
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

  /** 把剪贴板文本插到输入框光标处。execCommand('paste') 在 webview 里被禁，只能自己读。 */
  async function pasteIntoField(field: HTMLElement): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
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

  /** ��键入口：按目标决定给哪套菜单。 */
  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null
    if (!target) return

    // 顶栏文件名：文件级动作（联动其他应用、显示位置、复制路径）+ 关闭文件
    if (target.closest('.titlebar-title')) {
      const path = files.currentDiskPath()
      const items: ContextMenuItem[] = []
      if (path) {
        items.push(
          { label: t('menuOpenDefault'), run: () => void files.openDefaultApp() },
          { label: t('menuReveal'), run: () => void files.revealCurrent() },
          { label: t('menuCopyPath'), run: () => void copyText(path, t('menuCopied')) },
        )
      }
      if (editor.getSession().source) {
        items.push({
          separatorBefore: items.length > 0,
          label: t('menuCloseFile'),
          run: () => void files.closeFile(),
        })
      }
      // 无论有没有东西可给，都要吞掉默认菜单：顶栏不该冒出浏览器的「检查元素」
      e.preventDefault()
      if (items.length > 0) showContextMenu(items, e.clientX, e.clientY)
      return
    }

    // 聚焦块的 CodeMirror：编辑菜单（撤销/复制/粘贴…）
    if (target.closest('.cm-content')) {
      e.preventDefault()
      showContextMenu(editorMenuItems(), e.clientX, e.clientY)
      return
    }

    // 输入控件：给应用自己的编辑菜单，而不是放行 webview 那份（带「检查元素」）
    const field = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null
    if (field) {
      e.preventDefault()
      showContextMenu(fieldMenuItems(field), e.clientX, e.clientY)
      return
    }

    // 到这儿还没命中，就先把 webview 默认菜单吞掉。
    //
    // 它端出来的是浏览器的那一份：刷新 / 打印 / 后退 / 检查元素，"检查元素"更是
    // 直接把 F12 开发者工具递给普通用户——这在一个本地 Markdown 阅读器里是纯噪音。
    // 所以**每个表面都必须显式决定给什么**，不能让默认菜单从缝里漏出来。
    e.preventDefault()

    // 正文里的块：文档自己的菜单（图片 / 链接 / 任务 / 块 / 段间空白）
    if (target.closest('#content') && editor.getSession().source) {
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
        const block = id ? editor.getSession().blocks.find((b) => b.id === id) : undefined
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
      if (blockEl && openBlockMenu(blockEl, e.clientX, e.clientY)) return

      // 没落在任何块上：段间空白缝（.block.gap 没有 blockId）、正文列的两侧留白、
      // 最后一段之后的那片空。右键这里想做的事，八成还是「在这儿加一段」，
      // 所以贴着最近的内容块给一份短菜单。
      const items = blankAreaMenuItems(nearestBlockBefore(target))
      appendSelectionCopy(items)
      showContextMenu(items, e.clientX, e.clientY)
      return
    }

    // 正文之外、又选中了文字的表面（设置里的说明、侧栏、状态行…）：只给「复制」。
    // 这些地方以前被「没落在块上」的兜底糊了整份文档菜单，连复制都做不到。
    const selected = window.getSelection()?.toString() ?? ''
    if (selected) {
      showContextMenu(
        [{ label: t('menuCopy'), hint: mod('C'), run: () => void copyText(selected, t('menuCopied')) }],
        e.clientX,
        e.clientY,
      )
      return
    }

    // 其余地方（空白、不可选中的 chrome）：默认菜单已吞，不再弹任何东西——
    // 原生应用在非交互区域右键就是这个行为，弹一份「猜你想干什么」的菜单才是噪音。
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

  return { onContextMenu, openBlockMenu, selectAllText }
}

export type DocumentMenus = ReturnType<typeof createDocumentMenus>
