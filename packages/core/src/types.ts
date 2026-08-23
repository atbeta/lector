/** 打开后的不可变原文契约。换行统一为 '\n'，BOM 单独标记，写回还原。 */
export interface SourceDocument {
  path: string
  /** 打开时的全文，已统一换行为 '\n' 且剥离 BOM。 */
  text: string
  newline: '\n' | '\r\n'
  /** 原文是否以 UTF-8 BOM 开头；写回时按此还原。 */
  hasBom: boolean
  mtimeMs: number
}

export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'code'
  | 'blockquote'
  | 'thematicBreak'
  | 'html'
  | 'yaml'
  | 'table'
  | 'unknown'

export interface BlockView {
  id: string
  kind: BlockKind
  /** 在 SourceDocument.text 中的 [start, end)（JS 字符串下标，按 UTF-16 码元计）。 */
  start: number
  end: number
  /** 打开时切下的原文（'\n' 归一后），净块保存用这个。 */
  raw: string
  /** mdast 节点（预览用）。脏了以后可重 parse 这一块。 */
  mdast: unknown
  dirty: boolean
}

export interface EditorSession {
  source: SourceDocument
  blocks: BlockView[]
  focusedId: string | null
  /** 任一块 dirty 或结构变化（插入/删除块）。 */
  dirty: boolean
}
