import { renderMermaidSvg } from './mermaid.ts'
import { showSvgInLightbox } from './lightbox.ts'
import { iconSvg } from './icons.ts'
import { t } from './i18n.ts'
import { copyText } from './feedback.ts'

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

/** 代码卡头部条：语言标在左、复制键在右，收在代码区域内部（notefast 同款结构）。 */
function makeCodeBar(lang: string, getText: () => string): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'code-bar'
  if (lang) {
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = lang
    bar.appendChild(label)
  }
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

    const theme: 'light' | 'dark' =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    let cancelled = false
    renderMermaidSvg(source, theme)
      .then((svg) => {
        if (cancelled) return
        diagram.replaceChildren()
        const inner = document.createElement('div')
        inner.className = 'mermaid-svg'
        inner.innerHTML = svg
        diagram.appendChild(inner)
      })
      .catch((err: unknown) => {
        if (cancelled) return
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
