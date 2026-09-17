import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
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
  math: 'math',
}

/** 是否启用某扩展（v1.1 起可开表等，日程见 04-bootstrap）。 */
const ENABLE_GFM = true

const extensions = ENABLE_GFM ? [gfm(), math(), frontmatter()] : [math(), frontmatter()]
const mdastExtensions = ENABLE_GFM
  ? [gfmFromMarkdown(), mathFromMarkdown(), frontmatterFromMarkdown()]
  : [mathFromMarkdown(), frontmatterFromMarkdown()]

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
  mdastOverride?: unknown,
): BlockView {
  const kind = KIND_MAP[node.type] ?? 'unknown'
  return {
    id: `b${start}:${end}`,
    kind,
    start,
    end,
    raw: text.slice(start, end),
    mdast: mdastOverride ?? node,
    dirty: false,
  }
}

/**
 * 把表格 raw 尾部连续的无管道行切出来。
 *
 * GFM 规范里表格只在空行或另一个块级结构开始处结束，普通段落行不算——
 * 于是表格后紧跟的图片/文字行会被当成「单格行」吸进表格，图片渲染成
 * <td> 里的图被单元格宽度压得很小。这里把尾部无管道行还成独立块：
 * 只是重新分块，拼接字节不变。单列表格的无管道正文行会被误切，
 * 但那种写法罕见且有歧义，阅读优先。
 */
function carveTableTail(raw: string): { table: string; tail: string } | null {
  const lines = raw.split('\n')
  let i = lines.length
  while (i > 0 && !lines[i - 1]!.includes('|')) i--
  // 整段无管道（不可能是表格）或尾部没有无管道行：不切
  if (i === 0 || i === lines.length) return null
  const tail = lines.slice(i).join('\n')
  if (tail.trim() === '') return null
  // 表格块收下最后一行行尾的换行符，切出块从行首开始——两块无缝拼接
  return { table: lines.slice(0, i).join('\n') + '\n', tail }
}

/** 由 mdast 节点类型映射 BlockKind。 */
export function kindFromMdast(node: unknown): BlockKind {
  if (!node || typeof node !== 'object') return 'unknown'
  const type = (node as { type?: string }).type
  if (!type) return 'unknown'
  return KIND_MAP[type] ?? 'unknown'
}

/**
 * 由归一后的正文切片成 BlockView[]。
 *
 * 保证：blocks[0].start === 0；blocks[i].end === blocks[i+1].start；
 * last.end === text.length；拼接还原全文。mdast 子节点不带块尾空行，
 * 块间空隙（空行/空白）合成 unknown 块，**绝不丢空行**。
 * 表格后紧跟的段落行会被 GFM 吸进表格，这里切出来还成独立块
 * （见 carveTableTail），拼接仍恒等。
 * 空文档给一块可聚焦空段落，否则无法开始输入。
 */
export function parseBlocks(text: string): BlockView[] {
  if (text.length === 0) {
    return [
      {
        id: 'b0:0',
        kind: 'paragraph',
        start: 0,
        end: 0,
        raw: '',
        mdast: parseOne(''),
        dirty: false,
      },
    ]
  }

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
      // 表格尾部被 GFM 吸进去的段落行：切出来还成独立块（见 carveTableTail）
      const carved = node.type === 'table' ? carveTableTail(text.slice(clipS, e)) : null
      if (carved) {
        const tEnd = clipS + carved.table.length
        // 原表格节点的 rows 还含被吸进去的行，用截断后的 raw 重解析
        blocks.push(makeContentBlock(node, clipS, tEnd, text, parseOne(carved.table)))
        const tailRoot = parseOne(carved.tail)
        blocks.push({
          id: `b${tEnd}:${e}`,
          kind: kindFromMdast(tailRoot),
          start: tEnd,
          end: e,
          raw: text.slice(tEnd, e),
          mdast: tailRoot,
          dirty: false,
        })
        cursor = e
      } else {
        blocks.push(makeContentBlock(node, clipS, e, text))
        cursor = e
      }
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
 * 解析一块 raw，返回全部块级根节点（一段改成两段时预览不能只画第一个）。
 */
export function parseBlockRoots(raw: string): unknown[] {
  const tree = fromMarkdown(raw, { extensions, mdastExtensions }) as {
    children: unknown[]
  }
  return tree.children
}

/**
 * 解析单个块的 raw，返回其首个块级 mdast 节点（用于脏块 kind / 单根预览）。
 */
export function parseOne(raw: string): unknown | null {
  return parseBlockRoots(raw)[0] ?? null
}
