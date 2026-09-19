/** 标题在 #content 滚动坐标系里的 top（含已滚过的距离）。 */
export interface HeadingOffset {
  id: string
  top: number
}

/**
 * 滚动反查当前小节：已经越过阅读线的最后一个标题。
 *
 * 阅读线默认在容器顶下 72px。到底时取最后一节——后面内容不够时
 * 最后一节永远滚不到阅读线。
 *
 * 纯函数：滚动热路径只拿这份表 + scrollTop 比较，禁止再去量 DOM。
 */
export function pickActiveHeadingId(
  offsets: readonly HeadingOffset[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  lineInset = 72,
): string | null {
  if (offsets.length === 0) return null
  if (scrollTop + clientHeight >= scrollHeight - 2) {
    return offsets[offsets.length - 1]!.id
  }
  const line = scrollTop + lineInset
  let active: string | null = null
  for (const item of offsets) {
    if (item.top <= line) active = item.id
    else break
  }
  return active
}

/** 内容高度变了（mermaid 落笔、块重绘）才需要重新量标题位置。 */
export function headingOffsetsStale(cachedScrollHeight: number | null, scrollHeight: number): boolean {
  return cachedScrollHeight !== scrollHeight
}
