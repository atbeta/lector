/** 上一轮块真正画进 DOM 的形态：用来决定这次 render 能不能跳过这块。 */

export type BlockPaintSurface = 'cm' | 'preview'

export interface BlockPaint {
  raw: string
  kind: string
  surface: BlockPaintSurface
}

/**
 * 这块这次该画成什么。
 *
 * 阅读档和编辑档的**未聚焦**块都是同一份预览 DOM，不能把 data-mode 当成
 * 重绘条件——否则「点一块进编辑」或「带着焦点切回阅读」会把整篇 mermaid /
 * 图拆掉重画，卡的就是这一下。只有聚焦（挂 CM）才是另一种表面；
 * 源码档是整篇一个 CM，不走块绘制。
 */
export function blockPaintSurface(mode: string, focused: boolean): BlockPaintSurface {
  if (focused) return 'cm'
  return 'preview'
}

/** raw / kind / 表面都没变 → 再砸 DOM 只会让图重解码、mermaid 重画。 */
export function sameBlockPaint(prev: BlockPaint | undefined, next: BlockPaint): boolean {
  return !!prev && prev.raw === next.raw && prev.kind === next.kind && prev.surface === next.surface
}
