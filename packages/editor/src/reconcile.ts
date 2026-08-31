/** keyed 对齐计划：按 IR 顺序，并标出 DOM 里多余的旧节点。 */
export function reconcileKeyedOrder(
  existingIds: readonly string[],
  desiredIds: readonly string[],
): { order: string[]; remove: string[] } {
  const desired = new Set(desiredIds)
  return {
    order: [...desiredIds],
    remove: existingIds.filter((id) => !desired.has(id)),
  }
}

/**
 * 把 parent 的子节点按 desired 顺序重排；不在 desired 里的节点删除。
 * desired 中尚不在 parent 里的节点会被 insertBefore 进去。
 */
export function applyKeyedChildren(parent: HTMLElement, desired: HTMLElement[]): void {
  const keep = new Set(desired)
  for (const child of [...parent.children]) {
    if (!keep.has(child as HTMLElement)) child.remove()
  }
  let anchor: ChildNode | null = parent.firstChild
  for (const el of desired) {
    if (el !== anchor) parent.insertBefore(el, anchor)
    anchor = el.nextSibling
  }
}
