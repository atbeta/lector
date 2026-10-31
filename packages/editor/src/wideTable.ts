/** 比栏宽多出这点才算超宽。1px 吃掉亚像素。 */
const COLUMN_SLACK_PX = 1

/**
 * 表是否要比阅读栏更宽，从而在栏内横滑。
 *
 * 外框停在设置的最大行宽里，不借两侧留白。栏宽还没量到（0）时不滑，
 * 避免首帧把一张还没排完的表误判成超宽。
 */
export function tableScrollsInColumn(tableScrollWidth: number, columnWidth: number): boolean {
  if (!(tableScrollWidth > 0) || !(columnWidth > 0)) return false
  return tableScrollWidth > columnWidth + COLUMN_SLACK_PX
}
