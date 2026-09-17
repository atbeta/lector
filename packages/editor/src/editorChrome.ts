import { countText, formatCount, readingMinutes } from '@lector/core'
import { bindTitlebar, exportPdf } from '@lector/shell-web'
import { baseName } from './paths.ts'
import { bindShortcutsButton } from './shortcutsPanel.ts'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { showToast } from './feedback.ts'
import type { DocumentSession } from './documentSession.ts'

// ───────────── 三视图模式 read / edit / source ─────────────
//
// 默认 read——多数场景是「读」不是「改」。
//
// read:   只读预览。点块不进编辑；mermaid / 图��点开放大。
// edit:   预览 + 点块就地编辑（改哪块点哪块）。这是「顺手能改」的主路径。
// source: 全篇等宽源码，点块进该块的源码编辑。通读原文 / 批量改格式用。
//
// 三档**常驻**在顶栏右侧的分段控件里，当前档一眼可见。
// 旧版是一个三态循环按钮，��钮上画的是「下一个模式」的图标，用户永远要��
// 「我现在在哪一档」；而且第三档叫「分屏」——屏幕上并没有第二条栏，
// 名字在承诺一件不存在的事。名字与档位一起改���：阅读 / 编辑 / 源码。
// 状态走 html[data-mode]——样式 / 点击 / 快捷键都只看这一个属性。
// 快捷键：⌘1 / ⌘2 / ⌘3 直选，⌘E 循环。
export type ViewMode = 'read' | 'edit' | 'source'

/** 顺序 = 分段控件里的顺序 = ⌘1/⌘2/⌘3 的顺序。 */
export const VIEW_MODES: readonly ViewMode[] = ['read', 'edit', 'source']
const VIEW_ICON: Record<ViewMode, string> = { read: 'eye', edit: 'pencil', source: 'code' }

function viewLabel(m: ViewMode): string {
  return m === 'read' ? t('modeLabelRead') : m === 'edit' ? t('modeLabelEdit') : t('modeLabelSource')
}

function nextViewMode(m: ViewMode): ViewMode {
  return VIEW_MODES[(VIEW_MODES.indexOf(m) + 1) % VIEW_MODES.length]!
}

interface EditorChromeDeps {
  getSession(): Readonly<DocumentSession>
  isLarge(): boolean
  getLargeInfo(): { bytes: number; totalLines: number }
  defocus(): void
  render(): Promise<void>
}

export function createEditorChrome({ getSession, isLarge, getLargeInfo, defocus, render }: EditorChromeDeps) {
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

  const keyboardBtn = document.getElementById('keyboard-btn') as HTMLButtonElement
  const exportBtn = document.getElementById('export-btn') as HTMLButtonElement
  const titlebarEl = document.getElementById('titlebar')

  /** 把文件名写进顶栏：主名 + 弱化的扩展名。 */
  function setTitleName(name: string): void {
    const dot = name.lastIndexOf('.')
    const hasExt = dot > 0 && dot < name.length - 1
    const base = hasExt ? name.slice(0, dot) : name
    const ext = hasExt ? name.slice(dot) : ''
    fileNameEl.replaceChildren()
    fileNameEl.append(document.createTextNode(base))
    if (ext) {
      const span = document.createElement('span')
      span.className = 'titlebar-ext'
      span.textContent = ext
      fileNameEl.append(span)
    }
  }

  let viewMode: ViewMode = 'read'

  /**
   * 分段控件：三档常驻，当前档常亮。
   *
   * 只有图标 + tip：三档的图标（眼睛 / 铅笔 / 代码）已经足够自明，
   * 常驻文字会把顶栏变成一排字、还和右侧其它图标按钮争宽度。悬停出 tip、
   * aria-label 供读屏——文字没有消失，只是移到需要时才出现的层。
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
      btn.dataset.tip = viewLabel(m)
      btn.setAttribute('aria-label', viewLabel(m))
      const icon = document.createElement('span')
      icon.className = 'mode-opt-icon'
      icon.innerHTML = iconSvg(VIEW_ICON[m], 15)
      btn.append(icon)
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
    const canSave = getSession().dirty
    saveBtn.disabled = !canSave
    // 提示语只描述"这个按钮做什么"：快捷键不属于它的语义（用户要查键位时去键盘面板，
    // 而不是把鼠标停在每个按钮上逐个收集）。
    saveBtn.dataset.tip = canSave ? t('saveAria') : t('saveNothing')
  }

  function setViewMode(next: ViewMode): void {
    // 大文件只有纯文本可编：没有块可渲染，切档只会切出空画面，直接锁在源码档。
    if (isLarge() && next !== 'source') return
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



  /**
   * 状态行：文档的一行自述。
   *
   * 数字取自「当前会把什么写回磁盘」——脏块用编辑器里的文本、净块用磁盘原文，
   * 所以它和保存后的结果是同一个数，不会出现「状态行说 100 字、保存后变 98」。
   */
  function renderStatus() {
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
    if (isLarge()) {
      // 大文件不逐键统计字数——那是对几十 MB 全文的扫描，每次按键都做会卡。
      // 只报体积、行数与存盘状态，这是刻意的降级。
      const { bytes, totalLines } = getLargeInfo()
      statusLeft.replaceChildren()
      statusRight.replaceChildren()
      statusRight.append(
        item(
          t('statLargeFile', {
            lines: formatCount(totalLines),
            size: (bytes / 1048576).toFixed(1),
          }),
        ),
      )
      statusRight.append(item(getSession().dirty ? t('statUnsaved') : t('statSavedAt'), getSession().dirty))
      return
    }
    const blocks = getSession().blocks
    if (blocks.length === 0) {
      statusLeft.replaceChildren()
      statusRight.replaceChildren()
      return
    }
    const text = blocks.map((b) => b.raw).join('')
    const stats = countText(text)
    const sections = blocks.filter((b) => b.kind === 'heading').length
    const minutes = readingMinutes(stats)

    statusRight.replaceChildren()
    if (stats.words === 0) {
      statusRight.append(item(t('statEmpty')))
    } else {
      statusRight.append(item(t('statWords', { n: formatCount(stats.words) })))
      if (sections > 0) statusRight.append(item(t('statSections', { n: sections })))
      if (minutes > 0) statusRight.append(item(t('statReading', { n: minutes })))
    }

    // 状态行只写「这份文档现在什么状态」，并且整行贴在窗口右下角。
    //
    // 三条取舍：
    // 1. 不再重复文件名——顶栏就写着它，状态行再说一遍是同一信息出现两次；
    // 2. 不再与正文列左右对齐：状态行是**窗口**的元信息，不是文档的一部分，
    //    跟着正文列走会让同一屏出现三条互相较劲的竖线；
    // 3. 阅读档不写档位标签：阅读是默认态，给默认态挂标签等于常驻一个「你在阅读」的噪音。

    if (viewMode !== 'read') statusRight.append(item(viewLabel(viewMode), true))
    statusRight.append(item(getSession().dirty ? t('statUnsaved') : t('statSavedAt'), getSession().dirty))
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

  function setDocumentTitle(path: string): void {
    // 文件名拆两段：主名用正文色，扩展名弱化。
    // 阅读器里每份文档都叫 .md，把这个后缀用同样重量写出来，等于在最重要的位置上
    // 放了一段零信息量的字符——它该在，但不该抢眼（同 VS Code / 各编辑器的做法）。
    setTitleName(baseName(path))
    fileNameEl.dataset.untitled = 'false'
    document.title = `${baseName(path)} — Lector`
  }

  function forceSourceMode(): void {
    if (viewMode !== 'source') {
      viewMode = 'source'
      applyModeUI()
    }
  }

  function init(): void {
    openBtn.innerHTML = iconSvg('fileText', 16)
    openBtn.setAttribute('aria-label', t('openAria'))
    openBtn.dataset.tip = t('openAria')
    saveBtn.innerHTML = iconSvg('save', 16)
    saveBtn.setAttribute('aria-label', t('saveAria'))
    saveBtn.dataset.tip = t('saveAria')
    // 保存按钮的禁用态由 refreshSaveButton() 按 dirty 维护（见下）。
    saveBtn.disabled = true
    outlineBtn.innerHTML = iconSvg('outline', 16)
    outlineBtn.setAttribute('aria-label', t('outlineAria'))
    outlineBtn.dataset.tip = t('outlineAria')
    findBtn.innerHTML = iconSvg('search', 16)
    findBtn.setAttribute('aria-label', t('findAria'))
    findBtn.dataset.tip = t('findAria')
  // 「外观」按钮：调色盘——明暗 + 阅读主题都在这里面。之前用「T」（type 图标）
  // 会被误读成文字排版配置；月亮/太阳又只覆盖明暗一半。调色盘是「外观」的通用语言。
  appearanceBtn.innerHTML = iconSvg('palette', 16)
    appearanceBtn.setAttribute('aria-label', t('themeAria'))
    appearanceBtn.dataset.tip = t('themeAria')
    settingsBtn.innerHTML = iconSvg('settings', 16)
    settingsBtn.setAttribute('aria-label', t('settingsAria'))
    settingsBtn.dataset.tip = t('settingsAria')
    openBtn.dataset.tip = t('openAria')
    // 导出 PDF：先退出编辑态（聚焦块显示的是 CM 源码，直接印会把源码印进去），
    // 再走壳层 PrintToPdf；浏览器预览退化为系统打印（打印 CSS 两边共用）。
    exportBtn.innerHTML = iconSvg('fileDown', 16)
    exportBtn.setAttribute('aria-label', t('exportPdfTip'))
    exportBtn.dataset.tip = t('exportPdfTip')
    exportBtn.addEventListener('click', () => {
      defocus()
      const name = (fileNameEl.textContent || 'document').replace(/\.md$/i, '')
      void exportPdf(`${name}.pdf`)
        .then((r) => {
          if (r === 'saved') showToast(t('pdfSaved'))
        })
        .catch((err) => showToast(`${t('pdfFailed')}：${String(err)}`))
    })
    // 键盘面板入口：提示语只说"这是什么"，键位清单在面板里（见 shortcutsPanel.ts）。
    keyboardBtn.innerHTML = iconSvg('keyboard', 16)
    keyboardBtn.setAttribute('aria-label', t('shortcutTitle'))
    // 键盘按钮不带 tooltip：悬停 250ms 就会展开快捷键悬浮卡，
    // 再叠一个「键盘快捷键」气泡只会正好盖住卡片标题
    bindShortcutsButton(keyboardBtn)
    dirtyDot.dataset.tip = t('dirtyTitle')
    // 无标题栏：整条顶栏是拖拽区。绑定与双击语义都在 bindTitlebar / chrome.ts，
    // 这里只负责把元素交出去（旧版是一个 .titlebar-drag 覆盖层，已并入顶栏本身）。
    if (titlebarEl) bindTitlebar(titlebarEl)
    buildModeSwitch()
    // 初始状态：默认只读。applyModeUI 设好 data-mode / 分段选中态 / 保存按钮。
    applyModeUI()
  }

  return {
    elements: { contentEl, fileNameEl, openBtn, saveBtn, appearanceBtn, settingsBtn, outlineBtn, findBtn },
    init,
    getViewMode: () => viewMode,
    setViewMode,
    toggleMode,
    forceSourceMode,
    refreshSaveButton,
    renderStatus,
    setDocumentTitle,
    setDocPresent,
  }
}

export type EditorChrome = ReturnType<typeof createEditorChrome>
