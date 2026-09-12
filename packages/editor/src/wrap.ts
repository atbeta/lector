// 行内格式的包裹/解包：⌘B / ⌘I / ⌘E / ⌘K 的纯逻辑。
//
// 抽成纯函数是为了能测：这类「选中 → 变换 → 光标落点」的逻辑最容易在边界上出错
// （空选区、已包裹、选中内容自带空格、光标在词中间），而它在 UI 上出错只是「有点怪」，
// 不报错、不留痕。纯函数 + 表单测试能把这些边界一次钉死。

export interface WrapResult {
  /** 替换后的整段文本（调用方按 changes 应用也可以，这里给出结果便于测试） */
  text: string
  /** 变换后应当选中的区间（相对新文本） */
  selection: { from: number; to: number }
}

export interface WrapOptions {
  /** 左定界符，如 `**` */
  left: string
  /** 右定界符，默认与左相同 */
  right?: string | undefined
  /**
   * 链接这类「两段式」语法的第二段占位文本。
   * 给了它就按 `[选中](占位)` 处理，并且光标落在占位上（提示用户继续输入）。
   */
  placeholder?: string | undefined
}

/** 判断位置是否落在单词字符上（字母/数字/CJK/下划线）。 */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  return /[\p{L}\p{N}_]/u.test(ch)
}

/** 从 pos 向两侧扩到词边界。 */
function wordAt(text: string, pos: number): { from: number; to: number } | null {
  if (!isWordChar(text[pos])) return null
  let from = pos
  let to = pos
  while (from > 0 && isWordChar(text[from - 1])) from--
  while (to < text.length && isWordChar(text[to])) to++
  return from === to ? null : { from, to }
}

/**
 * 包裹或解包选区。
 *
 * 行为（与主流编辑器一致，用户不必学）：
 * - 有选区且已被定界符包住 → 解包
 * - 有选区 → 包裹，选中内容保持选中
 * - 无选区但光标在词内 → 包裹整个词并选中它（省掉「先选再按」）
 * - 无选区且不在词内 → 插入一对定界符，光标落在中间
 *
 * 两段式（链接）：`[选中](占位)`，光标落在占位上，选中内容保持。
 */
export function toggleWrap(
  text: string,
  from: number,
  to: number,
  opts: WrapOptions,
): WrapResult {
  const { left, placeholder } = opts
  const right = opts.right ?? left

  // ── 两段式：链接 ──
  if (placeholder !== undefined) {
    // 已经是链接形式 `[x](y)` 且选区正好在里面 → 只选中 URL 部分，方便改
    const around = text.slice(Math.max(0, from - 1), Math.min(text.length, to + 1))
    const selected = text.slice(from, to)
    const linkMatch = selected.match(/^\[([^\]]*)\]\(([^)]*)\)$/)
    if (linkMatch) {
      const urlFrom = from + linkMatch[1]!.length + 3 // `[` + 文本 + `](`
      return { text, selection: { from: urlFrom, to: urlFrom + linkMatch[2]!.length } }
    }
    const label = selected || '链接文字'
    const inner = `[${label}](${placeholder})`
    const urlFrom = from + label.length + 3
    void around
    return {
      text: text.slice(0, from) + inner + text.slice(to),
      // 光标一律落到 URL 占位：选中文字后按 ⌘K，用户接下来要做的就是「给个地址」，
      // 继续选中原文字只会让他多按一次方向键。
      selection: { from: urlFrom, to: urlFrom + placeholder.length },
    }
  }

  // ── 空选区：词内包裹 ──
  let sFrom = from
  let sTo = to
  if (from === to) {
    const w = wordAt(text, from)
    if (!w) {
      // 不在词里：插一对定界符，光标落到中间
      const inner = `${left}${right}`
      return {
        text: text.slice(0, from) + inner + text.slice(to),
        selection: { from: from + left.length, to: from + left.length },
      }
    }
    sFrom = w.from
    sTo = w.to
  }

  const selected = text.slice(sFrom, sTo)

  // ── 已包裹 → 解包 ──
  const outerFrom = sFrom - left.length
  const outerTo = sTo + right.length
  const wrappedOutside =
    outerFrom >= 0 &&
    outerTo <= text.length &&
    text.slice(outerFrom, sFrom) === left &&
    text.slice(sTo, outerTo) === right
  if (wrappedOutside) {
    const inner = text.slice(sFrom, sTo)
    return {
      text: text.slice(0, outerFrom) + inner + text.slice(outerTo),
      selection: { from: outerFrom, to: outerFrom + inner.length },
    }
  }

  // ── 选区自带定界符 → 解包（用户把标记一起选进来了） ──
  if (selected.length >= left.length + right.length) {
    const startsWith = selected.startsWith(left)
    const endsWith = selected.endsWith(right)
    // 单字符定界符（`*`）要避免把「**粗体**」误判成斜体标记：
    // 只有左右都匹配且去掉后仍非空才算
    if (startsWith && endsWith) {
      const inner = selected.slice(left.length, selected.length - right.length)
      if (inner.length > 0) {
        return {
          text: text.slice(0, sFrom) + inner + text.slice(sTo),
          selection: { from: sFrom, to: sFrom + inner.length },
        }
      }
    }
  }

  // ── 包裹 ──
  const next = `${left}${selected}${right}`
  return {
    text: text.slice(0, sFrom) + next + text.slice(sTo),
    selection: { from: sFrom + left.length, to: sFrom + left.length + selected.length },
  }
}

/**
 * 代码围栏展开：在 ``` 之后回车生成一个空代码块，光标进到块内。
 * 返回 null 表示不该处理（当前行不是孤立围栏）。
 */
export function expandFence(
  text: string,
  pos: number,
  fenceCountBefore: number,
): { text: string; cursor: number } | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = text.indexOf('\n', pos)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
  if (pos !== lineStart + line.length) return null
  if (!/^\s*```\s*$/.test(line)) return null
  // 前面的围栏数是奇数 = 当前这行是闭合符，不展开
  if (fenceCountBefore % 2 !== 0) return null
  const indent = line.match(/^\s*/)?.[0] ?? ''
  const insert = `\n${indent}\n${indent}\`\`\``
  return { text: text.slice(0, pos) + insert + text.slice(pos), cursor: pos + 1 + indent.length }
}
