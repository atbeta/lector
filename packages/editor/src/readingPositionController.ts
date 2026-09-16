import {
  getPosition,
  parsePositions,
  prunePositions,
  recordPosition,
  type PositionMap,
} from './readingPosition.ts'

interface ReadingPositionDeps {
  getPath(): string | undefined
  getScroller(): HTMLElement | null
  onRestore(): void
}

export function createReadingPositionController({ getPath, getScroller, onRestore }: ReadingPositionDeps) {
  /** 取文件名：Windows 路径是反斜杠，只 split('/') 会把整条路径留在标题上。 */
  // ── 阅读位置记忆 ──
  // 阅读器的刚需：长文档关掉再打开不该回到顶部。
  // 存 localStorage 而不是设置里：这是每次滚动都在变的会话状态，不属于用户配置。
  const POSITIONS_KEY = 'lector-positions'

  function loadPositions(): PositionMap {
    try {
      return parsePositions(localStorage.getItem(POSITIONS_KEY))
    } catch {
      return {}
    }
  }

  function savePositions(map: PositionMap): void {
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(prunePositions(map)))
    } catch {
      /* 忽略持久化失败：位置记忆丢了不影响正确性 */
    }
  }

  let positions: PositionMap = loadPositions()
  let restoreTimer: number | null = null


  /** 取回并应用上次的阅读位置。只在有记录且位置仍合理时滚动。 */
  function restoreReadingPosition(): void {
    const path = getPath()
    if (!path) return
    const scroller = getScroller()
    if (!scroller) return
    const top = getPosition(positions, path, scroller.scrollHeight)
    if (top === null) return
    // 等一帧：render() 刚改完 DOM，同一帧里设 scrollTop 会被随后的布局吃掉
    requestAnimationFrame(() => {
      scroller.scrollTop = top
      onRestore()
    })
  }

  /**
   * 记录当前位置。
   *
   * 防抖 400ms：滚动时每帧写 localStorage 会拖慢滚动，
   * 而这个值只需要在「用户停下来」时准确。
   * 写之前按文档长度裁剪：编辑让文档变长后，旧的绝对偏移仍能用，
   * 所以这里不按比例换算（换算反而会把位置算丢）。
   */
  function scheduleRecordPosition(): void {
    if (restoreTimer !== null) window.clearTimeout(restoreTimer)
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null
      const path = getPath()
      if (!path) return
      const scroller = getScroller()
      if (!scroller) return
      positions = recordPosition(positions, path, scroller.scrollTop, scroller.scrollHeight)
      savePositions(positions)
    }, 400)
  }

  return { restoreReadingPosition, scheduleRecordPosition }
}
