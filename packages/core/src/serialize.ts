import type { BlockView } from './types.ts'

/**
 * 脏块的归一化输出。
 * v1：块 raw 由编辑者提供，core 不自行追加换行——块间换行由 unknown 缝保证，
 * 因此这里直接返回块的当前文本即可维持拼接正确。
 * （若未来把块尾换行并入块内，此函数再负责对齐邻居约定。）
 */
export function normalizeBlockRaw(block: Pick<BlockView, 'raw' | 'dirty'>): string {
  return block.raw
}

/**
 * 由块拼出归一后的正文：净块用 raw（原文切片），脏块用 normalizeBlockRaw。
 * 禁止整篇 remark-stringify。
 */
export function serialize(
  blocks: ReadonlyArray<Pick<BlockView, 'raw' | 'dirty'>>,
): string {
  return blocks.map((b) => (b.dirty ? normalizeBlockRaw(b) : b.raw)).join('')
}
