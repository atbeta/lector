/** 表格比栏宽超出这个值才突出到两侧留白。1px 吃掉亚像素。 */
const BREAKOUT_SLACK_PX = 1

/**
 * 窄表留在栏内，左缘不挪。
 * 栏宽还没量到（0）时不当成宽表，避免首帧误加突出。
 */
export function tableNeedsBreakout(tableScrollWidth: number, columnWidth: number): boolean {
  if (!(tableScrollWidth > 0) || !(columnWidth > 0)) return false
  return tableScrollWidth > columnWidth + BREAKOUT_SLACK_PX
}

/**
 * 宽表怎么摆。
 *
 * 借得下两侧留白就突出，外框不贴窗口沿，窄表的左缘也不动。
 * 借完仍比那条缝宽（二十列这种）就**不突出**：外框留在栏内横滑。
 * 否则外框占满整行，左框和块轨道都会浮在格子上。
 */
export function wideTablePlacement(
  tableScrollWidth: number,
  columnWidth: number,
  roomWidth: number,
): { breakout: boolean; scroll: boolean } {
  if (!tableNeedsBreakout(tableScrollWidth, columnWidth)) {
    return { breakout: false, scroll: false }
  }
  const fits = tableScrollWidth <= roomWidth + BREAKOUT_SLACK_PX
  return { breakout: fits, scroll: !fits }
}
