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
    // 长文档先出首屏、解析和绘制分批补。目标位置可能还没进 DOM。
    // 等内容高度够了再跳，期间用户滚动或点击过就不再打扰。
    // 3MB 的补齐大约数秒，给 12 秒；超时按当时高度跳。
    const startedAt = performance.now()
    let scrolled = false
    const onUserScroll = () => {
      scrolled = true
    }
    // 键盘翻页不发生在滚动容器上（焦点常在 document 上），只听 wheel / pointerdown 会和恢复逻辑抢滚动条。
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === ' '
      ) {
        scrolled = true
      }
    }
    const listen = () => {
      scroller.addEventListener('wheel', onUserScroll, { passive: true })
      scroller.addEventListener('pointerdown', onUserScroll, { passive: true })
      document.addEventListener('keydown', onKey)
    }
    const unlisten = () => {
      scroller.removeEventListener('wheel', onUserScroll)
      scroller.removeEventListener('pointerdown', onUserScroll)
      document.removeEventListener('keydown', onKey)
    }
    listen()
    const tryRestore = () => {
      unlisten()
      if (scrolled || getPath() !== path) return
      if (scroller.scrollHeight < top + scroller.clientHeight && performance.now() - startedAt < 12000) {
        listen()
        window.setTimeout(tryRestore, 50)
        return
      }
      scroller.scrollTop = top
      onRestore()
    }
    // 等一帧：render() 刚改完 DOM，同一帧里设 scrollTop 会被随后的布局吃掉
    requestAnimationFrame(tryRestore)
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
