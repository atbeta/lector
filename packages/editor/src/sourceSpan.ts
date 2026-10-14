import {
  isFocusableBlock,
  kindFromMdast,
  parseBlocks,
  parseOne,
  serialize,
  type BlockView,
} from '@lector/core'

/** 选区端点：块下标 + 该块 raw 内的 UTF-16 偏移。end 一侧是开区间。 */
export interface SpanPoint {
  index: number
  offset: number
}

export interface SourceSpanEdit {
  blocks: BlockView[]
  /** 光标落在新列表的哪一块。 */
  caretIndex: number
  caretPos: number
}

function ordered(
  blocks: readonly BlockView[],
  a: SpanPoint,
  b: SpanPoint,
): { start: SpanPoint; end: SpanPoint } | null {
  if (!validPoint(blocks, a) || !validPoint(blocks, b)) return null
  if (a.index < b.index || (a.index === b.index && a.offset <= b.offset)) {
    return { start: a, end: b }
  }
  return { start: b, end: a }
}

function validPoint(blocks: readonly BlockView[], p: SpanPoint): boolean {
  const block = blocks[p.index]
  if (!block) return false
  return p.offset >= 0 && p.offset <= block.raw.length
}

/**
 * 端点之间的原文，含中间块和空白缝。
 * 缝在画面上是零高，但文件里就夹在两个端点之间，剪切必须带上它才能原样贴回。
 */
export function coveredSource(
  blocks: readonly BlockView[],
  a: SpanPoint,
  b: SpanPoint,
): string | null {
  const range = ordered(blocks, a, b)
  if (!range) return null
  const { start, end } = range
  if (start.index === end.index) return blocks[start.index]!.raw.slice(start.offset, end.offset)
  const parts = [blocks[start.index]!.raw.slice(start.offset)]
  for (let i = start.index + 1; i < end.index; i++) parts.push(blocks[i]!.raw)
  parts.push(blocks[end.index]!.raw.slice(0, end.offset))
  return parts.join('')
}

function exactBlock(raw: string, id: string): BlockView {
  const mdast = parseOne(raw)
  return {
    id,
    kind: kindFromMdast(mdast),
    start: 0,
    end: raw.length,
    raw,
    mdast,
    dirty: true,
  }
}

/** 空串解析出来是 unknown，会被当成空白缝，点不进去。空文档要留一个段落。 */
function emptyParagraph(id: string): BlockView {
  return {
    id,
    kind: 'paragraph',
    start: 0,
    end: 0,
    raw: '',
    mdast: parseOne(''),
    dirty: true,
  }
}

/** 重解析这一段。拼不回原文字节时退成单块，避免解析器改写没选中的边界。 */
function blocksForFragment(fragment: string, newId: () => string): BlockView[] {
  if (fragment.length === 0) return []
  const parsed = parseBlocks(fragment)
  const source = serialize(parsed) === fragment ? parsed : [exactBlock(fragment, newId())]
  return source.map((block) => ({ ...block, id: newId(), dirty: true }))
}

function caretIn(parsed: readonly BlockView[], offset: number): { index: number; pos: number } | null {
  if (parsed.length === 0) return null
  const total = parsed.reduce((n, block) => n + block.raw.length, 0)
  const at = Math.max(0, Math.min(offset, total))
  let index = parsed.findIndex((block) => at < block.end)
  if (index < 0) index = parsed.length - 1
  const block = parsed[index]!
  if (isFocusableBlock(block)) {
    return { index, pos: Math.max(0, Math.min(block.raw.length, at - block.start)) }
  }
  for (let i = index + 1; i < parsed.length; i++) {
    if (isFocusableBlock(parsed[i]!)) return { index: i, pos: 0 }
  }
  for (let i = index - 1; i >= 0; i--) {
    if (isFocusableBlock(parsed[i]!)) return { index: i, pos: parsed[i]!.raw.length }
  }
  return { index, pos: Math.max(0, Math.min(block.raw.length, at - block.start)) }
}

/**
 * 用 replacement 换掉两个端点之间的原文，只重解析这一段。
 * 区间外的块原样返回（同一对象）。选区为空时返回 null。
 */
export function applySourceSpan(
  blocks: readonly BlockView[],
  a: SpanPoint,
  b: SpanPoint,
  replacement: string,
  newId: () => string,
): SourceSpanEdit | null {
  const range = ordered(blocks, a, b)
  if (!range) return null
  const { start, end } = range
  const covered = coveredSource(blocks, start, end)
  if (covered == null || covered.length === 0) return null
  const head = blocks[start.index]!.raw.slice(0, start.offset)
  const tail = blocks[end.index]!.raw.slice(end.offset)
  const fragment = head + replacement + tail
  const replacesAll =
    start.index === 0 &&
    start.offset === 0 &&
    end.index === blocks.length - 1 &&
    end.offset === blocks[end.index]!.raw.length
  // 删光整篇时留一个空段落，否则没有可以再点进去写的表面。
  const inserted =
    fragment.length === 0 && replacesAll ? [emptyParagraph(newId())] : blocksForFragment(fragment, newId)
  const before = blocks.slice(0, start.index)
  const after = blocks.slice(end.index + 1)
  const next = [...before, ...inserted, ...after]
  const local = caretIn(inserted, head.length + replacement.length)
  if (local) {
    return { blocks: next, caretIndex: before.length + local.index, caretPos: local.pos }
  }
  for (let i = before.length - 1; i >= 0; i--) {
    if (isFocusableBlock(before[i]!)) {
      return { blocks: next, caretIndex: i, caretPos: before[i]!.raw.length }
    }
  }
  for (let i = 0; i < after.length; i++) {
    if (isFocusableBlock(after[i]!)) {
      return { blocks: next, caretIndex: before.length + inserted.length + i, caretPos: 0 }
    }
  }
  if (next.length === 0) return null
  return { blocks: next, caretIndex: 0, caretPos: 0 }
}
