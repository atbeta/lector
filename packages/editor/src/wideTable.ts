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
