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
import type { EditorSettings } from '@lector/core'
import { iconSvg } from './icons.ts'
import { Segmented, Slider, Switch } from './ui.ts'
import { mountAppearance } from './themeGallery.ts'
import { t } from './i18n.ts'
import { splitUploadCommand } from './imageInsert.ts'
import { testImageCommand, runImageCommand, appVersion } from '@lector/shell-web'

let root: HTMLElement | null = null

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
    for (const [key, el] of panesBySection) el.hidden = key !== id
    for (const [key, btn] of navButtons) btn.classList.toggle('active', key === id)
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
  // 策略 + 资源目录模板 + 上传命令。三档单选决定落盘位置与是否调用图床命令。
  const images = makeSection('images', t('images'))
  const imageMode = Segmented(
    getSettings().imageMode,
    [
      { v: 'images', label: t('imageModeImages') },
      { v: 'assets', label: t('imageModeAssets') },
      { v: 'command', label: t('imageModeCommand') },
    ],
    (v) => apply((s) => ({ ...s, imageMode: v as EditorSettings['imageMode'] })),
  )
  images.appendChild(
    row(
      t('imageModeTitle'),
      imageMode.root,
      getSettings().imageMode === 'images'
        ? t('imageModeImagesHint')
        : getSettings().imageMode === 'assets'
          ? t('imageModeAssetsHint')
          : t('imageModeCommandHint'),
    ),
  )

  const dirInput = h('input', 'settings-input') as HTMLInputElement
  dirInput.type = 'text'
  dirInput.spellcheck = false
  dirInput.value = getSettings().imageAssetsDir
  dirInput.placeholder = '{filename}.assets'
  dirInput.addEventListener('input', () => apply((s) => ({ ...s, imageAssetsDir: dirInput.value })))
  images.appendChild(row(t('imageAssetsDir'), dirInput, t('imageAssetsDirHint')))

  const cmdInput = h('input', 'settings-input') as HTMLInputElement
  cmdInput.type = 'text'
  cmdInput.spellcheck = false
  cmdInput.value = getSettings().imageCommand
  cmdInput.placeholder = 'picgo upload'
  cmdInput.addEventListener('input', () => apply((s) => ({ ...s, imageCommand: cmdInput.value })))
  images.appendChild(row(t('imageCommand'), cmdInput, t('imageCommandHint')))

  const argsInput = h('input', 'settings-input') as HTMLInputElement
  argsInput.type = 'text'
  argsInput.spellcheck = false
  argsInput.value = getSettings().imageCommandArgs.join(' ')
  argsInput.placeholder = '-d -v'
  argsInput.addEventListener('input', () =>
    apply((s) => ({ ...s, imageCommandArgs: argsInput.value.split(/\s+/).filter(Boolean) })),
  )
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

  // 测试命令按钮：用未保存草稿跑一次上传，看 stdout 是否有 URL。
  const testBtn = h('button', 'btn') as HTMLButtonElement
  testBtn.type = 'button'
  testBtn.textContent = t('imageTestCommand')
  const testResult = h('div', 'settings-row-hint') as HTMLDivElement
  testResult.textContent = ''
  testBtn.addEventListener('click', () => {
    void (async () => {
      testBtn.disabled = true
      try {
        const draft = getSettings()
        const { command, preArgs } = splitUploadCommand(draft.imageCommand)
        const res = await testImageCommand(command, [...preArgs, ...draft.imageCommandArgs], draft.imageCommandTimeoutMs)
        if (res.ok && res.url) testResult.textContent = t('imageTestOk').replace('{url}', res.url)
        else testResult.textContent = t('imageTestFailed') + (res.error ?? '')
      } finally {
        testBtn.disabled = false
      }
    })()
  })
  const testHost = h('div', 'settings-row-stack')
  testHost.appendChild(testBtn)
  testHost.appendChild(testResult)
  images.appendChild(testHost)

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
   * 搜索：按行过滤，跨分区一起给。
   * 不重建 DOM、不切分区——只翻 hidden 和「有可见行吗」两个开关，
   * 所以拖到一半的滑块不会被搜索打断。
   */
  function applyFilter(): void {
    const q = search.value.trim().toLowerCase()
    if (!q) {
      showSection(lastSection)
      return
    }
    let visibleTotal = 0
    for (const [id, el] of panesBySection) {
      let visibleInSection = 0
      for (const r of el.querySelectorAll<HTMLElement>('.settings-row')) {
        const hit = (r.textContent ?? '').toLowerCase().includes(q)
        r.hidden = !hit
        if (hit) visibleInSection++
      }
      // 标题行也跟着藏：搜索时每个分区只留命中的行，标题反而更清爽
      el.querySelector<HTMLElement>('.settings-group-title')!.hidden = visibleInSection === 0
      el.hidden = visibleInSection === 0
      visibleTotal += visibleInSection
      navButtons.get(id)?.classList.toggle('active', false)
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
    font.set(s.fontFamily)
    fontSlider.set(s.fontSize)
    lhSlider.set(s.lineHeight)
    wSlider.set(s.readingWidth)
    zoomSlider.set(s.uiZoom)
    if (document.activeElement !== cssBox) cssBox.value = s.customCss ?? ''
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
