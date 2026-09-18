import { detectEnv, onMenu, closeWindow } from '@lector/shell-web'
import { showToast } from './feedback.ts'
import { t } from './i18n.ts'
import { stepFontSize, stepUiZoom, resetFontSize, resetUiZoom, notify } from './settings.ts'
import { openSettingsModal } from './settingsModal.ts'
import { openAppearancePop } from './appearancePop.ts'
import { mountTitlebarInset } from './chrome.ts'
import { classifyHref, openHref, shouldOpenHref } from './linkOpen.ts'
import { VIEW_MODES } from './editorChrome.ts'
import { resolveShortcut } from './shortcutDispatch.ts'
import type { DocumentEditor } from './documentEditor.ts'
import type { FileController } from './fileController.ts'
import type { EditorChrome } from './editorChrome.ts'
import type { createOutline } from './outline.ts'
import type { DocumentMenus } from './documentMenus.ts'
import type { Sidebar } from './sidebar.ts'
import type { createReadingPositionController } from './readingPositionController.ts'

interface AppBindingsDeps {
  editor: Pick<DocumentEditor, 'getSession' | 'getCmView' | 'focusBlock' | 'defocus' | 'openFind' | 'operations'>
  files: Pick<FileController, 'openFromShellOrDialog' | 'persistToDisk' | 'saveAsFlow' | 'closeFile' | 'reloadFromDisk' | 'openDefaultApp' | 'openWithLabel' | 'revealCurrent'>
  chrome: Pick<EditorChrome, 'elements' | 'getViewMode' | 'setViewMode' | 'toggleMode'>
  outline: Pick<ReturnType<typeof createOutline>, 'toggleOutline' | 'updateActiveHeading'>
  /** 块把手要唤出块菜单，而菜单内容住在 documentMenus 里（不复制一份）。 */
  menus: Pick<DocumentMenus, 'openBlockMenu'>
}

export function bindAppEvents({ editor, files, chrome, outline, menus }: AppBindingsDeps): void {
  chrome.elements.contentEl.addEventListener('click', (e) => {
    // 块把手：它只负责唤出块菜单，**不聚焦、不进入编辑**——
    // 「点块正文」才是进来改，「点把手」是管理这一块，两件事不能混成一个动作。
    // 放在最前面：它比下面那些判断都更具体（选区、链接、复选框都不可能落在把手上）。
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.block-handle')
    if (handle) {
      e.preventDefault()
      const blockEl = handle.closest<HTMLElement>('.block')
      if (blockEl) {
        // 从把手的右下角展开：把手本身、以及这一块的第一行都不被菜单压住
        const rect = handle.getBoundingClientRect()
        menus.openBlockMenu(blockEl, rect.right, rect.bottom)
      }
      return
    }
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
      const href = link.getAttribute('href') ?? ''
      const kind = classifyHref(href)
      // 一律 preventDefault：链接绝不能交给 webview 自己导航——本地点一下会整页跳走
      // 或 404（壳里更糟：webview 离开应用页面）。要做什么由我们决定。
      e.preventDefault()
      // 分档见 linkOpen.ts：阅读档直接点就开；编辑/源码档要 Cmd/Ctrl，
      // 不加修饰键就**不 return**，落到下面的聚焦逻辑——在那一档里点链接的第一含义
      // 是「进这一块改」，跟点块里别的地方是同一件事。
      if (shouldOpenHref(kind, chrome.getViewMode(), e.metaKey || e.ctrlKey)) {
        // 锚点跳转的搜索范围限定在链接所在的预览根（编辑态块里也有标题预览）
        void openHref(
          kind,
          href,
          editor.getSession().source?.path ?? null,
          link.closest<HTMLElement>('.preview'),
        )
        return
      }
    }
    // 任务复选框：点一下直接改写源码里的 [ ]/[x]，而不是进源码编辑。
    // 只读模式同样可用——勾选是「顺手改」，不该被要求先切编辑档。
    const box = (e.target as HTMLElement).closest<HTMLInputElement>('li.task input[type=checkbox]')
    if (box && box.closest('.preview')) {
      e.preventDefault()
      const blockEl = box.closest<HTMLElement>('.block')
      const id = blockEl?.dataset.blockId
      const block = id ? editor.getSession().blocks.find((b) => b.id === id) : undefined
      const li = box.closest('li.task')
      if (block && blockEl && li) {
        const items = Array.from(blockEl.querySelectorAll('li.task'))
        // 目标态读 defaultChecked（渲染时源码属性的镜像），不读 box.checked：
        // 浏览器在事件派发前就已经把复选框原生翻转了，读 checked 拿到的永远是反值。
        editor.operations.toggleTaskItem(block, items.indexOf(li), !box.defaultChecked)
      }
      return
    }
    // 只读模式：块点击不抢 focus，只在末车是「点上」时（mermaid 容器、表格预览）交给各自处理。
    // 表格预览在只读下不打开（想改就进编辑模式），别在读路径上引另一个跳转。
    if (chrome.getViewMode() === 'read') {
      return
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>('.block:not(.gap)')
    if (!target) {
      if (editor.getSession().focusedId !== null) editor.defocus()
      return
    }
    const id = target.dataset.blockId
    if (!id) return
    // 表格块点预览 = 打开网格编辑弹窗（改表格在纯文本里太痛苦；
    // 想直接改源码，弹窗里有「编辑源码」退路）。
    // **只在「编辑」档**：源码档的承诺是「每个块都以源码呈现，点它改它的源码」，
    // 在那一档弹出网格面板会打断这个承诺——用户点表格想看源码，却拿到一个面板。
    const block = editor.getSession().blocks.find((b) => b.id === id)
    if (block?.kind === 'table' && chrome.getViewMode() === 'edit') {
      editor.operations.openTableForBlock(block)
      return
    }
    editor.focusBlock(id, { mode: 'coords', x: e.clientX, y: e.clientY })
  })

  // 全局快捷键的判定表在 shortcutDispatch.ts（纯的，可单测）。这里只做两件事：
  // 把事件与编辑器状态翻译成 hints，执行返回的动作。聚焦块里的裸 CM 会 preventDefault
  // 自己认识的键（Ctrl+E 行内代码、Ctrl+B 粗体…），表里靠 defaultPrevented 让位。
  window.addEventListener('keydown', (e) => {
    const action = resolveShortcut({
      mod: e.metaKey || e.ctrlKey,
      shift: e.shiftKey,
      key: e.key,
      defaultPrevented: e.defaultPrevented,
      focusedBlock: editor.getSession().focusedId !== null,
      editorMounted: editor.getCmView() !== null,
      hasSource: editor.getSession().source !== null,
    })
    if (!action) return
    // 块级撤销是唯一可能「什么都没撤销」的动作：只有真的撤销了才拦事件。
    if (action.kind === 'undo-block') {
      if (editor.operations.undoBlockOp()) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    e.preventDefault()
    switch (action.kind) {
      case 'leave-edit':
        editor.defocus()
        break
      case 'save-as':
        void files.saveAsFlow()
        break
      case 'save':
        // 直接走存盘，不通过按钮的 click：按钮在「没有未保存改动」时是禁用的，
        // 而禁用的按钮 click() 不会触发任何东西——快捷键因此会被自己的禁用态吃掉。
        // 存盘是文档级动作，不该受控件状态影响。
        void files.persistToDisk()
        break
      case 'open':
        chrome.elements.openBtn.click()
        break
      case 'reload':
        void files.reloadFromDisk()
        break
      case 'close-file':
        void files.closeFile()
        break
      case 'close-window':
        void closeWindow()
        break
      case 'toggle-outline':
        chrome.elements.outlineBtn.click()
        break
      case 'open-settings':
        chrome.elements.settingsBtn.click()
        break
      case 'ui-zoom':
        if (action.dir === 0) resetUiZoom()
        else stepUiZoom(action.dir)
        break
      case 'font-size':
        if (action.dir === 0) resetFontSize()
        else stepFontSize(action.dir)
        break
      case 'find':
        editor.openFind()
        break
      case 'cycle-mode':
        chrome.toggleMode()
        break
      case 'set-mode':
        chrome.setViewMode(VIEW_MODES[action.index]!)
        break
    }
  })

  // 界面缩放：Ctrl/⌘ + 滚轮（触控板捏合也会被浏览器报成 ctrl+wheel）。
  // 与快捷键走同一个 stepUiZoom；节流，免得一次惯性滚动连跳好几档。
  // 图片灯箱自己也处理修饰键滚轮（zoomView.ts），它先 preventDefault，这里放行。
  let lastZoomWheel = 0
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.defaultPrevented) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastZoomWheel < 120) return
      lastZoomWheel = now
      stepUiZoom(e.deltaY < 0 ? 1 : -1)
    },
    { passive: false },
  )

  chrome.elements.openBtn.addEventListener('click', () => void files.openFromShellOrDialog())

  // 「外观」= 明暗 + 阅读主题。不是一个「切换深浅色」按钮：
  // 那个按钮把两件事（白天/晚上、读起来像什么）压成了一个开关。
  chrome.elements.appearanceBtn.addEventListener('click', () => openAppearancePop(chrome.elements.appearanceBtn))
  // 再点一次收起（浮层自己处理 toggle），Esc / 点外面也收
  chrome.elements.settingsBtn.addEventListener('click', () => openSettingsModal())
  chrome.elements.outlineBtn.addEventListener('click', () => outline.toggleOutline())

  chrome.elements.findBtn.addEventListener('click', () => editor.openFind())
  chrome.elements.saveBtn.addEventListener('click', () => void files.persistToDisk())
  // 「用其他应用打开」从标题右键菜单提到顶栏：它和打开/保存一样是「对这份文件做的事」。
  // tip 跟随设置里的应用名（用 Typora 打开 / 用默认应用打开），与右键菜单同一口径——
  // 标签必须说真话，否则用户点了才知道打开的是谁。
  chrome.elements.openWithBtn.addEventListener('click', () => void files.openDefaultApp())
  const syncOpenWithTip = () => {
    chrome.elements.openWithBtn.dataset.tip = files.openWithLabel()
    chrome.elements.openWithBtn.setAttribute('aria-label', files.openWithLabel())
  }
  syncOpenWithTip()
  notify(syncOpenWithTip)
  // 原生菜单
  if (detectEnv() !== 'shell') return
  void onMenu((action) => {
    switch (action) {
      case 'open':
        void files.openFromShellOrDialog()
        break
      case 'save':
        chrome.elements.saveBtn.click()
        break
      case 'save-as':
        void files.saveAsFlow()
        break
      case 'find':
        editor.openFind()
        break
      case 'theme':
        // 菜单里的「外观」与顶栏 Aa 按钮是同一个浮层（原生菜单也走同一条路）
        openAppearancePop(chrome.elements.appearanceBtn)
        break
      case 'outline':
        outline.toggleOutline()
        break
      case 'reload':
        void files.reloadFromDisk()
        break
      case 'open-default':
        void files.openDefaultApp()
        break
      case 'reveal':
        void files.revealCurrent()
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

export function bindReadingEvents({
  contentEl,
  sidebar,
  outline,
  positions,
  renderStatus,
}: {
  contentEl: HTMLElement
  sidebar: Sidebar
  outline: Pick<ReturnType<typeof createOutline>, 'updateActiveHeading'>
  positions: Pick<ReturnType<typeof createReadingPositionController>, 'scheduleRecordPosition'>
  renderStatus(): void
}): void {
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
        outline.updateActiveHeading()
      })
      positions.scheduleRecordPosition()
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
}
