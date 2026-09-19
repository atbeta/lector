/** 上一轮块预览画进 DOM 的形态：用来决定这次 render 能不能跳过这块。 */

export interface BlockPaint {
  raw: string
  kind: string
  focused: boolean
  mode: string
}

/** raw / kind / 聚焦 / 视图档都没变 → 再砸 DOM 只会让图重解码、mermaid 重画。 */
export function sameBlockPaint(prev: BlockPaint | undefined, next: BlockPaint): boolean {
  return (
    !!prev &&
    prev.raw === next.raw &&
    prev.kind === next.kind &&
    prev.focused === next.focused &&
    prev.mode === next.mode
  )
}
