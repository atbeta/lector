import { fromMarkdown } from 'mdast-util-from-markdown'
// 不用 gfm() 捆绑包：它不透传 strikethrough 的 singleTilde 选项，而单波浪
// 删除线在中文文档里是「1~6」「H1~H6」这类范围写法的误伤源——只认双波浪。
// mdast 侧处理器 mdast-util-gfm 不受影响，保持不变。
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import { gfmFootnote } from 'micromark-extension-gfm-footnote'
import { math } from 'micromark-extension-math'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { pandocMark } from 'micromark-extension-mark'
import { splitTableRow } from './tableRow.ts'
import { parseBlocksChunked as chunkParse, stubForSlice } from './chunk.ts'
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
  // 脚注定义块：GFM 自带（gfm-footnote 已并入 micromark-extension-gfm），
  // 渲染层有现成的 footnoteDefinition 处理，kind 按 paragraph 走正常聚焦
  footnoteDefinition: 'paragraph',
}

/** 是否启用某扩展（v1.1 起可开表等，日程见 04-bootstrap）。 */
const ENABLE_GFM = true

// micromark-extension-mark 的类型声明见 vendor-mark.d.ts；pandocMark 运行时
// 是工厂函数，这里按实际形态收窄。mdast 侧扩展不引 mdast-util-mark——它自带
// 的 .ts 源码与当前依赖版本有类型出入（tsc 会连坐检查），而实现只有 8 行
// （enter/exit 各一个 mark 处理器 + canContainEols），内联等价物更省心。
type FromMarkdownOptions = NonNullable<Parameters<typeof fromMarkdown>[1]>
const markExtension = (pandocMark as () => unknown)()
const markMdastExtension = {
  canContainEols: ['mark'],
  enter: {
    mark(this: { enter: (node: unknown, token: unknown) => void }, token: unknown) {
      this.enter({ type: 'mark', children: [] }, token)
    },
  },
  exit: {
    mark(this: { exit: (token: unknown) => void }, token: unknown) {
      this.exit(token)
    },
  },
}
// 扩展清单导出给 images.ts 复用：图片定位必须和主解析对同一块文本看到
// 完全相同的语法集，两份清单迟早漂移（0.27.3 的 CI 挂掉就是 images.ts
// 还 import 已移除的 gfm 捆绑包暴露出来的）。
export const extensions = (
  ENABLE_GFM
    ? [
        gfmAutolinkLiteral(),
        // 删除线只认双波浪（~~删除~~）：单波浪留给「1~6」这类范围写法。
        gfmStrikethrough({ singleTilde: false }),
        gfmTable(),
        gfmTaskListItem(),
        gfmFootnote(),
        math(),
        frontmatter(),
        markExtension,
      ]
    : [math(), frontmatter(), markExtension]
) as FromMarkdownOptions['extensions']
export const mdastExtensions = (
  ENABLE_GFM
    ? [gfmFromMarkdown(), mathFromMarkdown(), frontmatterFromMarkdown(), markMdastExtension]
    : [mathFromMarkdown(), frontmatterFromMarkdown(), markMdastExtension]
) as FromMarkdownOptions['mdastExtensions']

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
  const raw = text.slice(start, end)
  let mdast: unknown = mdastOverride ?? node
  if (kind === 'table') mdast = repairTableMdast(raw, mdast)
  return {
    id: `b${start}:${end}`,
    kind,
    start,
    end,
    raw,
    mdast,
    dirty: false,
  }
}

type MdastInline = { type: string; children?: MdastInline[]; value?: string }
type MdastTableCell = { type: 'tableCell'; children: MdastInline[] }
type MdastTableRow = { type: 'tableRow'; children: MdastTableCell[] }
type MdastTable = {
  type: 'table'
  align?: Array<'left' | 'right' | 'center' | null>
  children: MdastTableRow[]
}

function parseTableCellChildren(cell: string): MdastInline[] {
  if (cell === '') return []
  const roots = parseBlockRootsUnrepaired(cell) as Array<{ type: string; children?: MdastInline[] }>
  const out: MdastInline[] = []
  for (const r of roots) {
    if (r.type === 'paragraph' && r.children) out.push(...r.children)
    else out.push(r as MdastInline)
  }
  return out
}

function rowFromCells(cells: string[]): MdastTableRow {
  return {
    type: 'tableRow',
    children: cells.map((c) => ({ type: 'tableCell', children: parseTableCellChildren(c) })),
  }
}

/**
 * 用认代码 span 的切列重做表格 mdast。raw 仍是原文，只修预览树。
 */
function repairTableMdast(raw: string, node: unknown): unknown {
  const lines = raw.replace(/\n$/, '').split('\n')
  if (lines.length < 2) return node
  const header = splitTableRow(lines[0]!, { unescapePipes: false })
  const body = lines.slice(2).map((l) => splitTableRow(l, { unescapePipes: false }))
  const prev = node as MdastTable
  return {
    type: 'table',
    align: prev.align ?? [],
    children: [rowFromCells(header), ...body.map(rowFromCells)],
  } satisfies MdastTable
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
export function carveTableTail(raw: string): { table: string; tail: string } | null {
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
 *
 * 行首四空格在 CommonMark 里是缩进代码。文稿里整段附录被贴成这种缩进时，
 * 标题和表格会整块变成无语言代码（见 liftIndentedMarkdown）。
 */
/**
 * 整篇解析。分块实现（chunk.ts）的结果必须与它严格一致，测试用它做 oracle。
 * 生产路径走 parseBlocks（分块），它不导出到 index。
 */
export function parseBlocksOriginal(text: string): BlockView[] {
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

  return mergeDetailsBlocks(liftIndentedMarkdown(blocks), text)
}

/** 分块解析（chunk.ts）。签名保持不变，调用方无感。opts 只供测试把片切小。 */
export function parseBlocks(text: string, opts?: import('./chunk.ts').ChunkOptions): BlockView[] {
  return chunkParse(text, opts)
}

export interface MergeDetailsOptions {
  /** 跨度里有这块就整段保持拆开。正在编辑时合并会换掉块 id，编辑器跟着被拆掉。 */
  preserveBlock?: (block: BlockView) => boolean
}

/**
 * details 折叠块合并：CommonMark 的 html 块在空行处截断，`<details>`、
 * 中间的 markdown 内容、`</details>` 会被切成多个块——阅读时整段降级成
 * 源码。这里把「开标签块 … 配对闭标签块」的连续跨度合并成一块。
 * 原文用各块当前 raw 拼，不用 text.slice：用户在渐进解析期间改过的字必须留下来。
 * 找不到配对闭标签就不合并，维持逐块降级。
 */
export function mergeDetailsBlocks(
  blocks: BlockView[],
  text: string,
  opts?: MergeDetailsOptions,
): BlockView[] {
  const out: BlockView[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]!
    const opensDetails =
      b.kind === 'html' && /^<details[\s>]/i.test(b.raw.trim()) && !/<\/details>/i.test(b.raw)
    if (opensDetails) {
      // 向前找配对闭标签（html 块内计数，容忍嵌套一层写法）
      let depth = 1
      let j = i + 1
      while (j < blocks.length && depth > 0) {
        const bj = blocks[j]!
        if (bj.kind === 'html') {
          depth += (bj.raw.match(/<details[\s>]/gi) || []).length
          depth -= (bj.raw.match(/<\/details>/gi) || []).length
          if (depth <= 0) break
        }
        j++
      }
      if (j < blocks.length && blocks[j]!.kind === 'html' && depth <= 0) {
        const span = blocks.slice(i, j + 1)
        if (opts?.preserveBlock && span.some((block) => opts.preserveBlock!(block))) {
          out.push(...span)
          i = j + 1
          continue
        }
        const end = blocks[j]!.end
        const baseline = text.slice(b.start, end)
        const raw = span.map((block) => block.raw).join('')
        out.push({
          id: `b${b.start}:${end}`,
          kind: 'html',
          start: b.start,
          end,
          raw,
          mdast: { type: 'html', value: raw },
          dirty: span.some((block) => block.dirty) || raw !== baseline,
        })
        i = j + 1
        continue
      }
    }
    out.push(b)
    i++
  }
  return out
}

/** 块间空行缝：只用于拼接保真，不是可编辑内容。 */
export function isWhitespaceGap(
  block: { kind: BlockKind; raw: string } | undefined | null,
): boolean {
  return !!block && block.kind === 'unknown' && block.raw.trim() === ''
}

/** 可点击进入源码编辑的块。空白缝与未解析占位永远返回 false。 */
export function isFocusableBlock(block: { kind: BlockKind; raw: string }): boolean {
  return block.kind !== 'pending' && !isWhitespaceGap(block)
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

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})/
const INDENTED_CODE_START = /^(?: {4,}|\t)/
/** 去掉四空格 / Tab 之后，二级标题或表格分隔行才像「贴进来的 Markdown」，而不是代码。 */
const ATX_HEADING = /^ {0,3}#{2,6}(?:[ \t]|$)/

/**
 * 缩进代码最多再剥几层。再深就保持代码块，避免上千层缩进把调用栈打穿。
 * 每一层至少少一个缩进字符，8 层够覆盖到 32 个空格。
 */
const MAX_INDENT_LIFT = 8
let indentLiftDepth = 0

function isTableDelimiterLine(line: string): boolean {
  if (!line.includes('|')) return false
  const trimmed = line.trim()
  if (!/^[\t |:-]+$/.test(trimmed)) return false
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells = body.split('|')
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function looksLikeMarkdownSection(text: string): boolean {
  let lines = text.split(/\r?\n/)
  for (let depth = 0; depth < 4; depth++) {
    if (lines.some((line) => ATX_HEADING.test(line) || isTableDelimiterLine(line))) return true
    let changed = false
    lines = lines.map((line) => {
      const peeled = line.startsWith('    ') ? line.slice(4) : line.startsWith('\t') ? line.slice(1) : line
      if (peeled !== line) changed = true
      return peeled
    })
    if (!changed) return false
  }
  return false
}

/**
 * 按 CommonMark 缩进代码的规则剥掉每行最多 4 列前缀。
 * map[i] 是去缩进后第 i 个字符在 raw 里的下标；剥掉的空格不进 map。
 * 遇到要把 Tab 拆成「半个在前缀、半个在正文」时放弃（那种正文里的空格在原文里不存在）。
 */
function dedentIndentedCode(raw: string): { text: string; map: number[] } | null {
  const map: number[] = []
  let text = ''
  let i = 0
  while (i < raw.length) {
    let col = 0
    let j = i
    while (col < 4 && j < raw.length) {
      const c = raw.charCodeAt(j)
      if (c === 32) {
        col++
        j++
      } else if (c === 9) {
        const width = 4 - (col % 4)
        if (col + width > 4) return null
        col += width
        j++
      } else break
    }
    if (col >= 4) {
      i = j
    } else {
      let k = j
      while (k < raw.length) {
        const c = raw.charCodeAt(k)
        if (c === 10 || c === 13) break
        if (c !== 32 && c !== 9) return null
        k++
      }
      i = k
    }
    if (i >= raw.length) break
    while (i < raw.length) {
      const c = raw.charCodeAt(i)
      if (c === 13) {
        text += '\r'
        map.push(i)
        i++
        if (i < raw.length && raw.charCodeAt(i) === 10) {
          text += '\n'
          map.push(i)
          i++
        }
        break
      }
      if (c === 10) {
        text += '\n'
        map.push(i)
        i++
        break
      }
      text += raw[i]!
      map.push(i)
      i++
    }
  }
  if (map.length !== text.length) return null
  return { text, map }
}

function sectionKind(block: BlockView): boolean {
  if (block.kind === 'table') return true
  if (block.kind !== 'heading') return false
  const depth = (block.mdast as { depth?: number } | null)?.depth ?? 0
  return depth >= 2
}

function rawIndex(map: number[], textOffset: number): number {
  if (map.length === 0) return 0
  if (textOffset <= 0) return map[0]!
  if (textOffset >= map.length) return map[map.length - 1]! + 1
  return map[textOffset]!
}

function coversRange(blocks: BlockView[], start: number, end: number, raw: string): boolean {
  if (blocks.length === 0 || blocks[0]!.start !== start || blocks[blocks.length - 1]!.end !== end) return false
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.end <= block.start) return false
    if (i > 0 && block.start !== blocks[i - 1]!.end) return false
    if (block.raw !== raw.slice(block.start - start, block.end - start)) return false
  }
  return true
}

/** 把去缩进后的块映射回原文下标。行首空格落在空白缝里，多行块中间的缩进留在该块 raw 中。 */
function remapLifted(inner: BlockView[], raw: string, base: number, map: number[]): BlockView[] {
  const out: BlockView[] = []
  let cursor = 0
  const push = (relS: number, relE: number, block: BlockView | null) => {
    if (relE <= relS) return
    const absS = base + relS
    const absE = base + relE
    const slice = raw.slice(relS, relE)
    const prev = out[out.length - 1]
    const gap = block === null || (block.kind === 'unknown' && slice.trim() === '')
    if (gap && prev && prev.kind === 'unknown' && prev.mdast == null && prev.end === absS && prev.raw.trim() === '') {
      prev.end = absE
      prev.raw = raw.slice(prev.start - base, relE)
      prev.id = `b${prev.start}:${absE}`
      return
    }
    out.push({
      id: `b${absS}:${absE}`,
      kind: block?.kind ?? 'unknown',
      start: absS,
      end: absE,
      raw: slice,
      mdast: gap ? null : (block?.mdast ?? null),
      dirty: false,
    })
  }
  for (const block of inner) {
    const relS = rawIndex(map, block.start)
    const relE = rawIndex(map, block.end)
    if (relS > cursor) push(cursor, relS, null)
    const from = Math.max(relS, cursor)
    if (relE > from) push(from, relE, block)
    cursor = Math.max(cursor, relE)
  }
  if (cursor < raw.length) push(cursor, raw.length, null)
  return out
}

function expandIndentedCode(block: BlockView): BlockView[] | null {
  const raw = block.raw
  if (indentLiftDepth >= MAX_INDENT_LIFT) return null
  if (!INDENTED_CODE_START.test(raw) || FENCED_CODE.test(raw)) return null
  const dedented = dedentIndentedCode(raw)
  if (!dedented || dedented.text.length === 0 || dedented.text.length >= raw.length) return null
  if (!looksLikeMarkdownSection(dedented.text)) return null
  indentLiftDepth++
  let inner: BlockView[]
  try {
    inner = parseBlocksOriginal(dedented.text)
  } finally {
    indentLiftDepth--
  }
  if (!inner.some(sectionKind)) return null
  const lifted = remapLifted(inner, raw, block.start, dedented.map)
  if (!coversRange(lifted, block.start, block.end, raw)) return null
  return lifted
}

/**
 * 缩进代码里如果能看出二级及以上标题或 GFM 表格，就按去缩进后的 Markdown 拆块。
 * `# 注释` 和普通代码留在代码块里。围栏代码不动。拆开后 raw 仍拼回原来的字节。
 */
export function liftIndentedMarkdown(blocks: BlockView[]): BlockView[] {
  let changed = false
  const out: BlockView[] = []
  for (const block of blocks) {
    if (block.kind !== 'code') {
      out.push(block)
      continue
    }
    const lifted = expandIndentedCode(block)
    if (!lifted) {
      out.push(block)
      continue
    }
    changed = true
    out.push(...lifted)
  }
  return changed ? out : blocks
}

function parseBlockRootsUnrepaired(raw: string): unknown[] {
  const tree = fromMarkdown(raw, { extensions, mdastExtensions }) as {
    children: unknown[]
  }
  return tree.children
}

function blockRootsOf(raw: string, defs?: import('./chunk.ts').DefinitionSet): unknown[] {
  const parsed = defs ? reparseWithDefs(raw, defs) : raw
  return parseBlockRootsUnrepaired(parsed)
    .map((node) => {
      const n = node as { type?: string; position?: { start?: { offset?: number }; end?: { offset?: number } } }
      if (n.type !== 'table') return node
      const s = n.position?.start?.offset ?? 0
      const e = n.position?.end?.offset ?? raw.length
      if (s >= raw.length) return null
      return repairTableMdast(raw.slice(s, Math.min(e, raw.length)), node)
    })
    .filter((n) => n !== null)
}

function rootsHaveSection(nodes: unknown[]): boolean {
  for (const node of nodes) {
    const n = node as { type?: string; depth?: number }
    if (n.type === 'table') return true
    if (n.type === 'heading' && (n.depth ?? 0) >= 2) return true
  }
  return false
}

/**
 * 提升后的多行表格，续行仍带着原来的四空格（空格必须留在 raw 里才能拼回原文）。
 * 失焦重解析时先剥掉这层续行缩进，否则分隔行不再被认成表格。
 */
function stripContinuationIndent(raw: string): string | null {
  const nl = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(nl)
  if (lines.length < 2) return null
  let changed = false
  const out = lines.map((line, index) => {
    if (index === 0) return line
    if (line.startsWith('    ')) {
      changed = true
      return line.slice(4)
    }
    if (line.startsWith('\t')) {
      changed = true
      return line.slice(1)
    }
    return line
  })
  return changed ? out.join(nl) : null
}

/**
 * 解析一块 raw，返回全部块级根节点（一段改成两段时预览不能只画第一个）。
 */
export function parseBlockRoots(raw: string, defs?: import('./chunk.ts').DefinitionSet): unknown[] {
  const roots = blockRootsOf(raw, defs)
  if (rootsHaveSection(roots)) return roots
  const stripped = stripContinuationIndent(raw)
  if (!stripped) return roots
  const alt = blockRootsOf(stripped, defs)
  return rootsHaveSection(alt) ? alt : roots
}

/**
 * 单块重解析时补上文档里其他块的定义（桩追加在末尾，结果里越过 raw 的节点会被丢弃）。
 * 块尾还开着围栏 / 数学块时不补：桩会被吞进去，露在预览里。
 */
function reparseWithDefs(raw: string, defs: import('./chunk.ts').DefinitionSet): string {
  const stub = stubForSlice(raw, defs)
  if (!stub) return raw
  const fence = raw.match(/^ {0,3}(`{3,}|~{3,})/)
  if (fence) {
    const close = new RegExp(`\\n {0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}[ \\t]*$`)
    if (!close.test(raw)) return raw
  }
  return raw + '\n\n' + stub + '\n'
}

/**
 * 解析单个块的 raw，返回其首个块级 mdast 节点（用于脏块 kind / 单根预览）。
 */
export function parseOne(raw: string): unknown | null {
  return parseBlockRoots(raw)[0] ?? null
}
