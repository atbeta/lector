/** 视口上方的占位块换成真实高度时，scrollTop 要补上的像素。 */

export interface ScrollAnchorBox {
  blockTop: number
  blockBottom: number
  viewportTop: number
  oldHeight: number
  newHeight: number
}

/**
 * 整块都在阅读区顶边之上才补偿。
 * 跨过顶边、或还在视口里的块，长高发生在人正在看的地方，画面不该被拽走。
 * 1px 容差吃掉亚像素取整。
 */
export function scrollAnchorDelta(box: ScrollAnchorBox): number {
  if (box.blockBottom > box.viewportTop + 1) return 0
  return box.newHeight - box.oldHeight
}
