// 分块解析：整篇 fromMarkdown 是超线性的（实测 2.3MB ≈ 10s），按安全边界切成小片后近线性。
//
// 安全边界 = 空行之后、不在任何跨行结构里、也不是列表续项的行首。判据是对 micromark
// 规则的模仿，会有漏网，所以切完再做两道解析后检查（吞尾、接缝），判错就合并重解析。
// 结果与整篇解析严格等价，chunk.test.ts 盯着这条。

import { fromMarkdown } from 'mdast-util-from-markdown'
import {
  carveTableTail,
  extensions,
  kindFromMdast,
  mdastExtensions,
  mergeDetailsBlocks,
  parseOne,
} from './parse.ts'
import { splitTableRow } from './tableRow.ts'
import type { BlockKind, BlockView } from './types.ts'

export interface ChunkOptions {
  /** 片的目标大小（码元）。从这里往后找第一个安全切点。 */
  target?: number
  /**
   * 接缝检查要把上一片并进来之前问一句。返回 false 就保持切开
   * （例如上一片正在被编辑，合并会丢掉用户的输入）。
   */
  canRetract?: (blocks: BlockView[]) => boolean
}

/** 16KB：单片解析要能放进主线程的一个时间片（A0 实测后可调）。 */
const DEFAULT_TARGET = 16 * 1024

/** 链接 / 脚注定义集。identifier 已按 micromark 规则归一（小写、连续空白折成一个空格）。 */
export interface DefinitionSet {
  links: Map<string, { url: string; title: string | null }>
  footnotes: Set<string>
}

export const emptyDefinitionSet = (): DefinitionSet => ({ links: new Map(), footnotes: new Set() })

type MdastNode = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } } | null
  identifier?: string
  url?: string
  title?: string | null
  ordered?: boolean | null
  children?: MdastNode[]
}

// ---------------------------------------------------------------------------
// 切点扫描
// ---------------------------------------------------------------------------

type Container =
  | { kind: 'fence'; char: string; len: number }
  | { kind: 'math' }
  | { kind: 'html'; close: RegExp }
  | { kind: 'frontmatter' }

const CLOSE_OF: Record<string, RegExp> = {
  script: /<\/script>/i,
  pre: /<\/pre>/i,
  style: /<\/style>/i,
  textarea: /<\/textarea>/i,
}

function lineRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  while (i <= text.length) {
    const nl = text.indexOf('\n', i)
    const end = nl < 0 ? text.length : nl
    out.push([i, end])
    if (nl < 0) break
    i = nl + 1
  }
  return out
}

/** 去掉行尾 CR 的行文本。 */
function lineOf(text: string, start: number, end: number): string {
  return end > start && text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end)
}

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c !== 32 && c !== 9) return false
  }
  return true
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line.charCodeAt(n) === 32) n++
  return n
}

/** 这一行是不是列表项的起始行（标记后跟空白或行尾；`-` 单独一行也算）。 */
function isListItemStart(line: string): boolean {
  return /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)
}

/** 列表标记字符：有序列表取分隔符 `.` / `)`，无序取标记本身。 */
export function listMarkerChar(raw: string): string {
  const m = raw.match(/^ {0,3}(?:([-*+])|\d{1,9}([.)]))/)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

/**
 * 行首开出的跨行容器；同一行内就闭合的返回 null（它不阻挡后面的切点）。
 * 只看第 0–3 列，更深的缩进属于列表项 / 引用内容，不是顶层容器。
 */
function openContainer(line: string, atStartOfDoc: boolean): Container | null {
  const body = line.slice(indentOf(line) > 3 ? 0 : indentOf(line))
  const top = indentOf(line) <= 3

  if (top) {
    const fence = body.match(/^(`{3,}|~{3,})(.*)$/)
    if (fence && !fence[2]!.includes(fence[1]![0]!)) {
      return { kind: 'fence', char: fence[1]![0]!, len: fence[1]!.length }
    }
    if (/^\$\$[^$]*$/.test(body.trim())) return { kind: 'math' }
    const tag = body.match(/^<(script|pre|style|textarea)([\s>]|$)/i)
    if (tag) {
      const close = CLOSE_OF[tag[1]!.toLowerCase()]!
      return close.test(line) ? null : { kind: 'html', close }
    }
    if (body.startsWith('<!--')) return /-->/.test(line) ? null : { kind: 'html', close: /-->/ }
    if (body.startsWith('<?')) return /\?>/.test(line) ? null : { kind: 'html', close: /\?>/ }
    if (body.startsWith('<![CDATA[')) return /\]\]>/.test(line) ? null : { kind: 'html', close: /\]\]>/ }
    if (/^<![A-Za-z]/.test(body)) return />/.test(line) ? null : { kind: 'html', close: />/ }
  }
  if (atStartOfDoc && /^---[ \t]*$/.test(line)) return { kind: 'frontmatter' }
  return null
}

function closesContainer(container: Container, line: string): boolean {
  if (container.kind === 'fence') {
    if (indentOf(line) > 3) return false
    const re = new RegExp(`^ {0,3}\\${container.char}{${container.len},}[ \\t]*$`)
    return re.test(line)
  }
  if (container.kind === 'math') return indentOf(line) <= 3 && /^\$\$[ \t]*$/.test(line.trim())
  if (container.kind === 'frontmatter') return /^(?:---|\.\.\.)[ \t]*$/.test(line)
  return container.close.test(line)
}

/**
 * 安全切点（行首偏移，升序）。只在「上一行是空行、本行非空、非列表项起始、不在跨行容器内」处切，
 * 且相邻切点至少隔 target。找不到就整段不切。
 */
export function findSafeSplits(text: string, target = DEFAULT_TARGET): number[] {
  const splits: number[] = []
  const lines = lineRanges(text)
  let container: Container | null = null
  let prevBlank = false
  let nextCut = target

  for (let n = 0; n < lines.length; n++) {
    const [start, end] = lines[n]!
    const line = lineOf(text, start, end)

    if (container) {
      if (closesContainer(container, line)) container = null
      else continue
      prevBlank = isBlank(line)
      continue
    }

    if (
      n > 0 &&
      prevBlank &&
      start >= nextCut &&
      !isBlank(line) &&
      !isListItemStart(line)
    ) {
      splits.push(start)
      nextCut = start + target
    }

    container = openContainer(line, start === 0)
    prevBlank = isBlank(line)
  }
  return splits
}

// ---------------------------------------------------------------------------
// 解析一片
// ---------------------------------------------------------------------------

function parseTree(text: string): MdastNode[] {
  const tree = fromMarkdown(text, { extensions, mdastExtensions }) as { children: MdastNode[] }
  return tree.children
}

function makeBlock(node: MdastNode, start: number, end: number, text: string, mdast: unknown, kind: BlockKind): BlockView {
  return { id: `b${start}:${end}`, kind, start, end, raw: text.slice(start, end), mdast, dirty: false }
}

/** 把一片的顶层节点转成块。base 是片在全文中的起点，limit 是片长（桩追加在其后，要丢弃）。 */
function blocksFromNodes(nodes: MdastNode[], text: string, base: number, limit: number): BlockView[] | null {
  const blocks: BlockView[] = []
  let cursor = 0
  for (const node of nodes) {
    const s = node.position?.start.offset
    const e = node.position?.end.offset
    if (s == null || e == null) continue
    if (s >= limit) break
    if (e > limit) return null // 节点吞进了桩：调用方不带桩重解析
    if (s > cursor) {
      blocks.push({
        id: `b${base + cursor}:${base + s}`,
        kind: 'unknown',
        start: base + cursor,
        end: base + s,
        raw: text.slice(base + cursor, base + s),
        mdast: null,
        dirty: false,
      })
    }
    const clipS = Math.max(s, cursor)
    if (clipS < e) {
      const absS = base + clipS
      const absE = base + e
      const carved = node.type === 'table' ? carveTableTail(text.slice(absS, absE)) : null
      if (carved) {
        const tEnd = absS + carved.table.length
        // 原节点的 rows 含被吸进去的行，必须用截断后的 raw 重解析（与 parse.ts 一致）
        blocks.push(makeBlock(node, absS, tEnd, text, parseOne(carved.table), 'table'))
        const tailRoot = parseOne(carved.tail)
        blocks.push(makeBlock(node, tEnd, absE, text, tailRoot, kindFromMdast(tailRoot)))
      } else {
        // 表格单元格里出现管道时必须重解析：micromark 的表格不认行内代码，
        // 单元格里的 `|` 会把一列裂成两列（table-pipe-code 测试盯着这条）。
        // 没有管道的表占绝大多数，原文节点就是对的，重解析会把收益全部吃掉。
        const raw = text.slice(absS, absE)
        const mdast = node.type === 'table' && tableNeedsRepair(raw) ? parseOne(raw) : node
        blocks.push(makeBlock(node, absS, absE, text, mdast, kindFromMdast(node)))
      }
      cursor = e
    }
  }
  if (cursor < limit) {
    blocks.push({
      id: `b${base + cursor}:${base + limit}`,
      kind: 'unknown',
      start: base + cursor,
      end: base + limit,
      raw: text.slice(base + cursor, base + limit),
      mdast: null,
      dirty: false,
    })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// 定义补桩
// ---------------------------------------------------------------------------

/** micromark 的 normalizeIdentifier：trim、小写、连续空白折成一个空格。 */
export function normalizeIdentifier(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function walkDefinitions(nodes: MdastNode[], into: DefinitionSet): void {
  for (const n of nodes) {
    if (n.type === 'definition' && n.identifier && !into.links.has(n.identifier)) {
      into.links.set(n.identifier, { url: n.url ?? '', title: n.title ?? null })
    } else if (n.type === 'footnoteDefinition' && n.identifier) {
      into.footnotes.add(n.identifier)
    }
    if (n.children && n.type !== 'paragraph' && n.type !== 'heading' && n.type !== 'table') {
      walkDefinitions(n.children, into)
    }
  }
}

/** 桩文本。label 里的方括号与反斜杠转义，避免桩自身被误解析。 */
function stubText(ids: string[], kind: 'link' | 'footnote'): string {
  return ids
    .map((id) => {
      const label = id.replace(/[\\[\]]/g, (c) => '\\' + c)
      return kind === 'footnote' ? `[^${label}]: x` : `[${label}]: #`
    })
    .join('\n')
}

/** 粗扫一片里的候选引用（方括号内容，允许跨行，≤999 字符），归一后返回。多认无害。 */
function candidateRefs(slice: string): Set<string> {
  const out = new Set<string>()
  const re = /\[(\^?)([^\]\n]{0,999}(?:\n[^\]\n]{0,999})?)\]/g
  for (const m of slice.matchAll(re)) {
    const id = normalizeIdentifier(m[2]!)
    if (id) out.add((m[1] ? '^' : '') + id)
  }
  return out
}

// ---------------------------------------------------------------------------
// 分块解析
// ---------------------------------------------------------------------------

interface Piece {
  start: number
  end: number
  nodes: MdastNode[]
  blocks: BlockView[]
}

/**
 * 表格是否需要重解析。micromark 的表格不认行内代码，单元格里的 `|`
 * （`` `|` ``、`\|`）会把一列裂成两列（table-pipe-code 测试盯着这条）。
 * 判据用认代码 span 的切列：切出来的列数与按裸管道数出来的不一致才重解析。
 * 普通表占绝大多数，重解析会把分块的收益全部吃掉。
 */
function tableNeedsRepair(raw: string): boolean {
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i === 1 || lines[i] === '') continue
    const naive = lines[i]!.split('|').length
    const aware = splitTableRow(lines[i]!, { unescapePipes: false }).length + 2
    if (naive !== aware) return true
  }
  return false
}

/** 一片是否把尾部的分隔空行吞进了某个节点（说明这个切点是错的）。 */
function swallowsTrailingBlank(piece: Piece, text: string): boolean {
  const limit = piece.end - piece.start
  for (const n of piece.nodes) {
    if (n.position?.end.offset === limit && limit > 0 && text.charCodeAt(piece.end - 1) === 10) return true
  }
  return false
}

function contentTail(blocks: BlockView[]): BlockView | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!
    if (!(b.kind === 'unknown' && b.raw.trim() === '')) return b
  }
  return null
}

function contentHead(blocks: BlockView[]): BlockView | null {
  for (const b of blocks) {
    if (!(b.kind === 'unknown' && b.raw.trim() === '')) return b
  }
  return null
}

/** 接缝两侧是同一个列表被切开（同序性、同标记字符）。 */
function splitsAList(prev: Piece, next: Piece): boolean {
  const a = contentTail(prev.blocks)
  const b = contentHead(next.blocks)
  if (!a || !b || a.kind !== 'list' || b.kind !== 'list') return false
  const ao = (a.mdast as MdastNode | null)?.ordered ?? null
  const bo = (b.mdast as MdastNode | null)?.ordered ?? null
  if (Boolean(ao) !== Boolean(bo)) return false
  return listMarkerChar(a.raw) === listMarkerChar(b.raw) && listMarkerChar(a.raw) !== ''
}

function parsePiece(text: string, start: number, end: number): Piece {
  const slice = text.slice(start, end)
  const nodes = parseTree(slice)
  const blocks = blocksFromNodes(nodes, text, start, slice.length) ?? []
  return { start, end, nodes, blocks }
}

/**
 * 第一遍：按安全切点切片解析，吞尾 / 接缝检查失败的切点合并重解析。
 * 返回各片与全篇定义集（从每片 mdast 收集，精确）。
 */
function firstPass(text: string, target: number): { pieces: Piece[]; defs: DefinitionSet } {
  const splits = findSafeSplits(text, target)
  const bounds = [0, ...splits, text.length]
  const pieces: Piece[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i] === bounds[i + 1]) continue
    pieces.push(parsePiece(text, bounds[i]!, bounds[i + 1]!))
  }

  // 吞尾：节点把片尾空行吞掉 → 这个切点是错的，与下一片合并
  for (let i = 0; i < pieces.length - 1; ) {
    if (swallowsTrailingBlank(pieces[i]!, text)) {
      const merged = parsePiece(text, pieces[i]!.start, pieces[i + 1]!.end)
      pieces.splice(i, 2, merged)
    } else {
      i++
    }
  }
  // 接缝：两侧是同一个列表 → 合并
  for (let i = 0; i < pieces.length - 1; ) {
    if (splitsAList(pieces[i]!, pieces[i + 1]!)) {
      const merged = parsePiece(text, pieces[i]!.start, pieces[i + 1]!.end)
      pieces.splice(i, 2, merged)
    } else {
      i++
    }
  }

  const defs = emptyDefinitionSet()
  for (const p of pieces) walkDefinitions(p.nodes, defs)
  return { pieces, defs }
}

/** 第二遍：引用了别片定义的片，带桩重解析。 */
function secondPass(text: string, pieces: Piece[], defs: DefinitionSet): BlockView[] {
  const blocks: BlockView[] = []
  for (const piece of pieces) {
    const slice = text.slice(piece.start, piece.end)
    const own = emptyDefinitionSet()
    walkDefinitions(piece.nodes, own)
    const refs = candidateRefs(slice)
    const linkIds: string[] = []
    const footnoteIds: string[] = []
    for (const ref of refs) {
      if (ref.startsWith('^')) {
        const id = ref.slice(1)
        if (defs.footnotes.has(id) && !own.footnotes.has(id)) footnoteIds.push(id)
      } else if (defs.links.has(ref) && !own.links.has(ref)) {
        linkIds.push(ref)
      }
    }
    if (linkIds.length === 0 && footnoteIds.length === 0) {
      blocks.push(...piece.blocks)
      continue
    }
    // 片尾还开着跨行结构时，桩会被吞进去：不补
    const tailOpen = piece.nodes.some((n) => n.position?.end.offset === slice.length && n.type === 'code' || n.type === 'html' || n.type === 'math')
      && swallowsTrailingBlank({ ...piece, end: piece.end }, text + '\n')
    if (tailOpen) {
      blocks.push(...piece.blocks)
      continue
    }
    const stub = [stubText(linkIds, 'link'), stubText(footnoteIds, 'footnote')].filter(Boolean).join('\n')
    const parsed = slice + '\n\n' + stub + '\n'
    const nodes = parseTree(parsed)
    const reparsed = blocksFromNodes(nodes, text, piece.start, slice.length)
    blocks.push(...(reparsed ?? piece.blocks))
  }
  return blocks
}

/** 整篇解析（改造前的实现），只供测试做 oracle，不从 index 导出。 */
export function parseBlocksWhole(text: string): BlockView[] {
  return parseBlocksOriginal(text)
}

export { parseBlocksChunked }

/**
 * 分块解析。与整篇解析严格等价（chunk.test.ts）。
 * opts.target 调小可强制多切，测试用。
 */
function parseBlocksChunked(text: string, opts?: ChunkOptions): BlockView[] {
  if (text.length === 0) return parseBlocksOriginal(text)
  const target = opts?.target ?? DEFAULT_TARGET
  const { pieces, defs } = firstPass(text, target)
  const blocks = secondPass(text, pieces, defs)
  return mergeDetailsBlocks(blocks, text)
}

// ---------------------------------------------------------------------------
// 增量解析（A3 的时间片驱动用）
// ---------------------------------------------------------------------------

export interface ChunkReplacement {
  /** 被替换的片在全文中的 [start, end)。 */
  start: number
  end: number
  blocks: BlockView[]
}

export interface ChunkStepResult {
  /** 本步新解析出的块，接在已返回的块之后。 */
  append: BlockView[]
  /** 接缝合并：调用方先删掉此前已返回的最后这么多个块，再接 append。 */
  retract: number
  /** 第二遍补桩：按原文区间换掉已经返回的块。 */
  replacements: ChunkReplacement[]
  done: boolean
}

export interface ChunkedParser {
  /**
   * 推进解析。budgetMs > 0 时解析到预算用完；budgetMs <= 0 时恰好推进一片
   * （吞尾合并算一片）。
   */
  step(budgetMs: number): ChunkStepResult
  /** 第一遍与第二遍都完成。 */
  readonly done: boolean
  /** 全篇定义集（第一遍完成后才完整）。 */
  readonly definitions: DefinitionSet
}

/** 增量解析结束后跑一次 details 合并，结果才与 parseBlocks 对齐。 */
export function finalizeChunkedBlocks(blocks: BlockView[], text: string): BlockView[] {
  return mergeDetailsBlocks(blocks, text)
}

/**
 * 增量解析器。step 多次的结果拼接 === parseBlocksChunked 一次性的结果。
 * 第二遍（定义补桩）在第一遍全部完成后才开始。
 */
export function createChunkedParser(text: string, opts?: ChunkOptions): ChunkedParser {
  const target = opts?.target ?? DEFAULT_TARGET
  const splits = text.length === 0 ? [] : findSafeSplits(text, target)
  const bounds = text.length === 0 ? [0, 0] : [0, ...splits, text.length]
  const defs = emptyDefinitionSet()
  const pieces: Piece[] = []
  let index = 0
  let pass: 'first' | 'second' | 'done' = 'first'
  let secondIndex = 0

  return {
    definitions: defs,
    get done() {
      return pass === 'done'
    },
    step(budgetMs: number): ChunkStepResult {
      const start = performance.now()
      const one = budgetMs <= 0
      const out: BlockView[] = []
      const replacements: ChunkReplacement[] = []
      let retract = 0
      let worked = 0
      const over = () => (budgetMs > 0 && performance.now() - start >= budgetMs) || (one && worked >= 1)

      if (pass === 'first') {
        while (index < bounds.length - 1 && !over()) {
          const a = bounds[index]!
          const b = bounds[index + 1]!
          index++
          if (a === b) continue
          let piece = parsePiece(text, a, b)
          // 吞尾：与下一片合并（合并可能跨越多片，直到不再吞）。还没交给调用方，不用 retract。
          while (index < bounds.length - 1 && swallowsTrailingBlank(piece, text)) {
            piece = parsePiece(text, piece.start, bounds[index + 1]!)
            index++
          }
          // 接缝：与上一片是同一个列表 → 撤回上一片的块，合并
          const prev = pieces.at(-1)
          if (prev && splitsAList(prev, piece) && opts?.canRetract?.(prev.blocks) !== false) {
            const merged = parsePiece(text, prev.start, piece.end)
            pieces.pop()
            const drop = prev.blocks.length
            if (out.length >= drop) out.splice(out.length - drop, drop)
            else {
              retract += drop - out.length
              out.length = 0
            }
            piece = merged
          }
          walkDefinitions(piece.nodes, defs)
          pieces.push(piece)
          out.push(...piece.blocks)
          worked++
        }
        if (index >= bounds.length - 1) pass = 'second'
      }

      if (pass === 'second' && !over()) {
        // 第二遍需要全篇定义集，所以只在第一遍完成后运行
        while (secondIndex < pieces.length && !over()) {
          const piece = pieces[secondIndex]!
          secondIndex++
          worked++
          const replaced = reparsing(text, piece, defs)
          if (replaced) {
            piece.blocks = replaced
            replacements.push({ start: piece.start, end: piece.end, blocks: replaced })
          }
        }
        if (secondIndex >= pieces.length) pass = 'done'
      }
      return { append: out, retract, replacements, done: pass === 'done' }
    },
  }
}

/**
 * 一片 / 一块需要的桩：只补「别处有定义、自己没有」的引用。没有就返回空串。
 * 供单块重解析（parseBlockRoots）复用。
 */
export function stubForSlice(slice: string, defs: DefinitionSet, own: DefinitionSet = emptyDefinitionSet()): string {
  const linkIds: string[] = []
  const footnoteIds: string[] = []
  for (const ref of candidateRefs(slice)) {
    if (ref.startsWith('^')) {
      const id = ref.slice(1)
      if (defs.footnotes.has(id) && !own.footnotes.has(id)) footnoteIds.push(id)
    } else if (defs.links.has(ref) && !own.links.has(ref)) linkIds.push(ref)
  }
  return [stubText(linkIds, 'link'), stubText(footnoteIds, 'footnote')].filter(Boolean).join('\n')
}

function reparsing(text: string, piece: Piece, defs: DefinitionSet): BlockView[] | null {
  const slice = text.slice(piece.start, piece.end)
  const own = emptyDefinitionSet()
  walkDefinitions(piece.nodes, own)
  const stub = stubForSlice(slice, defs, own)
  if (!stub) return null
  const nodes = parseTree(slice + '\n\n' + stub + '\n')
  return blocksFromNodes(nodes, text, piece.start, slice.length)
}

import { parseBlocksOriginal } from './parse.ts'
