// 设置面板：左栏分区导航 + 右栏内容 + 顶部搜索。
//
// 为什么从「一张长卡」改成两栏：
//   原来所有设置从上往下排，外观区一进来就是 6 张主题预览卡 + 5 个滑块 + 4 个开关，
//   后面的「编辑」要滚两屏才看得到；再往上加东西（恢复未保存、自定义样式、以后更多）
//   只会越滚越长，而且**没法找**——想改「代码块字号」得先猜它在哪一段。
//   两栏之后每一节永远在自己的位置：加设置项只增加高度，不增加"找的难度"。
//
// 为什么加搜索：设置项过 20 个之后，找比改费时间。
//   搜索按「行」过滤（不是按分区）：命中什么就只留什么，跨分区一起给。
//
// 面板本身不持有状态：值都来自 settings，改都通过 setSettings。
// 唯一的例外是搜索词，它是这个面板的临时视图状态。

import {
  getSettings,
  resetSettings,
  setSettings,
  setReadingTheme,
  setThemeMode,
  notify,
} from './settings.ts'
import { DEFAULT_SETTINGS, hasImageCommand, imagePipeline, isPlausibleAppPath, pushRecentApp, typographyHome } from '@lector/core'
import type { EditorSettings } from '@lector/core'
import { iconSvg } from './icons.ts'
import { Segmented, Slider, Switch } from './ui.ts'
import { mountAppearance } from './themeGallery.ts'
import { shortcutGroups } from './shortcutsPanel.ts'
import { t } from './i18n.ts'
import { splitUploadCommand } from './imageInsert.ts'
import { parseMermaidConfig } from './mermaid.ts'
import { appInfoFor, resolvedAppName } from './appInfo.ts'
import {
  testImageCommand,
  runImageCommand,
  appVersion,
  appDirs,
  openWithDefault,
  pickAppPath,
} from '@lector/shell-web'

let root: HTMLElement | null = null

/** 当前面板的完整关闭器（含 notify 退订与 Esc 监听拆除），供「就地重建」用。 */
let activeClose: (() => void) | null = null

/** number[]（IPC 序列化的 PNG 字节）→ data URL，直接喂 <img>。 */
function pngDataUrl(bytes: number[]): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.slice(i, i + 0x8000))
  }
  return `data:image/png;base64,${btoa(bin)}`
}

/** 打开时定位到哪一节（面板是每次重建的，用模块变量记住用户上次看的那节）。 */
let lastSection = 'reading'

function h(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

/** 一行设置：标签在左，控件在右。`settings-row` 是搜索过滤的最小单位。 */
function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const r = h('div', 'settings-row')
  const lab = h('div', 'row-text')
  const span = h('span', 'row-label')
  span.textContent = label
  lab.appendChild(span)
  if (hint) {
    const hintEl = h('span', 'row-hint')
    hintEl.textContent = hint
    lab.appendChild(hintEl)
    // 有说明的行：右侧控件对齐到标签那一行，而不是整行垂直居中——
    // 说明文字会一行/两行地变（如图片插入方式），居中会让控件随行高上下跳。
    r.classList.add('has-hint')
  }
  r.append(lab, control)
  return r
}

/** 带数值读数的一行（滑块 + 右侧数字）。
 *  必须用 cellRow：滑块的读数是与 root 平级的独立元素（见 ui.ts 的 Slider），
 *  用 row() 只挂 root，数字就永远不显示——用户看不出线停在哪一档。 */
function cellRow(label: string, slider: { root: HTMLElement; readout: HTMLElement }): HTMLElement {
  const r = h('div', 'settings-row cell')
  const span = h('span', 'row-label')
  span.textContent = label
  r.append(span, slider.root, slider.readout)
  return r
}

/** 一节的标题（分区内容的第一行）。 */
function sectionTitle(label: string): HTMLElement {
  const el = h('h3', 'settings-group-title')
  el.textContent = label
  return el
}

/**
 * 分区内的小标题（比分区标题低一级）。
 *
 * 图片设置分「本地副本 / 图床」两组，靠它把两根轴摆在纸面上——
 * 组内是各自的配置，谁也不管谁。与「键盘快捷键」那几组同一形态：
 * 常规浏览时显示，搜索时收起（那时靠分区标题说明命中属于哪一节）。
 */
function groupLabel(label: string): HTMLElement {
  const el = h('div', 'settings-row-label')
  el.textContent = label
  return el
}

export function closeSettingsModal() {
  root?.remove()
  root = null
}

/**
 * 就地重建设置面板：界面语言切换后面板里的每一行都是旧语言烘的，
 * 逐行重标不如整个重建（lastSection 记着分区，重开落回原处）。
 * 必须走面板自己的 close()——它退订 notify、拆 Esc 监听；
 * 只摘 DOM 会留下两套幽灵监听。
 */
export function reopenSettingsModal(): void {
  if (!root) return
  activeClose?.()
  openSettingsModal()
}

export function openSettingsModal(onClose?: () => void) {
  if (root) return
  const apply = (fn: (s: EditorSettings) => EditorSettings) => setSettings(fn(getSettings()))

  const backdrop = h('div', 'modal-backdrop')
  const card = h('div', 'modal-card settings-card')

  // ── 头部：标题 + 搜索 + 关闭 ──
  const header = h('div', 'modal-header settings-header')
  const title = h('h2', 'modal-title')
  title.textContent = t('settingsTitle')

  const search = h('input', 'settings-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = t('settingsSearch')
  search.setAttribute('aria-label', t('settingsSearch'))
  // 放大镜挂在胶囊输入框里（装饰，不抢焦点）
  const searchWrap = h('div', 'settings-search-wrap')
  const searchIcon = h('span', 'settings-search-icon')
  searchIcon.innerHTML = iconSvg('search', 14)
  searchWrap.append(searchIcon, search)

  const closeBtn = h('button', 'btn-icon')
  closeBtn.innerHTML = iconSvg('close')
  closeBtn.setAttribute('aria-label', t('close'))
  closeBtn.addEventListener('click', close)
  header.append(title, searchWrap, closeBtn)
  card.appendChild(header)

  const panes = h('div', 'settings-panes')
  const nav = h('nav', 'settings-nav')
  const content = h('div', 'settings-content')
  panes.append(nav, content)
  card.appendChild(panes)

  // ── 各分区内容 ──
  // 建一次、常驻在 DOM 里，切换分区只改 hidden：重建会让滑块拖拽中断
  // （指针捕获跑在被删掉的 DOM 上），也会让滚动位置丢失。
  const panesBySection = new Map<string, HTMLElement>()
  const navButtons = new Map<string, HTMLButtonElement>()

  const makeSection = (id: string, label: string): HTMLElement => {
    const el = h('section', 'settings-group')
    el.dataset.section = id
    el.appendChild(sectionTitle(label))
    content.appendChild(el)
    panesBySection.set(id, el)

    const btn = h('button', 'settings-nav-item') as HTMLButtonElement
    btn.type = 'button'
    btn.dataset.section = id
    btn.textContent = label
    btn.addEventListener('click', () => showSection(id))
    nav.appendChild(btn)
    navButtons.set(id, btn)
    return el
  }

  function showSection(id: string): void {
    lastSection = id
    search.value = ''
    applyFilter()
    content.scrollTop = 0
  }

  const reading = makeSection('reading', t('reading'))
  const appearance = makeSection('appearance', t('appearance'))
  const editing = makeSection('editing', t('editing'))
  const markdown = makeSection('markdown', t('markdown'))
  const images = makeSection('images', t('images'))
  const files = makeSection('files', t('files'))
  const shortcuts = makeSection('shortcuts', t('shortcutTitle'))
  const maintenance = makeSection('maintenance', t('maintenance'))
  const about = makeSection('about', t('about'))
  navButtons.get('shortcuts')?.classList.add('settings-nav-reference')

  // ── 外观 ──
  // 应用明暗、界面缩放与全局样式预设留在外观；阅读只负责正文排版微调。
  // 画廊自己的「主题/阅读主题」小标签是给顶栏浮层用的，在设置面板里要拆掉
  // （variant: 'settings'），由分区和组标题建立层级。
  appearance.appendChild(groupLabel(t('settingsGroupInterface')))
  const themeSeg = Segmented(
    getSettings().theme,
    [
      { v: 'system', label: t('themeSystem') },
      { v: 'light', label: t('themeLight') },
      { v: 'dark', label: t('themeDark') },
    ],
    (v) => setThemeMode(v),
  )
  appearance.appendChild(row(t('theme'), themeSeg.root))

  // 界面语言。语言名用各自语言书写（中文 / English），不随界面语言翻译——
  // 用户要在「看不懂的语言」里也能认出自己的语言。即时生效由 main.ts 的
  // 设置通知完成；原生菜单只在启动时建，所以提示里说明要重启。
  const languageSeg = Segmented(
    getSettings().language,
    [
      { v: 'system', label: t('languageSystem') },
      { v: 'zh-CN', label: '中文' },
      { v: 'en', label: 'English' },
    ],
    (v) => apply((s) => ({ ...s, language: v })),
  )
  appearance.appendChild(row(t('language'), languageSeg.root, t('languageHint')))

  const galleryHost = h('div', 'settings-gallery')
  // 画廊自带六张主题卡。设置一变就重画「选中态 / 已微调标记」——
  // 不订阅的话，用户在弹窗里换主题，卡片上的高亮还停在旧的那张。
  const renderGallery = mountAppearance(
    galleryHost,
    {
      settings: getSettings,
      onThemeMode: setThemeMode,
      onReadingTheme: setReadingTheme,
    },
    'settings',
  )
  // 画廊作为一条 stack 行：标签可搜索（搜「纸」能翻到这张画廊）。
  const galleryRow = row(t('readingTheme'), galleryHost)
  galleryRow.classList.add('settings-row-stack')

  // 界面缩放：「整块屏幕多大」的旋钮，比正文的字体字号更外一层。
  // 与正文字号是两件事：读得舒服 ≠ 隔着三米能看清，所以两个旋钮都留着。
  const zoomSlider = Slider(
    getSettings().uiZoom,
    70,
    160,
    10,
    (v) => apply((s) => ({ ...s, uiZoom: v })),
    (n) => `${n}%`,
    { home: DEFAULT_SETTINGS.uiZoom, resetTip: t('sliderResetTip') },
  )
  appearance.appendChild(cellRow(t('uiZoom'), zoomSlider))
  appearance.appendChild(groupLabel(t('settingsGroupGlobalStyle')))
  appearance.appendChild(galleryRow)

  // ── 阅读 ──
  reading.appendChild(groupLabel(t('settingsGroupTypography')))
  const font = Segmented(
    getSettings().fontFamily,
    [
      { v: 'system', label: t('fontSystem') },
      { v: 'serif', label: t('fontSerif') },
    ],
    (v) => apply((s) => ({ ...s, fontFamily: v })),
  )
  reading.appendChild(row(t('readingFont'), font.root))

  const typeHome = () => typographyHome(getSettings())
  const fontSlider = Slider(
    getSettings().fontSize,
    11,
    32,
    1,
    (v) => apply((s) => ({ ...s, fontSize: v })),
    (n) => `${n}px`,
    { home: typeHome().fontSize, resetTip: t('sliderResetTip') },
  )
  reading.appendChild(cellRow(t('fontSize'), fontSlider))

  const lhSlider = Slider(
    getSettings().lineHeight,
    1.2,
    2.6,
    0.05,
    (v) => apply((s) => ({ ...s, lineHeight: v })),
    (n) => n.toFixed(2),
    { home: typeHome().lineHeight, resetTip: t('sliderResetTip') },
  )
  reading.appendChild(cellRow(t('lineHeight'), lhSlider))

  const wSlider = Slider(
    getSettings().readingWidth,
    480,
    1600,
    16,
    (v) => apply((s) => ({ ...s, readingWidth: v })),
    (n) => `${n}px`,
    { home: typeHome().readingWidth, resetTip: t('sliderResetTip') },
  )
  reading.appendChild(cellRow(t('readingWidth'), wSlider))

  // ── 编辑 ──
  editing.appendChild(groupLabel(t('settingsGroupInput')))
  editing.appendChild(
    row(
      t('autoPairs'),
      Switch(getSettings().autoCharacterPairs, (v) => apply((s) => ({ ...s, autoCharacterPairs: v }))),
      t('autoPairsHint'),
    ),
  )
  editing.appendChild(
    row(
      t('showWhitespace'),
      Switch(getSettings().showWhitespace, (v) => apply((s) => ({ ...s, showWhitespace: v }))),
    ),
  )

  files.appendChild(groupLabel(t('settingsGroupFileSafety')))
  files.appendChild(
    row(
      t('confirmClose'),
      Switch(
        getSettings().closeAlwaysConfirmsChanges,
        (v) => apply((s) => ({ ...s, closeAlwaysConfirmsChanges: v })),
      ),
    ),
  )
  files.appendChild(
    row(
      t('recoverUnsaved'),
      Switch(getSettings().recoverUnsaved, (v) => apply((s) => ({ ...s, recoverUnsaved: v }))),
      t('recoverUnsavedHint'),
    ),
  )

  // ── 扩展语法 ──
  // 超出 CommonMark / GFM 的语法各给一个开关：它们是「偏好」而不是「基础设施」——
  // 有人拿 $ 当货币、拿 == 当等号，关掉就该原样看见源文。
  // 归入 Markdown（而不是混进「编辑」），也方便以后按 Typora 那样继续加项。
  markdown.appendChild(groupLabel(t('markdownExtensions')))
  markdown.appendChild(
    row(t('inlineMath'), Switch(getSettings().math, (v) => apply((s) => ({ ...s, math: v })))),
  )
  markdown.appendChild(
    row(
      t('markHighlight'),
      Switch(getSettings().markHighlight, (v) => apply((s) => ({ ...s, markHighlight: v }))),
    ),
  )
  markdown.appendChild(
    row(
      t('emojiShortcodes'),
      Switch(getSettings().emojiShortcodes, (v) => apply((s) => ({ ...s, emojiShortcodes: v }))),
    ),
  )
  markdown.appendChild(groupLabel(t('settingsGroupCodeBlocks')))
  markdown.appendChild(
    row(
      t('codeLineNumbers'),
      Switch(getSettings().codeLineNumbers, (v) => apply((s) => ({ ...s, codeLineNumbers: v }))),
    ),
  )

  // ── 图片 ──
  // 两根互不相干的轴：**本地副本**（要不要在文档目录留文件）与**图床**（要不要交给
  // 上传命令）。旧版是一个三档单选，把两件事焊在一起——选了「自定义上传」就没法只
  // 手动传，选了目录就彻底没有上传。现在两组各管各的，组合结果由 core 的
  // imagePipeline() 裁决，面板只负责把「现在哪种组合生效」显示清楚：
  //   · 没有上传命令 → 副本开关锁在开（图片总要有去处），自动上传锁在关；
  //   · 关掉本地副本 → 自动上传被锁在开（正文总得写个地址）。
  // 锁住的开关不是隐藏而是禁用：值还看得见，代价写在旁边的说明里。
  const copySwitch = Switch(
    getSettings().imageCopy,
    (v) => {
      // 关掉副本 = 只能当场上传（管线的规则），把上传时机一并掰过去，
      // 免得设置里存着「不复制 + 手动上传」这种没有出路的组合。
      apply((s) => ({ ...s, imageCopy: v, imageUploadAuto: v ? s.imageUploadAuto : true }))
      syncImage()
    },
  )
  // data-field：给渲染层验证用的稳定锚点（ui-verify 要按字段名找控件，
  // 而不是靠「第几个 input」这种一改就错的位置）
  copySwitch.dataset.field = 'imageCopy'
  const copyRow = row(t('imageCopy'), copySwitch, t('imageCopyHint'))
  const copyHintEl = copyRow.querySelector<HTMLElement>('.row-hint')!
  images.append(groupLabel(t('imageGroupLocal')), copyRow)

  const dirInput = h('input', 'settings-input') as HTMLInputElement
  dirInput.type = 'text'
  dirInput.spellcheck = false
  dirInput.value = getSettings().imageCopyDir
  dirInput.placeholder = 'images'
  dirInput.dataset.field = 'imageCopyDir'
  dirInput.addEventListener('input', () => apply((s) => ({ ...s, imageCopyDir: dirInput.value })))
  const dirRow = row(t('imageCopyDir'), dirInput, t('imageCopyDirHint'))
  const dirHintEl = dirRow.querySelector<HTMLElement>('.row-hint')!
  images.appendChild(dirRow)

  // 图床组：从「命令」开始——命令为空就是没有图床，后面几行都无从谈起。
  const cmdInput = h('input', 'settings-input') as HTMLInputElement
  cmdInput.type = 'text'
  cmdInput.spellcheck = false
  cmdInput.value = getSettings().imageCommand
  cmdInput.placeholder = 'picgo upload'
  cmdInput.addEventListener('input', () => {
    apply((s) => ({ ...s, imageCommand: cmdInput.value }))
    syncImage()
  })
  images.appendChild(groupLabel(t('imageGroupHost')))
  cmdInput.dataset.field = 'imageCommand'
  images.appendChild(row(t('imageCommand'), cmdInput, t('imageCommandHint')))

  const autoSwitch = Switch(getSettings().imageUploadAuto, (v) => {
    apply((s) => ({ ...s, imageUploadAuto: v }))
    syncImage()
  })
  autoSwitch.dataset.field = 'imageUploadAuto'
  const autoRow = row(t('imageUploadAuto'), autoSwitch, t('imageUploadAutoHint'))
  const autoHintEl = autoRow.querySelector<HTMLElement>('.row-hint')!
  images.appendChild(autoRow)
  images.appendChild(groupLabel(t('settingsGroupCommandOptions')))

  const argsInput = h('input', 'settings-input') as HTMLInputElement
  argsInput.type = 'text'
  argsInput.spellcheck = false
  argsInput.value = getSettings().imageCommandArgs.join(' ')
  argsInput.placeholder = '-d -v'
  argsInput.addEventListener('input', () =>
    apply((s) => ({ ...s, imageCommandArgs: argsInput.value.split(/\s+/).filter(Boolean) })),
  )
  argsInput.dataset.field = 'imageCommandArgs'
  images.appendChild(row(t('imageCommandArgs'), argsInput))

  const timeoutSlider = Slider(
    Math.round(getSettings().imageCommandTimeoutMs / 1000),
    1,
    300,
    1,
    (v) => apply((s) => ({ ...s, imageCommandTimeoutMs: v * 1000 })),
    (n) => `${n}s`,
  )
  images.appendChild(cellRow(t('imageCommandTimeoutSec'), timeoutSlider))

  // 测试命令：用未保存草稿跑一次上传，看 stdout 是否有 URL。
  // 次级按钮（有边框、按内容宽）+ 结果提示行；结果失败时用危险色。
  const testBtn = h('button', 'btn btn-ghost') as HTMLButtonElement
  testBtn.type = 'button'
  testBtn.textContent = t('imageTestCommand')
  const testResult = h('div', 'row-hint') as HTMLDivElement
  testResult.textContent = ''
  testBtn.addEventListener('click', () => {
    void (async () => {
      testBtn.disabled = true
      try {
        const draft = getSettings()
        const { command, preArgs } = splitUploadCommand(draft.imageCommand)
        const res = await testImageCommand(command, [...preArgs, ...draft.imageCommandArgs], draft.imageCommandTimeoutMs)
        if (res.ok && res.url) {
          testResult.textContent = t('imageTestOk').replace('{url}', res.url)
          testResult.dataset.invalid = 'false'
        } else {
          testResult.textContent = t('imageTestFailed') + (res.error ?? '')
          testResult.dataset.invalid = 'true'
        }
      } finally {
        testBtn.disabled = !hasImageCommand(getSettings())
      }
    })()
  })
  const testHost = h('div', 'settings-row settings-row-stack settings-test-row')
  testHost.append(testBtn, testResult)
  images.appendChild(testHost)

  /**
   * 把「当前生效的组合」同步到面板上：说明文字 + 各控件的可用性。
   *
   * 唯一的判据是 imagePipeline()——面板不自己重算「有命令没有 / 复制没有」，
   * 否则界面和插图链路迟早会各说一套。设置一变（敲命令、拨开关）都走这里。
   */
  function syncImage(): void {
    const s = getSettings()
    const plan = imagePipeline(s)
    copySwitch.set(plan.copy)
    copySwitch.setDisabled(plan.upload === 'off')
    autoSwitch.set(plan.upload === 'auto')
    autoSwitch.setDisabled(plan.upload === 'off' || !plan.copy)
    // 说明随状态换：锁在开/锁在关时，得说清是「为什么不能改」而不是「这是什么」
    if (plan.upload === 'off') copyHintEl.textContent = t('imageCopyHintLocked')
    else copyHintEl.textContent = plan.copy ? t('imageCopyHint') : t('imageCopyHintOff')
    if (plan.upload === 'off') autoHintEl.textContent = t('imageUploadAutoHintLocked')
    else if (!plan.copy) autoHintEl.textContent = t('imageUploadAutoHintForced')
    else autoHintEl.textContent = t('imageUploadAutoHint')
    // 不复制时这个目录不装正文里的图，而是上传失败的兜底去处——同一格，两种含义
    dirHintEl.textContent = plan.copy ? t('imageCopyDirHint') : t('imageCopyDirHintFallback')
    testBtn.disabled = plan.upload === 'off'
  }
  syncImage()

  // ── 外部应用 ──
  // 「用其他应用打开」的配置。曾经放在「图片」区跟着上传命令——那只是实现上的邻居
  // （都是"把文件交给外部程序"），对用户来说是另一件事：它属于打开方式，不属于图片。
  //
  // 形态是**可点选的应用列表**（图标 + 显示名 + 路径），而不是裸路径输入框：
  // 路径是给人认的，应用是给人点的。列表 = 最近用过 ∪ 当前选中；
  // 首项永远是「系统默认」（externalApp 为空）。
  files.appendChild(groupLabel(t('settingsGroupOpenWith')))
  const appListEl = h('div', 'app-list')

  const selectApp = (path: string | null): void => {
    apply((s) => ({ ...s, externalApp: path ?? '' }))
    renderApps()
  }

  const removeApp = (path: string): void => {
    apply((s) => ({
      ...s,
      externalAppRecent: s.externalAppRecent.filter((a) => a !== path),
      // 移除的正是当前选中项时回退到系统默认，不留一个打不开的选中态
      externalApp: s.externalApp.trim() === path ? '' : s.externalApp,
    }))
    renderApps()
  }

  function appItem(path: string | null): HTMLElement {
    const current = getSettings().externalApp.trim()
    const item = h('div', 'app-item')
    item.tabIndex = 0
    item.setAttribute('role', 'button')
    item.dataset.active = String((path ?? '') === current)

    const iconBox = h('span', 'app-item-icon')
    iconBox.innerHTML = iconSvg(path ? 'appWindow' : 'fileOutput')
    const text = h('span', 'app-item-text')
    const name = h('span', 'app-item-name')
    name.textContent = path ? resolvedAppName(path) : t('externalAppSystemDefault')
    text.appendChild(name)
    // 两行制：应用行是「名称 + 路径」，系统默认行也给一行说明——
    // 行高一致，列表读起来才是清单而不是参差的几行字。
    const sub = h('span', 'app-item-path')
    sub.textContent = path ?? t('externalAppSystemDefaultHint')
    text.appendChild(sub)
    const check = h('span', 'app-item-check')
    check.innerHTML = iconSvg('check', 14)
    item.append(iconBox, text, check)

    if (path) {
      const remove = h('button', 'app-item-remove') as HTMLButtonElement
      remove.type = 'button'
      remove.innerHTML = iconSvg('close', 13)
      remove.setAttribute('aria-label', t('externalAppRemove'))
      remove.title = t('externalAppRemove')
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        removeApp(path)
      })
      item.appendChild(remove)

      // 图标与真名是装饰性的，异步到了再换上；节点可能已被重渲染丢弃，无所谓。
      void appInfoFor(path).then((info) => {
        if (!info) return
        if (info.name) name.textContent = info.name
        if (info.icon_png && info.icon_png.length > 0) {
          const img = document.createElement('img')
          img.src = pngDataUrl(info.icon_png)
          img.alt = ''
          iconBox.replaceChildren(img)
        }
      })
    }

    const onPick = () => selectApp(path)
    item.addEventListener('click', onPick)
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onPick()
      }
    })
    return item
  }

  function renderApps(): void {
    const s = getSettings()
    const current = s.externalApp.trim()
    const paths = [...s.externalAppRecent]
    // 当前选中项可能不在最近列表里（比如手输了光秃秃的命令名）——也得显示出来，
    // 否则界面上看不到"现在到底选中的是谁"。
    if (current && !paths.includes(current)) paths.unshift(current)
    appListEl.replaceChildren()
    appListEl.appendChild(appItem(null))
    for (const p of paths) appListEl.appendChild(appItem(p))
  }

  const listRow = row(t('externalAppList'), appListEl, t('externalAppListHint'))
  listRow.classList.add('settings-row-stack')
  files.appendChild(listRow)

  // 添加：「浏览…」是主路径（手打可执行文件路径在 Windows 上太难：长、带空格、
  // per-user / per-machine 两套位置）；输入框留给粘贴与 PATH 上的命令名。
  // 常用应用列表由**用户自己的选择**长出来，而不是硬编码一份猜的路径表。
  const addInput = h('input', 'settings-input') as HTMLInputElement
  addInput.type = 'text'
  addInput.spellcheck = false
  addInput.placeholder = 'C:\\Program Files\\Typora\\Typora.exe'
  const addBrowseBtn = h('button', 'btn btn-ghost') as HTMLButtonElement
  addBrowseBtn.type = 'button'
  addBrowseBtn.textContent = t('externalAppBrowse')
  const addRow = h('div', 'settings-inline')
  addRow.append(addInput, addBrowseBtn)

  const commitAdd = (): void => {
    const v = addInput.value.trim()
    if (!v) return
    // 半截路径（"C:\Pro"）不收进列表——isPlausibleAppPath 的判据挡住它们；
    // 但允许直接选中，光秃秃的命令名（code）走 PATH 也能打开。
    apply((s) => ({
      ...s,
      externalApp: v,
      externalAppRecent: isPlausibleAppPath(v) ? pushRecentApp(s.externalAppRecent, v) : s.externalAppRecent,
    }))
    addInput.value = ''
    renderApps()
  }
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitAdd()
    }
  })
  addInput.addEventListener('blur', commitAdd)
  addBrowseBtn.addEventListener('click', () => {
    void pickAppPath().then((picked) => {
      if (!picked) return
      apply((s) => ({ ...s, externalApp: picked, externalAppRecent: pushRecentApp(s.externalAppRecent, picked) }))
      renderApps()
    })
  })
  const addAppRow = row(t('externalAppAdd'), addRow, t('externalAppAddHint'))
  // 竖排：标签+说明在上，输入框+「浏览…」在下吃满整行——横排时输入框被
  // 右侧栏挤到只剩半截，placeholder 都显示不全。
  addAppRow.classList.add('settings-row-stack')
  files.appendChild(addAppRow)

  // 附加参数：与图片命令同一约定（参数数组，文件路径由壳追加在最后）。
  const appArgsInput = h('input', 'settings-input') as HTMLInputElement
  appArgsInput.type = 'text'
  appArgsInput.spellcheck = false
  appArgsInput.value = getSettings().externalAppArgs.join(' ')
  appArgsInput.addEventListener('input', () =>
    apply((s) => ({ ...s, externalAppArgs: appArgsInput.value.split(/\s+/).filter(Boolean) })),
  )
  files.appendChild(row(t('externalAppArgs'), appArgsInput))

  renderApps()

  // ── 自定义样式与 Mermaid 配置 ──
  appearance.appendChild(groupLabel(t('advanced')))
  const cssBox = h('textarea', 'settings-textarea') as HTMLTextAreaElement
  cssBox.value = getSettings().customCss ?? ''
  cssBox.placeholder = t('customCssPlaceholder')
  cssBox.spellcheck = false
  cssBox.rows = 6
  // 输入即生效（下面 notify 里同步），失焦再落盘由 setSettings 自己负责
  cssBox.addEventListener('input', () => apply((s) => ({ ...s, customCss: cssBox.value })))
  const cssRow = row(t('customCss'), cssBox, t('customCssHint'))
  cssRow.classList.add('settings-row-stack')
  appearance.appendChild(cssRow)

  // mermaid 的额外配置。整份合并进 mermaid.initialize()：theme、themeVariables、
  // themeCSS，以及各图种的选项（flowchart.curve / sequence.showSequenceNumbers /
  // gantt.leftPadding…）。做成一段 JSON 而不是一排控件，是因为它的配置面又宽又长，
  // 做成 UI 必然残缺；而 mermaid 自己文档写的就是这个对象，可以直接粘过来。
  markdown.appendChild(groupLabel(t('settingsGroupMermaid')))
  const mermaidBox = h('textarea', 'settings-textarea') as HTMLTextAreaElement
  mermaidBox.value = getSettings().mermaidConfig ?? ''
  mermaidBox.placeholder = t('mermaidConfigPlaceholder')
  mermaidBox.spellcheck = false
  mermaidBox.rows = 6
  const mermaidHint = h('div', 'row-hint')
  const mermaidRow = row(t('mermaidConfig'), mermaidBox)
  mermaidRow.classList.add('settings-row-stack', 'settings-mermaid-row')
  mermaidRow.querySelector('.row-text')?.appendChild(mermaidHint)
  const syncMermaidHint = () => {
    // 解析失败时**不**报错到控制台就完事：用户要在这里看到哪一行不对。
    // 图不会跟着坏——坏的 JSON 期间沿用上一份能用的配置（见 mermaid.ts 的 effectiveUserConfig）。
    const { error } = parseMermaidConfig(mermaidBox.value)
    mermaidHint.dataset.invalid = error ? 'true' : 'false'
    if (error) {
      mermaidHint.textContent = t('mermaidConfigInvalid', { error })
      return
    }
    // `%%{init}%%` 包成 nowrap 的 code token：纯文本下 UAX#14 允许在 %% 和 { 之间断行，
    // 它会断成「%%\n{init}%%」；token 化之后既不断行，也更好认。
    const text = t('mermaidConfigHint')
    const token = '%%{init}%%'
    const at = text.indexOf(token)
    if (at < 0) {
      mermaidHint.textContent = text
      return
    }
    const codeEl = h('code', 'hint-token')
    codeEl.textContent = token
    mermaidHint.replaceChildren(text.slice(0, at), codeEl, text.slice(at + token.length))
  }
  mermaidBox.addEventListener('input', () => {
    syncMermaidHint()
    apply((s) => ({ ...s, mermaidConfig: mermaidBox.value }))
  })
  syncMermaidHint()
  markdown.appendChild(mermaidRow)

  // ── 键盘快捷键 ──
  // 键位表没有常驻按钮（⌘/ 或 ? 呼出，见 shortcutsPanel）；这里是「找得到」的那一份：
  // 内联成分组卡片、可被设置搜索命中。数据与浮层同源（都来自 shortcutGroups），
  // 不会有两份会漂移的键位清单。
  const shortcutGrid = h('div', 'settings-shortcut-grid')
  for (const group of shortcutGroups()) {
    const groupCard = h('section', 'settings-shortcut-card')
    const title = h('h3', 'settings-row-label settings-shortcut-title')
    title.textContent = group.title
    groupCard.appendChild(title)
    for (const r of group.rows) {
      const line = h('div', 'settings-row settings-shortcut-row')
      const label = h('span', 'settings-shortcut-label')
      label.textContent = r.label
      const keys = h('kbd', 'shortcut-keys')
      keys.textContent = r.keys
      line.append(label, keys)
      groupCard.appendChild(line)
    }
    shortcutGrid.appendChild(groupCard)
  }
  shortcuts.appendChild(shortcutGrid)

  // ── 维护 ──
  // 「我的数据存在哪」的自问自答处。便携版用户尤其需要看见数据是否在程序旁，
  // 以及随时能打开这两个目录。壳侧解析路径，Web 只拿到这两条并交给
  // open_with_default 打开——不开通用路径能力。
  const openDirRow = (label: string, hint: HTMLElement, open: () => void): HTMLElement => {
    const btn = h('button', 'btn btn-ghost') as HTMLButtonElement
    btn.type = 'button'
    btn.textContent = t('openFolderAction')
    btn.addEventListener('click', open)
    const r = row(label, btn)
    r.classList.add('has-hint')
    r.querySelector('.row-text')?.appendChild(hint)
    return r
  }
  const dataHint = h('span', 'row-hint')
  const logsHint = h('span', 'row-hint')
  let dataPath = ''
  let logsPath = ''
  maintenance.appendChild(openDirRow(t('openDataDir'), dataHint, () => { if (dataPath) void openWithDefault(dataPath) }))
  maintenance.appendChild(openDirRow(t('openLogDir'), logsHint, () => { if (logsPath) void openWithDefault(logsPath) }))
  void appDirs().then((dirs) => {
    if (!dirs) return
    dataPath = dirs.data
    logsPath = dirs.logs
    dataHint.textContent = dirs.data
    logsHint.textContent = dirs.logs
  })

  // ── 关于 ──
  // 版本号是「我现在跑的是哪一版」的唯一自问自答处——报问题、对更新都要它。
  // 这节没有可调的项，所以不做成左对齐的设置行，而是一张居中的名片：
  // logo / 名字 / 一句话 / 版本号，竖直居中撑满整节，避免矮矮一行吊在左上角。
  const pane = h('div', 'about-pane')
  const hero = h('div', 'about-hero')
  const aboutLogo = h('img', 'about-logo') as HTMLImageElement
  aboutLogo.src = '/lector-mark.svg'
  aboutLogo.alt = ''
  const aboutName = h('div', 'about-name')
  const nameEl = h('div', 'about-title')
  nameEl.textContent = 'Lector'
  const taglineEl = h('div', 'about-tagline')
  taglineEl.textContent = t('emptyTagline')
  aboutName.append(nameEl, taglineEl)
  hero.append(aboutLogo, aboutName)
  pane.appendChild(hero)
  const versionValue = h('span', 'row-static')
  versionValue.textContent = '…'
  void appVersion().then((v) => {
    versionValue.textContent = `v${v}`
  })
  // 仍用 row()：它留着 .settings-row 这条搜索锚点，搜「版本」能找到这一节。
  const versionRow = row(t('versionLabel'), versionValue)
  versionRow.classList.add('about-version')
  pane.appendChild(versionRow)
  about.appendChild(pane)

  // ── 底栏 ──
  const footer = h('div', 'modal-footer')
  const reset = h('button', 'btn')
  reset.textContent = t('resetDefaults')
  reset.addEventListener('click', () => {
    // 危险动作：清主题/排版/自定义样式都不可逆
    if (window.confirm(t('resetConfirm'))) resetSettings()
  })
  const done = h('button', 'btn btn-primary')
  done.textContent = t('done')
  done.addEventListener('click', () => close())
  footer.append(reset, done)
  card.appendChild(footer)

  /**
   * 行的显隐只有一个出口：搜索和「看哪个分区」都走这里，谁也不会盖掉谁。
   *
   * 空搜索 = 常规浏览：只看上次的分区。
   * 有搜索 = 跨分区找：不问分区，文案命中的行一律翻出来。
   * （不再有「按图片档位过滤」这一层：档位过滤会让用户搜不到自己看不见的设置，
   *  而图片那两根轴的可用性现在由禁用态表达——值始终在，只是暂时改不了。）
   *
   * 不重建 DOM、只翻 hidden：拖到一半的滑块不会被搜索打断。
   */
  function applyFilter(): void {
    const q = search.value.trim().toLowerCase()
    const browsing = !q
    let visibleTotal = 0
    for (const [id, el] of panesBySection) {
      navButtons.get(id)?.classList.toggle('active', browsing && id === lastSection)
      if (browsing && id !== lastSection) {
        el.hidden = true
        continue
      }
      let visibleInSection = 0
      for (const r of el.querySelectorAll<HTMLElement>('.settings-row')) {
        const hit = browsing || (r.textContent ?? '').toLowerCase().includes(q)
        r.hidden = !hit
        if (hit) visibleInSection++
      }
      for (const card of el.querySelectorAll<HTMLElement>('.settings-shortcut-card')) {
        card.hidden = !browsing && ![...card.querySelectorAll<HTMLElement>('.settings-row')].some((r) => !r.hidden)
      }
      el.hidden = visibleInSection === 0
      // 搜索时收起组内小标题（与分区标题同一取舍）；浏览时按分区显隐。
      for (const sub of el.querySelectorAll<HTMLElement>('.settings-row-label')) sub.hidden = !browsing
      // 常规浏览时左侧选中项已经说明当前分区；搜索跨分区时才显示标题说明命中归属。
      el.querySelector<HTMLElement>('.settings-group-title')!.hidden = browsing || visibleInSection === 0
      visibleTotal += visibleInSection
    }
    empty.hidden = visibleTotal > 0
  }

  const empty = h('div', 'settings-empty')
  empty.textContent = t('settingsNoResult')
  empty.hidden = true
  content.appendChild(empty)

  search.addEventListener('input', applyFilter)

  // ── 状态同步 ──
  // 只 set() 值、不动结构：拖到一半被重建，拖拽就断了。
  let galleryTick = false
  const off = notify((s) => {
    themeSeg.set(s.theme)
    languageSeg.set(s.language)
    font.set(s.fontFamily)
    fontSlider.set(s.fontSize)
    lhSlider.set(s.lineHeight)
    wSlider.set(s.readingWidth)
    zoomSlider.set(s.uiZoom)
    const home = typographyHome(s)
    fontSlider.setHome(home.fontSize)
    lhSlider.setHome(home.lineHeight)
    wSlider.setHome(home.readingWidth)
    zoomSlider.setHome(DEFAULT_SETTINGS.uiZoom)
    // 图片两个开关的可用性由命令字段决定（清空命令会把它们锁回去），
    // 而这条链是「设置变了」的唯一出口——输入框自己改值时也走这里。
    syncImage()
    // 输入框不抢正在打字的那一个：其余（如「恢复默认」把值清回去）要跟着走，
    // 否则界面上留着一份已经不成立的旧文案。
    if (document.activeElement !== dirInput) dirInput.value = s.imageCopyDir
    if (document.activeElement !== cmdInput) cmdInput.value = s.imageCommand
    if (document.activeElement !== argsInput) argsInput.value = s.imageCommandArgs.join(' ')
    if (document.activeElement !== cssBox) cssBox.value = s.customCss ?? ''
    if (document.activeElement !== mermaidBox) {
      mermaidBox.value = s.mermaidConfig ?? ''
      syncMermaidHint()
    }
    // 用 rAF 合并：拖滑块时 notify 每像素都响，画廊只需要每帧对齐一次
    if (!galleryTick) {
      galleryTick = true
      requestAnimationFrame(() => {
        galleryTick = false
        renderGallery()
      })
    }
  })

  function close(): void {
    off()
    document.removeEventListener('keydown', onKey)
    closeSettingsModal()
    onClose?.()
  }
  activeClose = close

  document.addEventListener('keydown', onKey)
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    // ⌘/Ctrl+F 直接进搜索框：设置里"找"比"翻"常用
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      search.focus()
    }
  }

  backdrop.appendChild(card)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  document.body.appendChild(backdrop)
  root = backdrop

  showSection(lastSection)
  // 打开就聚焦搜索框？不。用户多数是"来改某一项"，聚焦搜索会让键盘输入
  // 直接落进搜索框而误过滤；想搜的人按 ⌘F 或直接点。
}
