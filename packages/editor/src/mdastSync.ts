import {
  isWhitespaceGap,
  kindFromMdast,
  parseBlockRoots,
  parseBlocks,
  type BlockKind,
  type DefinitionSet,
} from '@lector/core'

/**
 * 预览用的 mdast 是否还对得上这段原文。
 *
 * 不能用 block.dirty 代替。dirty 只回答「和打开时的原文是否不同」。
 * 加了字、失焦解析过，再把字删回去，dirty 回到 false，mdast 仍是加字后的那棵树。
 * 点空白失焦时若按 dirty 跳过重解析，预览就停在删除之前。
 *
 * 也不能改成失焦一律重解析：原文没变时，details 的树是合并时写下的
 * `{ type: 'html', value: raw }`，再走一遍 parseBlockRoots 会把折叠块里的
 * markdown 拆成普通块。
 */
export function mdastNeedsReparse(parsedFrom: string | undefined, text: string): boolean {
  return parsedFrom !== text
}

/**
 * 一块原文变化后，预览该用的树。
 *
 * 普通块走 parseBlockRoots（一段被改成多段时根可以有多个）。
 * details 跨度在打开时被收成一整段 html 源码；这里认出同一种合并结果，
 * 继续把整段原文放进 html 节点，不把内部列表拆出来。
 */
export function mdastForEditedBlock(
  text: string,
  defs?: DefinitionSet,
): { mdast: unknown; kind: BlockKind } {
  const kept = parseBlocks(text).filter((block) => !isWhitespaceGap(block))
  const only = kept.length === 1 ? kept[0] : undefined
  const node = only?.mdast as { type?: string; value?: string } | null | undefined
  if (
    only &&
    only.kind === 'html' &&
    node?.type === 'html' &&
    node.value === only.raw &&
    /<details[\s>]/i.test(only.raw)
  ) {
    return { mdast: { type: 'html', value: text }, kind: 'html' }
  }
  const roots = parseBlockRoots(text, defs)
  return {
    mdast: roots.length <= 1 ? (roots[0] ?? null) : roots,
    kind: kindFromMdast(roots[0]),
  }
}

/**
 * 这块 mdast 是从哪段原文解析的。
 *
 * 第一次见到这块时，传入的 raw 还是解析来源（打开时的原文，或上一次提交后的原文）。
 * 已经记过就不要用当前 raw 覆盖：打字会先改 raw，再删回原文时当前 raw 已经不是那棵树的来源。
 */
export function parsedSource(parsed: Map<string, string>, id: string, rawIfUnknown: string): string {
  const known = parsed.get(id)
  if (known !== undefined) return known
  parsed.set(id, rawIfUnknown)
  return rawIfUnknown
}
