// 聚焦块的 mermaid 实时预览面板。
//
// 编辑反馈回路原本是「改 → 失焦 → 看图 → 点回来」，对几十行的时序图非常磨人。
// 面板挂在聚焦块内（源码下方），输入防抖 400ms 后重渲；出错就地显示 mermaid
// 的错误信息，上一版图保留不闪。架构红线不碰：CM 仍是裸编辑器只编源码，
// 面板活在块的预览容器里，不用任何 Decoration widget。

import { renderMermaidSvg } from './mermaid.ts'
import { t } from './i18n.ts'

/** 从块 raw（含围栏）里剥出 mermaid 源码。编辑中间态缺收尾围栏也能剥。 */
export function extractMermaidSource(raw: string): string {
  const lines = raw.split('\n')
  if (lines.length > 0 && /^\s*```/.test(lines[0]!)) lines.shift()
  if (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1]!)) lines.pop()
  return lines.join('\n')
}

export interface MermaidLivePanel {
  el: HTMLElement
  /** CM onChange 转发进来：传整段块 raw（含围栏）。 */
  update(raw: string): void
  destroy(): void
}

const DEBOUNCE_MS = 400

export function createMermaidLivePanel(
  initialRaw: string,
  onOpenLightbox: (svg: string) => void,
): MermaidLivePanel {
  const el = document.createElement('div')
  el.className = 'mermaid-live'

  const head = document.createElement('div')
  head.className = 'mermaid-live-head'
  head.textContent = t('mermaidLiveLabel')

  const body = document.createElement('div')
  body.className = 'mermaid-live-body'

  const errorBox = document.createElement('div')
  errorBox.className = 'mermaid-live-error'

  el.append(head, body, errorBox)

  let timer: number | null = null
  let seq = 0
  let lastSource = extractMermaidSource(initialRaw)
  let lastGoodSvg: string | null = null

  function currentTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  }

  function showSvg(svg: string): void {
    body.classList.remove('rendering')
    body.replaceChildren()
    const inner = document.createElement('div')
    inner.className = 'mermaid-svg'
    inner.innerHTML = svg
    body.appendChild(inner)
    lastGoodSvg = svg
    el.classList.remove('has-error')
  }

  function showError(message: string): void {
    body.classList.remove('rendering')
    // 上一版图保留：打字途中的语法错误不该把图闪没
    errorBox.textContent = t('mermaidFailedWith', { error: message })
    el.classList.add('has-error')
  }

  function renderNow(source: string): void {
    const mySeq = ++seq
    body.classList.add('rendering')
    renderMermaidSvg(source, currentTheme())
      .then((svg) => {
        if (!el.isConnected || mySeq !== seq) return
        showSvg(svg)
      })
      .catch((err: unknown) => {
        if (!el.isConnected || mySeq !== seq) return
        showError(err instanceof Error ? err.message : String(err))
      })
  }

  function update(raw: string): void {
    const source = extractMermaidSource(raw)
    if (source === lastSource) return
    lastSource = source
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      renderNow(source)
    }, DEBOUNCE_MS)
  }

  function destroy(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    seq += 1
  }

  // 首帧直接渲，不防抖：聚焦瞬间就该看到图
  renderNow(lastSource)

  body.addEventListener('click', () => {
    if (lastGoodSvg) onOpenLightbox(lastGoodSvg)
  })

  return { el, update, destroy }
}
