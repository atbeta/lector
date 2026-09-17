import { detectEnv, shellAssetResolver, notifyWebviewReady, read, printJobDone } from '@lector/shell-web'
import { setAssetResolver } from './asset.ts'
import { initSettings, notify as notifySettings } from './settings.ts'
import { mermaidRenderSignature } from './mermaid.ts'
import { createSidebar } from './sidebar.ts'
import { createOutline } from './outline.ts'
import { createReadingPositionController } from './readingPositionController.ts'
import { createDocumentEditor, type DocumentEditor } from './documentEditor.ts'
import { createEditorChrome, type EditorChrome } from './editorChrome.ts'
import { createRecoveryController } from './recoveryController.ts'
import { createFileController, type FileController } from './fileController.ts'
import { createImageController } from './imageController.ts'
import { createDocumentMenus } from './documentMenus.ts'
import { bindImageTransfer } from './imageTransfer.ts'
import { bindAppEvents, bindReadingEvents } from './appBindings.ts'
import { openStartupDocument } from './startupDocument.ts'
import { mountSelectionBubble } from './selectionBubble.ts'
import { mountLightbox } from './lightbox.ts'
import { mountTip } from './tip.ts'
import { hideContextMenu } from './contextMenu.ts'
import { mountWindowControls, mountHeaderScrollState } from './chrome.ts'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/source-serif-4'
import './styles/app.css'

// 模块加载即通知壳：此刻 WebView2 必然已可见且完成置顶，壳的 snap 覆盖层
// 借此重新提顶（建窗时 install 的那次会被 WebView2 的置顶竞态压回去）。
void notifyWebviewReady()

// ── 装配顺序约束（不要改） ──────────────────────────────────────────────
// 下面这些控制器是互相引用的：chrome 的 getSession 指向 editor，outline 指向 editor，
// recovery 指向 files，而 editor / files 又反过来要 chrome / recovery。所以声明顺序上
// 必然存在"回调里引用了还没初始化的 const"。
//
// 这能成立的前提只有一条：**这些工厂在构造期不得调用传入的回调**，只允许挂起来、
// 等组装完成后再回调。各个 createXxx 目前都遵守这条（构造期只取 DOM 与声明状态）。
// 谁要在构造期加一句回调调用（例如 getSession() 取初始值），这里立刻就是
// `ReferenceError: Cannot access 'editor' before initialization`，整个入口中断——
// 真机上表现为右上角按钮消失 + 白屏。
// 需要构造期的初始值就改成显式入参，不要顺手调回调。
const chrome: EditorChrome = createEditorChrome({
  getSession: () => editor.getSession(),
  isLarge: () => editor.isLarge(),
  getLargeInfo: () => editor.getLargeInfo(),
  defocus: () => editor.defocus(),
  render: () => editor.render(),
})
const contentEl = chrome.elements.contentEl

// 侧栏 = 当前文档的目录。停靠/浮层两种形态由 sidebar.ts 按窗口宽度决定。
const sidebar = createSidebar({
  onToggle: (open) => {
    chrome.elements.outlineBtn.classList.toggle('active', open)
    chrome.elements.outlineBtn.setAttribute('aria-pressed', String(open))
  },
})

const outline = createOutline({
  sidebar,
  contentEl,
  getBlocks: () => editor.getSession().blocks,
  getBlockElement: (id) => editor.getBlockElement(id),
  isLargeDocument: () => editor.isLarge(),
})

const positions = createReadingPositionController({
  getPath: () => editor.getSession().source?.path,
  getScroller: () => editor.activeScroller(),
  onRestore: () => outline.updateActiveHeading(),
})

const recovery = createRecoveryController({
  getSession: () => editor.getSession(),
  isLarge: () => editor.isLarge(),
  loadSession: (path, raw, mtimeMs) => files.loadSession(path, raw, mtimeMs),
  markStructuralDirty: () => editor.markStructuralDirty(),
})

const editor: DocumentEditor = createDocumentEditor({
  contentEl,
  getViewMode: () => chrome.getViewMode(),
  setViewMode: (m) => chrome.setViewMode(m),
  forceSourceMode: () => chrome.forceSourceMode(),
  setDocumentTitle: (p) => chrome.setDocumentTitle(p),
  setDocPresent: (p) => chrome.setDocPresent(p),
  beforeDirty: () => outline.refresh(),
  onDirty: () => {
    recovery.syncDirty()
    // 保存按钮跟着脏状态亮/灭（见 refreshSaveButton）
    chrome.refreshSaveButton()
    chrome.renderStatus()
  },
  resetOutline: () => outline.reset(),
  renderOutline: () => {
    if (sidebar.isOpen()) outline.renderOutline()
  },
  restoreReadingPosition: () => positions.restoreReadingPosition(),
  scheduleRecordPosition: () => positions.scheduleRecordPosition(),
})

const files: FileController = createFileController({ editor, chrome, recovery })
const images = createImageController({ editor })
const menus = createDocumentMenus({
  editor,
  files,
  imageMenuItems: images.imageMenuItems,
  contentEl,
  // 菜单要分档：阅读档只给「读」的动作（见 documentMenus 的 forMode）
  getViewMode: () => chrome.getViewMode(),
})

// 初始化：壳环境注入资源解析器 + 绑定事件
chrome.init()
bindImageTransfer({
  getBlocks: () => editor.getSession().blocks,
  ingestImageFile: (f, name, ref) => images.ingestImageFile(f, name, ref),
})
bindAppEvents({ editor, files, chrome, outline, menus })
if (detectEnv() === 'shell') {
  setAssetResolver(shellAssetResolver)
}
files.bindShellEvents()
files.bindCloseGuard()

/**
 * mermaid 的配色与选项是**烘进 SVG** 的（不像正文那样靠 CSS 变量自动跟随），
 * 所以主题或用户配置一变就得重画图。
 *
 * 防抖 250ms：设置里的 mermaid 配置是个文本框，边打边生效，但每敲一个字符都重画
 * 整篇文档没必要——用户停下来那一刻的结果才是他要看的。
 * 指纹变了才重画：改缩进、改无关设置（字号之类）都不会走到这里。
 */
let mermaidSig = mermaidRenderSignature()
let mermaidRedrawTimer: number | null = null
notifySettings((s) => {
  void s
  const next = mermaidRenderSignature()
  if (next === mermaidSig) return
  mermaidSig = next
  if (mermaidRedrawTimer !== null) window.clearTimeout(mermaidRedrawTimer)
  mermaidRedrawTimer = window.setTimeout(() => {
    mermaidRedrawTimer = null
    void editor.render()
  }, 250)
})

// 后台打印窗口：壳的 export_pdf_background 建的离屏窗口加载同一入口，
// 初始化脚本注入了 __lectorPrintJob（文档绝对路径）。这里只做一件事：
// 强制浅色（mermaid 烘进 SVG 的配色跟随 data-theme，浅色才有白底蓝主色的
// 友好图表）+ 打印样式 → 走真实渲染管线装载文档 → 通知壳可以 PrintToPdf。
// 正常初始化（窗口控件、设置、启动文档）全部跳过——这个窗口只印一份文档。
const printJobPath = (window as { __lectorPrintJob?: string }).__lectorPrintJob
if (printJobPath) {
  void (async () => {
    const root = document.documentElement
    root.setAttribute('data-theme', 'light')
    root.classList.add('printing')
    // 步骤写进窗口标题：导出再卡住，用户看标题就知道停在哪一步
    // （loading → rendering → printing；error/js error = 见 toast 详情）。
    document.title = 'Lector Print · loading'
    // 任何脚本错误立刻放行为导出失败（toast 显示详情），不再静默挂到 60s 看门狗。
    window.addEventListener(
      'error',
      (e) => {
        document.title = 'Lector Print · js error'
        void printJobDone(String(e.message || e))
      },
      { once: true },
    )
    try {
      const res = await read(printJobPath)
      files.loadSession(res.path, res.content, res.mtime_ms)
      document.title = 'Lector Print · rendering'
      // 等字体与异步渲染（KaTeX / mermaid 烘进 DOM）稳定后再放行打印。
      await document.fonts.ready
      await new Promise((r) => window.setTimeout(r, 900))
      document.title = 'Lector Print · printing'
      void printJobDone(null)
    } catch (err) {
      document.title = 'Lector Print · error'
      void printJobDone(String(err))
    }
  })()
} else {
  void (async () => {
  // 窗口���框（无标题栏）：平台判定 + Windows 自绘控件 + 顶栏滚动分隔。
  // 放在最前、且不依赖设置：壳的这三个键是"应用还能用"的最低保证，
  // 排在 await initSettings()（一次 IPC）之后，一旦那次 IPC 不落地，控件就永远挂不上。
  // 浏览器预览也会走这里，按 UA 预演对应平台的版式。
  mountWindowControls()
  mountHeaderScrollState()
  await initSettings()
  // 大纲的折叠偏好（localStorage）要在第一次 renderOutline 之前读进来
  outline.readCollapsedPref()
  mountSelectionBubble()
  mountLightbox()
  // 正文图片：点击弹动作菜单（查看原图 / 编辑源码 / 复制路径 / 图床…）
  images.mountImageActions()
  mountTip()
  // 右键菜单：capture 阶段接管，避免被块自身的点击处理先吃掉
  document.addEventListener('contextmenu', menus.onContextMenu)
  // 视图切换（换文档、点空白）时收起菜单
  window.addEventListener('lector:doc-changed', hideContextMenu)
  bindReadingEvents({
    contentEl,
    sidebar,
    outline,
    positions,
    renderStatus: () => chrome.renderStatus(),
  })
  await openStartupDocument(files)
  })()
}
