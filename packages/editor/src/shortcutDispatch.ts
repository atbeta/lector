// 全局键盘快捷键到底触发哪个动作：**判定表**是纯的，DOM/状态探测留给调用方。
//
// 与 menuTarget.ts 同一套路：难点全在**优先级与让位关系**，错了界面不报错——
// 只是"某个键没反应"或"两个动作同时发生"（Windows 上 Ctrl+E 既加粗又切档那类）。
// 规则一旦纯了，就能在服务器上注入假输入直接测，不需要浏览器。
//
// 顺序（改这里之前先想清楚谁该让位给谁）：
//   1. 块级撤销（仅当编辑器未聚焦、且焦点不在普通文本框——聚焦时 ⌘Z 是
//      CM 的文字撤销，文本框里它是框内内容的原生撤销）
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
  /**
   * 焦点在普通文本控件（查找框、设置输入框、contenteditable）。
   * ⌘Z 归框内原生撤销：抢过来撤销文档，等于「改个查询词，整篇被回滚」。
   */
  focusInTextField: boolean
  /** 当前打开着一份文件 */
  hasSource: boolean
}

export type ShortcutAction =
  | { kind: 'undo-block' }
  | { kind: 'redo-block' }
  | { kind: 'leave-edit' }
  | { kind: 'save-as' }
  | { kind: 'save' }
  | { kind: 'new-document' }
  | { kind: 'open' }
  | { kind: 'reload' }
  | { kind: 'close-file' }
  | { kind: 'close-window' }
  | { kind: 'toggle-outline' }
  | { kind: 'open-settings' }
  | { kind: 'ui-zoom'; dir: 1 | -1 | 0 }
  | { kind: 'font-size'; dir: 1 | -1 | 0 }
  | { kind: 'find' }
  | { kind: 'insert-paragraph-after' }
  | { kind: 'shortcuts' }
  | { kind: 'cycle-mode' }
  | { kind: 'set-mode'; index: 0 | 1 | 2 }

export function resolveShortcut(h: ShortcutHints): ShortcutAction | null {
  const key = h.key
  const lower = key.toLowerCase()

  // 1) 撤销：焦点不在编辑面、也不落在文本框里时才接管 ⌘Z
  //    （编辑面里那是 CM 的文字撤销；文本框里是框内内容的原生撤销）
  //
  //    判据是 `editorMounted`（= 编辑面存在**且** DOM 焦点在它里面），不是
  //    `focusedBlock`（= 会话里有一个聚焦块）。两者不是一回事：点一下状态行
  //    或侧栏，块仍然是聚焦块，但按键已经落到 body 上——用 focusedBlock 当守卫
  //    会把这种情况下的 ⌘Z / ⇧⌘Z 一起挡死，用户看到的就是「重做键完全没反应」。
  if (h.mod && !h.shift && lower === 'z' && !h.editorMounted && !h.focusInTextField) {
    return { kind: 'undo-block' }
  }
  // 重做同一组守卫：⇧⌘Z 是 mac / 各平台通用约定，Ctrl+Y 是 Windows / Linux 的惯例。
  // ⇧⌘Y 不算重做键，不收。
  if (
    h.mod &&
    ((h.shift && lower === 'z') || (!h.shift && lower === 'y')) &&
    !h.editorMounted &&
    !h.focusInTextField
  ) {
    return { kind: 'redo-block' }
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

  // ⌘N 新建（自带脏确认）
  if (!h.shift && key === 'n') return { kind: 'new-document' }
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

  // ⌘⇧↵ 在当前块下方插入一个段落
  //
  // 为什么是 ⌘⇧↵ 而不是 ⌘↵：⌘↵（Mod-Enter）被 CodeMirror 的默认键位
  // 占着（插入新行并缩进），在聚焦块里会先被 CM 吃掉。⌘⇧↵ 无人绑定，
  // 也是各编辑器「在下面插一行」的通用约定。
  //
  // 锚点是**当前聚焦的块**，不是鼠标位置——插入点跟文档结构走。
  // 没有聚焦块时不做：用户没说要在哪儿插，猜一个位置会插错地方。
  if (h.shift && h.focusedBlock && key === 'Enter') return { kind: 'insert-paragraph-after' }
  // ⌘E 循环 read → edit → source → read
  if (!h.shift && key === 'e') return { kind: 'cycle-mode' }
  // ⌘1/2/3 直选档位——循环要按很多次才能到位，直选不用
  if (!h.shift && (key === '1' || key === '2' || key === '3')) {
    return { kind: 'set-mode', index: (Number(key) - 1) as 0 | 1 | 2 }
  }
  return null
}
