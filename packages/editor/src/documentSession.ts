import type { BlockView, SourceDocument } from '@lector/core'

export interface DocumentSession {
  source: SourceDocument | null
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean
  /** 插入/删除块后，即使各块 raw 未改也算脏。 */
  structuralDirty: boolean
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
    originals: new Map(),
  }
}
