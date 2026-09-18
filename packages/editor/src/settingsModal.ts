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
import { appDisplayName, isPlausibleAppPath, pushRecentApp } from '@lector/core'
import type { EditorSettings } from '@lector/core'
import { iconSvg } from './icons.ts'
import { Segmented, Slider, Switch } from './ui.ts'
import { mountAppearance } from './themeGallery.ts'
import { t } from './i18n.ts'
import { splitUploadCommand } from './imageInsert.ts'
import { parseMermaidConfig } from './mermaid.ts'
import {
  testImageCommand,
  runImageCommand,
  appVersion,
  pickAppPath,
  appInfo,
  type ExternalAppInfo,
} from '@lector/shell-web'

let root: HTMLElement | null = null

// 应用图标/显示名查询走壳 IPC，按路径缓存到模块级：面板每次打开都重建 DOM，
// 不缓存的话列表每次都要从占位图标闪一次。
const appInfoCache = new Map<string, Promise<ExternalAppInfo | null>>()
function appInfoFor(path: string): Promise<ExternalAppInfo | null> {
  let p = appInfoCache.get(path)
  if (!p) {
    p = appInfo(path)
    appInfoCache.set(path, p)
  }
  return p
}

/** number[]（IPC 序列化的 PNG 字节）→ data URL，直接喂 <img>。 */
function pngDataUrl(bytes: number[]): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.slice(i, i + 0x8000))
  }
  return `data:image/png;base64,${btoa(bin)}`
}

/** 打开时定位到哪一节（面板是每次重建的，用模块变量记住用户上次看的那节）。 */
let lastSection = 'appearance'

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
 * 标记「这行只在某些图片档位下才有意义」。
 * 显隐由 applyFilter 统一裁决——搜索和档位过滤走同一个出口，不会互相覆盖。
 */
function markRowForModes(r: HTMLElement, modes: string): HTMLElement {
  r.dataset.showModes = modes
  return r
}

export function closeSettingsModal() {
  root?.remove()
  root = null
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

  const closeBtn = h('button', 'btn-icon')
  closeBtn.innerHTML = iconSvg('close')
  closeBtn.setAttribute('aria-label', t('close'))
  closeBtn.addEventListener('click', close)
  header.append(title, search, closeBtn)
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

  // ── 外观 ──
  const appearance = makeSection('appearance', t('appearance'))
  const galleryHost = h('div', 'settings-gallery')
  // 画廊自带明暗分段 + 六张主题卡。设置一变就重画「选中态 / 已微调标记」——
  // 不订阅的话，用户在弹窗里换主题，卡片上的高亮还停在旧的那张。
  const renderGallery = mountAppearance(galleryHost, {
    settings: getSettings,
    onThemeMode: setThemeMode,
    onReadingTheme: setReadingTheme,
  })
  appearance.appendChild(galleryHost)

  // 界面缩放：「整块屏幕多大」的旋钮，比正文的字体字号更外一层。
  // 与正文字号是两件事：读得舒服 ≠ 隔着三米能看清，所以两个旋钮都留着。
  const zoomSlider = Slider(
    getSettings().uiZoom,
    70,
    160,
    10,
    (v) => apply((s) => ({ ...s, uiZoom: v })),
    (n) => `${n}%`,
  )
  appearance.appendChild(cellRow(t('uiZoom'), zoomSlider))

  // ── 阅读 ──
  const reading = makeSection('reading', t('reading'))
  const font = Segmented(
    getSettings().fontFamily,
    [
      { v: 'system', label: t('fontSystem') },
      { v: 'serif', label: t('fontSerif') },
    ],
    (v) => apply((s) => ({ ...s, fontFamily: v })),
  )
  reading.appendChild(row(t('readingFont'), font.root))

  const fontSlider = Slider(
    getSettings().fontSize,
    11,
    32,
    1,
    (v) => apply((s) => ({ ...s, fontSize: v })),
    (n) => `${n}px`,
  )
  reading.appendChild(cellRow(t('fontSize'), fontSlider))

  const lhSlider = Slider(
    getSettings().lineHeight,
    1.2,
    2.6,
    0.05,
    (v) => apply((s) => ({ ...s, lineHeight: v })),
    (n) => n.toFixed(2),
  )
  reading.appendChild(cellRow(t('lineHeight'), lhSlider))

  const wSlider = Slider(
    getSettings().readingWidth,
    480,
    1600,
    16,
    (v) => apply((s) => ({ ...s, readingWidth: v })),
    (n) => `${n}px`,
  )
  reading.appendChild(cellRow(t('readingWidth'), wSlider))

  // ── 编辑 ──
  const editing = makeSection('editing', t('editing'))
  editing.appendChild(
    row(
      t('autoPairs'),
      Switch(getSettings().autoCharacterPairs, (v) => apply((s) => ({ ...s, autoCharacterPairs: v }))),
    ),
  )
  editing.appendChild(
  row(
  t('showWhitespace'),
  Switch(getSettings().showWhitespace, (v) => apply((s) => ({ ...s, showWhitespace: v }))),
  ),
  )
  editing.appendChild(
  row(
  t('codeLineNumbers'),
  Switch(getSettings().codeLineNumbers, (v) => apply((s) => ({ ...s, codeLineNumbers: v }))),
  ),
  )
  editing.appendChild(
    row(
      t('confirmClose'),
      Switch(
        getSettings().closeAlwaysConfirmsChanges,
        (v) => apply((s) => ({ ...s, closeAlwaysConfirmsChanges: v })),
      ),
    ),
  )
  editing.appendChild(
    row(
      t('recoverUnsaved'),
      Switch(getSettings().recoverUnsaved, (v) => apply((s) => ({ ...s, recoverUnsaved: v }))),
      t('recoverUnsavedHint'),
    ),
  )

  // ── 图片 ──
  // 三档单选决定图片落哪、要不要跑上传命令。只有选中的那一档相关的行才显示：
  // images/ 没有可配项；同名资源目录只多一个目录模板；自定义上传才展开命令、
  // 参数、超时与测试。全都常驻会让「哪些项现在真的生效」无从判断。
  const images = makeSection('images', t('images'))
  const imageMode = Segmented(
    getSettings().imageMode,
    [
      { v: 'images', label: t('imageModeImages') },
      { v: 'assets', label: t('imageModeAssets') },
      { v: 'command', label: t('imageModeCommand') },
    ],
    (v) => {
      apply((s) => ({ ...s, imageMode: v as EditorSettings['imageMode'] }))
      // 换档要同时换掉说明文字、并按新档重算各行的显隐
      syncImageMode()
    },
  )
  const imageModeRow = row(t('imageModeTitle'), imageMode.root, imageModeHint(getSettings().imageMode))
  const imageModeHintEl = imageModeRow.querySelector<HTMLElement>('.row-hint')!
  images.appendChild(imageModeRow)

  const dirInput = h('input', 'settings-input') as HTMLInputElement
  dirInput.type = 'text'
  dirInput.spellcheck = false
  dirInput.value = getSettings().imageAssetsDir
  dirInput.placeholder = '{filename}.assets'
  dirInput.addEventListener('input', () => apply((s) => ({ ...s, imageAssetsDir: dirInput.value })))
  const dirRow = row(t('imageAssetsDir'), dirInput, t('imageAssetsDirHint'))
  // 命令档也要它：上传失败时本地副本就落在这个目录里
  dirRow.dataset.showModes = 'assets command'
  const dirHintEl = dirRow.querySelector<HTMLElement>('.row-hint')!
  images.appendChild(dirRow)

  const cmdInput = h('input', 'settings-input') as HTMLInputElement
  cmdInput.type = 'text'
  cmdInput.spellcheck = false
  cmdInput.value = getSettings().imageCommand
  cmdInput.placeholder = 'picgo upload'
  cmdInput.addEventListener('input', () => apply((s) => ({ ...s, imageCommand: cmdInput.value })))
  images.appendChild(markRowForModes(row(t('imageCommand'), cmdInput, t('imageCommandHint')), 'command'))

  const argsInput = h('input', 'settings-input') as HTMLInputElement
  argsInput.type = 'text'
  argsInput.spellcheck = false
  argsInput.value = getSettings().imageCommandArgs.join(' ')
  argsInput.placeholder = '-d -v'
  argsInput.addEventListener('input', () =>
    apply((s) => ({ ...s, imageCommandArgs: argsInput.value.split(/\s+/).filter(Boolean) })),
  )
  images.appendChild(markRowForModes(row(t('imageCommandArgs'), argsInput), 'command'))

  const timeoutSlider = Slider(
    Math.round(getSettings().imageCommandTimeoutMs / 1000),
    1,
    300,
    1,
    (v) => apply((s) => ({ ...s, imageCommandTimeoutMs: v * 1000 })),
    (n) => `${n}s`,
  )
  images.appendChild(markRowForModes(cellRow(t('imageCommandTimeoutSec'), timeoutSlider), 'command'))

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
        testBtn.disabled = false
      }
    })()
  })
  const testHost = markRowForModes(h('div', 'settings-row settings-row-stack settings-test-row'), 'command')
  testHost.appendChild(testBtn)
  testHost.appendChild(testResult)
  images.appendChild(testHost)

  /** 当前档位的说明。 */
  function imageModeHint(mode: EditorSettings['imageMode']): string {
    if (mode === 'images') return t('imageModeImagesHint')
    if (mode === 'assets') return t('imageModeAssetsHint')
    return t('imageModeCommandHint')
  }

  /** 换档后同步说明与各行显隐。 */
  function syncImageMode(): void {
    const mode = getSettings().imageMode
    imageModeHintEl.textContent = imageModeHint(mode)
    // 目录模板在两档里的含义不同：assets 是正文图所在目录，command 是兜底副本目录
    dirHintEl.textContent = mode === 'command' ? t('imageAssetsDirHintCommand') : t('imageAssetsDirHint')
    applyFilter()
  }

  // ── 外部应用 ──
  // 「用其他应用打开」的配置。曾经放在「图片」区跟着上传命令——那只是实现上的邻居
  // （都是"把文件交给外部程序"），对用户来说是另一件事：它属于打开方式，不属于图片。
  //
  // 形态是**可点选的应用列表**（图标 + 显示名 + 路径），而不是裸路径输入框：
  // 路径是给人认的，应用是给人点的。列表 = 最近用过 ∪ 当前选中；
  // 首项永远是「系统默认」（externalApp 为空）。
  const externalApps = makeSection('externalApps', t('externalApps'))
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
    name.textContent = path ? appDisplayName(path) : t('externalAppSystemDefault')
    text.appendChild(name)
    if (path) {
      const pathEl = h('span', 'app-item-path')
      pathEl.textContent = path
      text.appendChild(pathEl)
    }
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
  externalApps.appendChild(listRow)

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
  externalApps.appendChild(row(t('externalAppAdd'), addRow, t('externalAppAddHint')))

  // 附加参数：与图片命令同一约定（参数数组，文件路径由壳追加在最后）。
  const appArgsInput = h('input', 'settings-input') as HTMLInputElement
  appArgsInput.type = 'text'
  appArgsInput.spellcheck = false
  appArgsInput.value = getSettings().externalAppArgs.join(' ')
  appArgsInput.addEventListener('input', () =>
    apply((s) => ({ ...s, externalAppArgs: appArgsInput.value.split(/\s+/).filter(Boolean) })),
  )
  externalApps.appendChild(row(t('externalAppArgs'), appArgsInput))

  renderApps()

  // ── 高级 ──
  const advanced = makeSection('advanced', t('advanced'))
  const cssBox = h('textarea', 'settings-textarea') as HTMLTextAreaElement
  cssBox.value = getSettings().customCss ?? ''
  cssBox.placeholder = t('customCssPlaceholder')
  cssBox.spellcheck = false
  cssBox.rows = 6
  // 输入即生效（下面 notify 里同步），失焦再落盘由 setSettings 自己负责
  cssBox.addEventListener('input', () => apply((s) => ({ ...s, customCss: cssBox.value })))
  const cssRow = row(t('customCss'), cssBox, t('customCssHint'))
  cssRow.classList.add('settings-row-stack')
  advanced.appendChild(cssRow)

  // mermaid 的额外配置。整份合并进 mermaid.initialize()：theme、themeVariables、
  // themeCSS，以及各图种的选项（flowchart.curve / sequence.showSequenceNumbers /
  // gantt.leftPadding…）。做成一段 JSON 而不是一排控件，是因为它的配置面又宽又长，
  // 做成 UI 必然残缺；而 mermaid 自己文档写的就是这个对象，可以直接粘过来。
  const mermaidBox = h('textarea', 'settings-textarea') as HTMLTextAreaElement
  mermaidBox.value = getSettings().mermaidConfig ?? ''
  mermaidBox.placeholder = t('mermaidConfigPlaceholder')
  mermaidBox.spellcheck = false
  mermaidBox.rows = 6
  const mermaidHint = h('div', 'row-hint')
  const mermaidRow = row(t('mermaidConfig'), mermaidBox)
  mermaidRow.classList.add('settings-row-stack')
  mermaidRow.querySelector('.row-text')?.appendChild(mermaidHint)
  const syncMermaidHint = () => {
    // 解析失败时**不**报错到控制台就完事：用户要在这里看到哪一行不对。
    // 图不会跟着坏——坏的 JSON 期间沿用上一份能用的配置（见 mermaid.ts 的 effectiveUserConfig）。
    const { error } = parseMermaidConfig(mermaidBox.value)
    mermaidHint.textContent = error ? t('mermaidConfigInvalid', { error }) : t('mermaidConfigHint')
    mermaidHint.dataset.invalid = error ? 'true' : 'false'
  }
  mermaidBox.addEventListener('input', () => {
    syncMermaidHint()
    apply((s) => ({ ...s, mermaidConfig: mermaidBox.value }))
  })
  syncMermaidHint()
  advanced.appendChild(mermaidRow)

  // ── 关于 ──
  // 版本号是「我现在跑的是哪一版」的唯一自问自答处——报问题、对更新都要它。
  // 这节没有可调的项，所以不做成左对齐的设置行，而是一张居中的名片：
  // logo / 名字 / 一句话 / 版本号，竖直居中撑满整节，避免矮矮一行吊在左上角。
  const about = makeSection('about', t('about'))
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
   * 行的显隐只有一个出口：搜索与图片档位过滤都走这里，谁也不会盖掉谁。
   *
   * 空搜索 = 常规浏览：只看上次的分区，行按当前档位过滤（rowAllowed）。
   * 有搜索 = 跨分区找：不问分区、不看档位，文案命中的行一律翻出来——
   * 用户既然点名搜了，就不该因为「你现在是 images 档」而找不到上传命令。
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
        const hit = browsing ? rowAllowed(r) : (r.textContent ?? '').toLowerCase().includes(q)
        r.hidden = !hit
        if (hit) visibleInSection++
      }
      el.hidden = visibleInSection === 0
      // 标题只在搜索时留下：常规浏览时左侧选中项已经写着这一节叫什么，右侧再顶一行
      // 就是同一句话说两遍；而搜索结果跨分区，那些标题正是「这条命中属于哪一节」的答案。
      el.querySelector<HTMLElement>('.settings-group-title')!.hidden = browsing || visibleInSection === 0
      visibleTotal += visibleInSection
    }
    empty.hidden = visibleTotal > 0
  }

  /** 这一行在当前图片档位下是否该出现。没打标记的行恒显示。 */
  function rowAllowed(r: HTMLElement): boolean {
    const modes = r.dataset.showModes
    if (!modes) return true
    return modes.split(' ').includes(getSettings().imageMode)
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
    font.set(s.fontFamily)
    fontSlider.set(s.fontSize)
    lhSlider.set(s.lineHeight)
    wSlider.set(s.readingWidth)
    zoomSlider.set(s.uiZoom)
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
