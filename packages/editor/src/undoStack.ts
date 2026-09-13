/**
 * 有界撤销栈。
 *
 * 块级操作（删块、插段、勾选任务）不在 CodeMirror 的历史里：CM 每次只挂一个块，
 * 而删掉一整块、在块间插一段，是跨块的结构改动，一个块的 CM 表达不了。
 * 所以在编辑器之外自己记一份：每项是「怎么退回去」的闭包 + 一句给用户看的话。
 *
 * 记闭包而不是记快照：闭包能带上操作发生时的位置和对象身份，
 * 退回去时不必猜「当时它是第几块」。
 */

export interface UndoEntry {
  /** 给用户看的回执，如「已恢复删除的块」。 */
  label: string
  /** 把这次操作退回去。执行前后由调用方负责重新渲染。 */
  undo: () => void
}

export interface UndoStack {
  /** 压入一次可撤销的操作。 */
  push(label: string, undo: () => void): void
  /** 弹出并执行最后一次操作，返回它的 label；栈空时返回 null。 */
  undo(): string | null
  /** 丢弃全部历史（换文档时用）。 */
  clear(): void
  /** 当前可撤销的次数。 */
  size(): number
}

/**
 * 建一个撤销栈。
 *
 * 上限默认 20：够覆盖「一路改下来发现改错了」的深度，
 * 又不会在长会话里攥住已经没人记得的旧块不放。
 */
export function createUndoStack(max = 20): UndoStack {
  const limit = Math.max(1, Math.floor(max))
  const entries: UndoEntry[] = []
  return {
    push(label, undo) {
      entries.push({ label, undo })
      if (entries.length > limit) entries.shift()
    },
    undo() {
      const entry = entries.pop()
      if (!entry) return null
      entry.undo()
      return entry.label
    },
    clear() {
      entries.length = 0
    },
    size() {
      return entries.length
    },
  }
}
