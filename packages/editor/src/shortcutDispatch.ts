// 全局键盘快捷键到底触发哪个动作：**判定表**是纯的，DOM/状态探测留给调用方。
//
// 与 menuTarget.ts 同一套路：难点全在**优先级与让位关系**，错了界面不报错——
// 只是"某个键没反应"或"两个动作同时发生"（Windows 上 Ctrl+E 既加粗又切档那类）。
// 规则一旦纯了，就能在服务器上注入假输入直接测，不需要浏览器。
//
// 顺序（改这里之前先想清楚谁该让位给谁）：
//   1. 块级撤销（仅当编辑器未聚焦——聚焦时 ⌘Z 是 CM 的文字撤销）
//   2. Esc 退出编辑 / ⌘S 保存 / ⇧⌘S 另存（不检查 defaultPrevented：
//      这几个不是 CM 的键位，冒泡到这里时不应已被别处消费）
//   3. 文档与视图快捷键（检查 defaultPrevented：聚焦块里的裸 CM 会接管
//      自己认识的键并 preventDefault——Ctrl+E 行内代码、Ctrl+B 粗体…——
//      本表挂在 window 冒泡阶段，不守卫就会和 CM 抢同一次按键）
//
// 调用方（appBindings.ts）只负责把事件与编辑器状态翻译成字段，并执行返回的动作。
export interface ShortcutHints {
  /** 主修饰键：mac 的 ⌘ 或 Windows / Linux 的 Ctrl */
  mod: boolean
  shift: boolean
  /** 事件的 `KeyboardEvent.key`（Shift 下字母是大写） */
  key: string
  /** 事件到 window 时是否已被消费者 preventDefault（见上第 3 条） */
  defaultPrevented: boolean
  /** 有聚焦块（裸 CM 已挂） */
  focusedBlock: boolean
  /** 编辑器实例存在（可能存在但尚未聚焦） */
  editorMounted: boolean
  /** 当前打开着一份文件 */
  hasSource: boolean
}

export type ShortcutAction =
  | { kind: 'undo-block' }
  | { kind: 'leave-edit' }
  | { kind: 'save-as' }
  | { kind: 'save' }
  | { kind: 'open' }
  | { kind: 'reload' }
  | { kind: 'close-file' }
  | { kind: 'close-window' }
  | { kind: 'toggle-outline' }
  | { kind: 'open-settings' }
  | { kind: 'ui-zoom'; dir: 1 | -1 | 0 }
  | { kind: 'font-size'; dir: 1 | -1 | 0 }
  | { kind: 'find' }
  | { kind: 'shortcuts' }
  | { kind: 'cycle-mode' }
  | { kind: 'set-mode'; index: 0 | 1 | 2 }

export function resolveShortcut(h: ShortcutHints): ShortcutAction | null {
  const key = h.key
  const lower = key.toLowerCase()

  // 1) 块级撤销：只有没聚焦编辑器时才接管 ⌘Z（编辑器里那是 CM 的文字撤销）
  if (h.mod && !h.shift && lower === 'z' && !h.focusedBlock && !h.editorMounted) {
    return { kind: 'undo-block' }
  }

  // 2) 不检查 defaultPrevented 的一组（见文件头第 2 条）
  if (key === 'Escape' && h.focusedBlock) return { kind: 'leave-edit' }
  if (h.mod && h.shift && lower === 's') return { kind: 'save-as' }
  if (h.mod && lower === 's') return { kind: 'save' }
  // 键位表：⌘/ 是通用写法（Slack / Linear），? 是 GitHub / Gmail 那一派，F1 照顾 Windows。
  // ? 只在**没聚焦编辑块**时才接管——否则用户在块里打不出问号（同块级撤销的守卫）。
  if (h.mod && !h.shift && key === '/') return { kind: 'shortcuts' }
  if (!h.mod && key === '?' && !h.focusedBlock) return { kind: 'shortcuts' }
  if (key === 'F1') return { kind: 'shortcuts' }

  // 3) 文档与视图快捷键
  if (h.defaultPrevented) return null
  if (!h.mod) return null

  // ⌘O 打开
  if (!h.shift && key === 'o') return { kind: 'open' }
  // ⌘R 从磁盘重载
  if (!h.shift && key === 'r') return { kind: 'reload' }
  // ⌘W 有文档 = 关闭文件回首页（首页是「最近打开」的唯一入口）；无文档 = 关窗
  if (!h.shift && lower === 'w') {
    return h.hasSource ? { kind: 'close-file' } : { kind: 'close-window' }
  }
  // ⌘⇧O 大纲
  if (h.shift && lower === 'o') return { kind: 'toggle-outline' }
  // ⌘, 设置
  if (!h.shift && key === ',') return { kind: 'open-settings' }

  // ⌘/Ctrl + = - 0 → **界面缩放**（浏览器与各应用的通用约定，演示时一按就大）
  // ⇧⌘/⇧Ctrl + = - 0 → 正文字号（只改正文）
  // 换位之前 ⌘+ 改的是正文字号：在「投屏给别人看」这个场景下，用户想要的是整个
  // 界面变大，而不是只有正文——按惯例把它让给界面缩放，正文字号仍留着 shift 变体。
  if (!h.shift && (key === '=' || key === '+')) return { kind: 'ui-zoom', dir: 1 }
  if (!h.shift && key === '-') return { kind: 'ui-zoom', dir: -1 }
  if (!h.shift && (key === '0' || key === ')')) return { kind: 'ui-zoom', dir: 0 }
  if (h.shift && (key === '+' || key === '=' || key === '*')) return { kind: 'font-size', dir: 1 }
  if (h.shift && (key === '_' || key === '-')) return { kind: 'font-size', dir: -1 }
  if (h.shift && (key === ')' || key === '0')) return { kind: 'font-size', dir: 0 }

  // ⌘F 查找
  if (key === 'f') return { kind: 'find' }
  // ⌘E 循环 read → edit → source → read
  if (!h.shift && key === 'e') return { kind: 'cycle-mode' }
  // ⌘1/2/3 直选档位——循环要按很多次才能到位，直选不用
  if (!h.shift && (key === '1' || key === '2' || key === '3')) {
    return { kind: 'set-mode', index: (Number(key) - 1) as 0 | 1 | 2 }
  }
  return null
}
