/**
 * 渐进解析的覆盖终点：只看占位块之前的块，取最大的 end。
 *
 * 占位块之后是用户追加到文末的块（图片、空段），它们的 end 往往是 0。
 * 若拿「最后一个非占位块的 end」当覆盖终点，尾巴的 raw 会被算成整篇原文，
 * 保存时已解析的正文就写两遍。
 */
export function coveredEndBeforePending(blocks: readonly { kind: string; end: number }[]): number {
  let covered = 0
  for (const block of blocks) {
    if (block.kind === 'pending') break
    if (block.end > covered) covered = block.end
  }
  return covered
}
