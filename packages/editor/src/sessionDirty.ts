/** 任一块 dirty，或发生过插入/删除块，都算文档脏。 */
export function sessionIsDirty(
  blocks: ReadonlyArray<{ dirty: boolean }>,
  structuralDirty: boolean,
): boolean {
  return structuralDirty || blocks.some((b) => b.dirty)
}
