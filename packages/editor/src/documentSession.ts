import type { BlockView, SourceDocument } from '@lector/core'

export interface DocumentSession {
  source: SourceDocument | null
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean
  /** 插入/删除块后，即使各块 raw 未改也算脏。 */
  structuralDirty: boolean
  /** 写盘进行中：状态行据此显示「保存中…」。 */
  saving: boolean
  /** 本次会话最近一次成功保存的时刻（ms）；null = 还没存过，状态行用静态文案。 */
  savedAt: number | null
  /** 解析时的原始 raw，用于判定 dirty（还原到原文即不算脏）。 */
  originals: Map<string, string>
}

export function createDocumentSession(): DocumentSession {
  return {
    source: null,
    blocks: [],
    focusedId: null,
    dirty: false,
    structuralDirty: false,
    saving: false,
    savedAt: null,
    originals: new Map(),
  }
}
