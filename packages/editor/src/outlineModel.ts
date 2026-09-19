import type { BlockView } from '@lector/core'

/** 从块内 mdast 提取纯文本（标题用）。 */
export function headingText(mdast: unknown): string {
  if (Array.isArray(mdast)) return mdast.map(headingText).join(' ')
  const walk = (n: unknown): string => {
    if (!n || typeof n !== 'object') return ''
    const node = n as { type?: string; value?: string; children?: unknown[] }
    if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
    return (node.children ?? []).map(walk).join('')
  }
  return walk(mdast)
}

export interface OutlineHeading {
  id: string
  depth: number
  text: string
}

export interface OutlineNode extends OutlineHeading {
  children: OutlineNode[]
}

/**
 * 标题列表 → 树。用栈而不是递归：depth 回退时弹栈，
 * 一段循环就能说清「谁是谁的子节」，递归反而要传递上下文。
 */
export function buildOutlineTree(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const h of headings) {
    const node: OutlineNode = { ...h, children: [] }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= h.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

export function headingDepth(block: BlockView): number | null {
  if (block.kind !== 'heading') return null
  const node = Array.isArray(block.mdast) ? block.mdast[0] : block.mdast
  const d = (node as { depth?: number } | null)?.depth
  return d == null ? 1 : d
}

export function outlineSignature(blocks: readonly BlockView[]): string {
  return blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => `${b.id}:${headingDepth(b) ?? 1}:${headingText(b.mdast)}`)
    .join('|')
}

/**
 * 打字只改 raw，mdast 要失焦才重解析。非标题块上的逐键 refresh 是空转。
 * 分裂 / 合并 / 换档这类结构变更必须扫。
 */
export function outlineNeedsRefresh(kind: string | undefined, structural: boolean): boolean {
  return structural || kind === 'heading'
}
