import { renderMermaidSvg } from './mermaid.ts'
import { showSvgInLightbox } from './lightbox.ts'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { copyText } from './feedback.ts'

/**
 * 代码块折行偏好（notefast 同款思路，原生 TS 版）：localStorage 存开关，
 * documentElement 挂 .code-wrap 类让所有代码块即时生效，自定义事件让已渲染
 * 的按钮同步按下态。这是显示偏好不是文档数据，进 localStorage 合理。
 */
const CODE_WRAP_KEY = 'lector_code_wrap'
const CODE_WRAP_EVENT = 'lector:code-wrap'

function readCodeWrap(): boolean {
  try {
    return localStorage.getItem(CODE_WRAP_KEY) === '1'
  } catch {
    return false
  }
}

function writeCodeWrap(wrap: boolean): void {
  try {
    localStorage.setItem(CODE_WRAP_KEY, wrap ? '1' : '0')
  } catch {
    /* 隐私模式等存不进就只当次会话生效 */
  }
  document.documentElement.classList.toggle('code-wrap', wrap)
  window.dispatchEvent(new Event(CODE_WRAP_EVENT))
}

// 模块加载即应用偏好，首屏渲染的代码块就是正确状态。
document.documentElement.classList.toggle('code-wrap', readCodeWrap())

function syncWrapButton(btn: HTMLElement): void {
  const on = readCodeWrap()
  btn.innerHTML = iconSvg('wrap', 14)
  btn.classList.toggle('is-active', on)
  btn.setAttribute('aria-pressed', String(on))
  const tip = on ? t('codeScroll') : t('codeWrap')
  btn.setAttribute('aria-label', tip)
  btn.dataset.tip = tip
}

// 每个按钮各挂一个 window 监听会随块重渲染累积泄漏——全局只装一个，
// 事件来了同步当前 DOM 里所有折行按钮。
let wrapSyncInstalled = false
function ensureWrapSync(): void {
  if (wrapSyncInstalled) return
  wrapSyncInstalled = true
  window.addEventListener(CODE_WRAP_EVENT, () => {
    for (const btn of document.querySelectorAll<HTMLElement>('.code-wrap-toggle')) {
      syncWrapButton(btn)
    }
  })
}

/**
 * 代码块加「语言标签 + 复制」。
 *
 * 读代码时的实际需求：想知道这是什么语言、想把这段拿走。
 * 复制走 DOM 的文本而不是 block.raw——raw 含围栏与缩进，复制出来是源码片段而不是代码。
 */
/**
 * 代码块 / 图表的复制键：改成图标按钮。
 *
 * 两个理由：
 *   1. 之前是文字「复制」，和左侧语言标一起挤在 0 高度的贴片上，块一窄就被挤出框；
 *   2. 图标不占横向空间，语言标因此能保留自己的位置。
 * 复制后短暂换成对勾——动作有没有生效，比任何提示条都直接。
 */
function decorateCopyButton(btn: HTMLElement): void {
  const idle = () => {
    btn.innerHTML = iconSvg('copy', 14)
    delete btn.dataset.copied
  }
  idle()
  btn.setAttribute('aria-label', t('codeCopy'))
  btn.dataset.tip = t('codeCopy')
  btn.addEventListener('click', () => {
    btn.innerHTML = iconSvg('check', 14)
    btn.dataset.copied = 'true'
    window.setTimeout(idle, 1200)
  })
}

/** 代码卡头部条：语言标在左、折行与复制键在右，收在代码区域内部（notefast 同款结构）。 */
function makeCodeBar(lang: string, getText: () => string): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'code-bar'
  if (lang) {
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = lang
    bar.appendChild(label)
  }
  ensureWrapSync()
  const wrapBtn = document.createElement('button')
  wrapBtn.type = 'button'
  wrapBtn.className = 'code-wrap-toggle'
  syncWrapButton(wrapBtn)
  wrapBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    writeCodeWrap(!readCodeWrap())
  })
  bar.appendChild(wrapBtn)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'code-copy'
  decorateCopyButton(copy)
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    void copyText(getText())
  })
  bar.appendChild(copy)
  return bar
}

export function decorateCodeBlock(preview: HTMLElement): void {
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

    const bar = makeCodeBar('mermaid', () => source)

    const diagram = document.createElement('div')
    diagram.className = 'mermaid-diagram'
    const status = document.createElement('div')
    status.className = 'mermaid-status'
    status.textContent = t('mermaidLoading')
    diagram.appendChild(status)

    if (pre) pre.remove()
    // 头部条 + 画布收进同一张卡：工具条属于这块内容，不是它头顶的另一行
    const card = document.createElement('div')
    card.className = 'code-card'
    card.append(bar, diagram)
    host.appendChild(card)

    // 点击放大：与 notefast 一致，把**内联的 SVG 标记**交给灯箱（不转 data URL）。
    // 停上后由 outer-content click 统一处理返回。
    diagram.addEventListener('click', (e) => {
      e.stopPropagation()
      const svgEl = diagram.querySelector('svg')
      if (!svgEl) return
      showSvgInLightbox(new XMLSerializer().serializeToString(svgEl), 'mermaid')
    })

    // 渲染入口抽成函数：首渲与栏宽变化后的重渲共用。代数守卫丢弃过期结果
    // （重渲进行中又触发重渲时，只有最新一次落笔）；主题每次重读，切深色模式
    // 后的重渲直接拿到新纸面。
    let renderGen = 0
    const renderInto = (): Promise<void> => {
      const gen = ++renderGen
      const theme: 'light' | 'dark' =
        document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
      // 栏宽传图所在容器的实际宽度：缓存键与画布自然宽都按它算，
      // 栏宽变化后的重渲才能绕开旧缓存、画出匹配新宽度的图。
      const width = Math.round(diagram.clientWidth) || undefined
      return renderMermaidSvg(source, theme, undefined, width)
        .then((svg) => {
          if (gen !== renderGen || !diagram.isConnected) return
          diagram.replaceChildren()
          const inner = document.createElement('div')
          inner.className = 'mermaid-svg'
          inner.innerHTML = svg
          diagram.appendChild(inner)
        })
        .catch((err: unknown) => {
          if (gen !== renderGen || !diagram.isConnected) return
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
    }
    renderInto()

    // 栏宽变化（拖窗口、开关侧栏、调最大宽度）后重渲染：画布自然宽烘在 SVG 里，
    // 不重画的话窄栏甘特的短任务条装不下任务名，标签溢出到条外。diagram 是块级
    // 盒，宽度跟栏走、与内部 SVG 无关——观察它不会因重画自身而循环。首帧回调
    // 只记基准宽度不重画（首渲已在跑）；之后宽度变化超过阈值才防抖重画。
    let baseWidth = 0
    let roTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      const w = Math.round(diagram.clientWidth)
      if (w === 0 || !diagram.isConnected) return
      if (baseWidth === 0) {
        baseWidth = w
        return
      }
      if (Math.abs(w - baseWidth) < 16) return
      baseWidth = w
      clearTimeout(roTimer)
      roTimer = setTimeout(renderInto, 250)
    })
    ro.observe(diagram)

    return
  }

  // 卡 = 代码区域本体：语言标与复制键收进卡内头部，不再飘在代码块上方独立成行。
  // pre 的内容是代码，按钮挪进 pre 里会污染复制结果——所以是「卡包 pre」，不是「pre 里塞按钮」。
  const pre = code.parentElement
  const host = pre?.parentElement
  if (!pre || !host) return
  const card = document.createElement('div')
  card.className = 'code-card'
  card.appendChild(makeCodeBar(lang, () => code.textContent ?? ''))
  host.insertBefore(card, pre)
  card.appendChild(pre)
}
