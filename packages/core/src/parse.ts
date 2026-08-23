import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { BlockKind, BlockView } from './types.ts'

/** mdast node.type → BlockKind；未识别归 unknown（整段当一块 raw 预览降级）。 */
const KIND_MAP: Record<string, BlockKind> = {
  paragraph: 'paragraph',
  heading: 'heading',
  list: 'list',
  code: 'code',
  blockquote: 'blockquote',
  thematicBreak: 'thematicBreak',
  html: 'html',
  yaml: 'yaml',
  table: 'table',
}

/** 是否启用某扩展（v1.1 起可开表等，日程见 04-bootstrap）。 */
const ENABLE_GFM = true

const extensions = ENABLE_GFM ? [gfm(), frontmatter()] : [frontmatter()]
const mdastExtensions = ENABLE_GFM ? [gfmFromMarkdown(), frontmatterFromMarkdown()] : [frontmatterFromMarkdown()]

function makeUnknownBlock(start: number, end: number, text: string): BlockView {
  return {
    id: `b${start}:${end}`,
    kind: 'unknown',
    start,
    end,
    raw: text.slice(start, end),
    mdast: null,
    dirty: false,
  }
}

function makeContentBlock(
  node: { type: string; position?: unknown },
  start: number,
  end: number,
  text: string,
): BlockView {
  const kind = KIND_MAP[node.type] ?? 'unknown'
  return {
    id: `b${start}:${end}`,
    kind,
    start,
    end,
    raw: text.slice(start, end),
    mdast: node,
    dirty: false,
  }
}

/**
 * 由归一后的 '\n' 正文切片成 BlockView[]。
 *
 * 保证：blocks[0].start === 0；blocks[i].end === blocks[i+1].start；
 * last.end === text.length；拼接还原全文。mdast 子节点不带块尾空行，
 * 块间空隙（空行/空白）合成 unknown 块，**绝不丢空行**。
 */
export function parseBlocks(text: string): BlockView[] {
  const tree = fromMarkdown(text, { extensions, mdastExtensions }) as {
    children: Array<{
      type: string
      position?: { start: { offset?: number }; end: { offset?: number } } | null
    }>
  }

  const blocks: BlockView[] = []
  let cursor = 0

  for (const node of tree.children) {
    const pos = node.position
    const s = pos?.start.offset
    const e = pos?.end.offset
    if (s == null || e == null || e <= s) {
      // position 缺失或非法：内容被 gap→unknown 兜底，不丢字
      continue
    }
    // 块间带空行 → 先补 unknown 缝
    if (s > cursor) {
      blocks.push(makeUnknownBlock(cursor, s, text))
    }
    // 防御重叠：从 cursor 裁剪（mdast 正常不重叠，此分支仅安全）
    const clipS = Math.max(s, cursor)
    if (clipS < e) {
      blocks.push(makeContentBlock(node, clipS, e, text))
      cursor = e
    }
  }

  // 尾部残余 → unknown
  if (cursor < text.length) {
    blocks.push(makeUnknownBlock(cursor, text.length, text))
  }

  return blocks
}

/** 块间空行缝：只用于拼接保真，不是可编辑内容。 */
export function isWhitespaceGap(
  block: { kind: BlockKind; raw: string } | undefined | null,
): boolean {
  return !!block && block.kind === 'unknown' && block.raw.trim() === ''
}

/** 可点击进入源码编辑的块。空白缝永远返回 false。 */
export function isFocusableBlock(block: { kind: BlockKind; raw: string }): boolean {
  return !isWhitespaceGap(block)
}

/** 方向键跨块：从 fromId 沿 dir 找下一个可聚焦块，跳过空白缝。 */
export function adjacentFocusableId(
  blocks: ReadonlyArray<{ id: string; kind: BlockKind; raw: string }>,
  fromId: string,
  dir: -1 | 1,
): string | null {
  const i = blocks.findIndex((b) => b.id === fromId)
  if (i < 0) return null
  for (let k = i + dir; k >= 0 && k < blocks.length; k += dir) {
    const b = blocks[k]!
    if (isFocusableBlock(b)) return b.id
  }
  return null
}

/**
 * 解析单个块的 raw，返回其首个块级 mdast 节点（用于脏块预览重建）。
 * position 缺省时返回 null。
 */
export function parseOne(raw: string): unknown | null {
  const tree = fromMarkdown(raw, { extensions, mdastExtensions }) as {
    children: unknown[]
  }
  const first = tree.children[0]
  return first ?? null
}
