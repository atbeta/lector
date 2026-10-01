// 长文的屏外占位。文档模型仍是块表；这里只决定「这一块现在画预览，还是先占一个高度」。
// 从 documentEditor 拆出来，是为了让会话、解析时间片和滚动调度不再写在同一个函数里。

import { isWhitespaceGap, type BlockView } from '@lector/core'
import { blockPaintSurface, sameBlockPaint, type BlockPaint } from './blockPaint.ts'

/** 超过这么多块，或尾巴还在解析：屏外只占位。 */
export const DEFER_PAINT_BLOCKS = 400
/** 占位块每批挂这么多个。没有 HTML，一批可以比完整绘制大。 */
const SHELL_BATCH = 800

export interface OffscreenShellHost {
  contentEl: HTMLElement
  blockCount(): number
  hasPending(): boolean
  blockAt(index: number): BlockView | undefined
  findBlock(id: string): BlockView | undefined
  focusedId(): string | null
  viewMode(): string
  paintOf(id: string): BlockPaint | undefined
  forgetPaint(id: string): void
  /** 切档后卸掉已经画过的代码预览，避免占位块上留着旧的高亮节点。 */
  teardownPreview(el: HTMLElement): void
  applyMeta(el: HTMLElement, block: BlockView): void
  paintBlock(block: BlockView): void
  /** 占位全部挂完后刷新大纲。 */
  onShellsDone(): void
}

/** 阅读列大约 40 个汉字一行，用来给还没画的块一个滚动高度。 */
export function estimateBlockEm(block: { kind: string; raw: string }): number {
  if (block.kind === 'heading') return 2.6
  const raw = block.raw
  let lines = 1
  let chars = 0
  const cap = Math.min(raw.length, 8_000)
  for (let i = 0; i < cap; i++) {
    if (raw.charCodeAt(i) === 10) lines++
    else chars++
  }
  const wrapped = Math.max(lines, Math.ceil(chars / 40))
  if (block.kind === 'code') return Math.min(wrapped * 1.35 + 0.8, 28)
  return Math.min(wrapped * 1.65 + 0.6, 24)
}

export function createOffscreenShells(host: OffscreenShellHost) {
  /** 用户还在滚动时，解析和挂占位多让一拍。 */
  let scrollIdleAt = 0
  // 挂 document 捕获阶段，不挂 host.contentEl：
  //  - 断言（refactor-verify）要求 #content 上只留顶栏状态这一个滚动监听；
  //  - 大文件档的滚动发生在 CM 的 scrollDOM 里，#content 自己不滚，
  //    挂在它身上等于这个节流整个失灵（滚动时该让的一拍不让，占位照挂）。
  // 捕获阶段能同时覆盖两种容器：滚动事件不冒泡，但捕获先于目标触发。
  document.addEventListener(
    'scroll',
    () => {
      scrollIdleAt = performance.now() + 140
    },
    { capture: true, passive: true },
  )
  let paintObserver: IntersectionObserver | null = null
  const shellQueue: HTMLElement[] = []
  const shelled = new WeakSet<HTMLElement>()
  /** 正文已经高出两屏之后，新块一律先占位。避免每个块都读 scrollHeight。 */
  let preferShell = false

  function deferring(): boolean {
    if (host.blockCount() > DEFER_PAINT_BLOCKS) return true
    return host.hasPending()
  }

  /** 解析时间片的让出间隔：滚动中 140ms，否则 16ms。 */
  function yieldDelay(): number {
    return performance.now() < scrollIdleAt ? 140 : 16
  }

  function reset(): void {
    paintObserver?.disconnect()
    paintObserver = null
    shellQueue.length = 0
    preferShell = false
  }

  function ensureObserver(): IntersectionObserver {
    if (!paintObserver) {
      paintObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) shellQueue.push(entry.target as HTMLElement)
          }
          drainVisible()
        },
        { root: host.contentEl, rootMargin: '60% 0px 140% 0px' },
      )
    }
    return paintObserver
  }

  function drainVisible(): void {
    const start = performance.now()
    let guard = 0
    while (shellQueue.length > 0 && performance.now() - start < 10 && guard < 36) {
      const el = shellQueue.shift()!
      guard++
      const id = el.dataset.blockId
      const block = id ? host.findBlock(id) : undefined
      if (!block || host.paintOf(block.id)) {
        paintObserver?.unobserve(el)
        continue
      }
      host.paintBlock(block)
      paintObserver?.unobserve(el)
    }
    if (shellQueue.length > 0) requestAnimationFrame(drainVisible)
  }

  /** 这块改画真预览了，卸掉占位标记，避免观察者再画一次。 */
  function release(el: HTMLElement): void {
    shelled.delete(el)
    paintObserver?.unobserve(el)
  }

  /** 画之前先问：这一块是不是还停在估高上。测量必须发生在清掉 minHeight 之前。 */
  function has(el: HTMLElement): boolean {
    return shelled.has(el)
  }

  /**
   * 屏外块先占位。已经画对的跳过；切档后表面变了的，卸掉旧预览，滚到再画。
   */
  function queue(el: HTMLElement, block: BlockView): void {
    if (block.kind === 'pending' || isWhitespaceGap(block)) return
    const next: BlockPaint = {
      raw: block.raw,
      kind: block.kind,
      surface: blockPaintSurface(host.viewMode(), block.id === host.focusedId()),
    }
    const prev = host.paintOf(block.id)
    if (sameBlockPaint(prev, next)) return
    if (prev) {
      host.forgetPaint(block.id)
      host.teardownPreview(el)
      el.replaceChildren()
      shelled.delete(el)
    }
    if (shelled.has(el)) {
      ensureObserver().observe(el)
      return
    }
    host.applyMeta(el, block)
    const em = estimateBlockEm(block)
    el.style.containIntrinsicSize = `auto ${em}em`
    el.style.minHeight = `${em}em`
    shelled.add(el)
    ensureObserver().observe(el)
  }

  /**
   * 这一批要不要直接画。
   * 只在批次开始时读一次布局：逐块读 scrollHeight 会让十万块的挂载变成强制布局的平方。
   */
  function drawThisBatch(blockCount: number): boolean {
    if (!deferring()) return true
    if (blockCount === 0) return false
    if (!preferShell) {
      const height = host.contentEl.clientHeight
      if (height > 0 && host.contentEl.scrollHeight > height * 2) preferShell = true
    }
    if (!preferShell) return true
    if (performance.now() < scrollIdleAt) return false
    const height = host.contentEl.clientHeight
    if (height <= 0) return false
    // 人已经滚到尾巴附近才继续画，避免新内容落在视野里却还是空白。
    return host.contentEl.scrollTop + height * 2 >= host.contentEl.scrollHeight - 8
  }

  /** 首屏之外的块分批挂进 DOM，只占位，不画预览。 */
  function mountRest(desired: HTMLElement[], alive: () => boolean, onDone: () => void): void {
    let cursor = 0
    const step = () => {
      if (!alive()) {
        onDone()
        return
      }
      // 滚动时别往下挂占位，阅读这一帧优先。
      if (performance.now() < scrollIdleAt) {
        window.setTimeout(step, 80)
        return
      }
      const end = Math.min(cursor + SHELL_BATCH, desired.length)
      const frag = document.createDocumentFragment()
      const fresh: HTMLElement[] = []
      for (let i = cursor; i < end; i++) {
        const el = desired[i]!
        if (!el.isConnected) {
          frag.appendChild(el)
          fresh.push(el)
        }
      }
      if (fresh.length > 0) host.contentEl.appendChild(frag)
      for (let i = cursor; i < end; i++) {
        const block = host.blockAt(i)
        const el = desired[i]
        if (block && el) queue(el, block)
      }
      cursor = end
      if (cursor < desired.length) window.setTimeout(step, 16)
      else {
        host.onShellsDone()
        onDone()
      }
    }
    window.setTimeout(step, 16)
  }

  return { deferring, yieldDelay, reset, release, has, queue, drawThisBatch, mountRest }
}
