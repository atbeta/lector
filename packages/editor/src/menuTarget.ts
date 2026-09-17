// 右键到底该给哪套菜单：**判定表**是纯的，DOM 探测留给调用方。
//
// 为什么值得单独拆出来：
//   - 这块逻辑的全部难度在**优先级**，而优先级出错时界面不报错——它只是弹出
//     一份"看着挺合理"的菜单（或者干脆什么都不弹），非常难察觉。这一轮修复的
//     「输入框要先于正文判断」「非正文表面一律放行」「顶栏文件名优先」都是规则问题。
//   - 规则一旦纯了，就能像 blockOperations.test.ts 那样注入假输入直接测——
//     不需要浏览器，在服务器上也能跑。
//
// 调用方（documentMenus.ts）只负责把 `closest()` 的结果翻译成这里的字段，
// 不去判断"该给哪套"；判断只发生在这一个函数里。
//
// 顺序（改这里之前先想清楚谁该压过谁）：
//   顶栏文件名 > 块内编辑器 > 输入控件 > 正文内容（图/链/任务/块/留白）
//   之外还有两条兜底：选中了文字给「复制」；都没有就什么都不弹。
// 第 4 条带 `hasSource`：没有打开文件时 `#content` 是空态/加载态，那些不是文档内容。
export interface MenuHints {
  /** 落在顶栏文件名上（文件级动作：打开方式 / 显示位置 / 复制路径 / 关闭文件） */
  inTitlebarTitle: boolean
  /** 落在聚焦块的裸 CodeMirror 里（撤销/剪切/复制/粘贴/全选） */
  inEditor: boolean
  /** 落在输入控件里（含正文之外的设置项）——必须排在第 4 条之前：
   *  设置面板整块都在 DOM 里，把输入框当正文会让"粘贴"变成"插入段落"。 */
  inField: boolean
  /** 落在 #content 里 */
  inContent: boolean
  /** 当前真的打开着一份文件（空态/加载态不算） */
  hasSource: boolean
  /** 落在 .reading-prose 里（预览正文；块的包裹层不算） */
  inProse: boolean
  /** 目标本身就是 <img> */
  isImage: boolean
  /** 最近的 <a> 的 href；没有链接就是 null */
  linkHref: string | null
  /** 落在 li.task 上，且能定位到它所属的块（定位不到就当没命中） */
  inTask: boolean
  /** 落在某个 .block 上 */
  inBlock: boolean
  /** 当前有非空选区 */
  hasSelection: boolean
}

export type MenuDecision =
  | { kind: 'titlebar' }
  | { kind: 'editor' }
  | { kind: 'field' }
  | { kind: 'image' }
  | { kind: 'link'; href: string }
  | { kind: 'task' }
  | { kind: 'block' }
  | { kind: 'blankArea' }
  | { kind: 'copySelection' }
  | { kind: 'none' }

export function resolveMenuDecision(h: MenuHints): MenuDecision {
  if (h.inTitlebarTitle) return { kind: 'titlebar' }
  if (h.inEditor) return { kind: 'editor' }
  if (h.inField) return { kind: 'field' }

  if (h.inContent && h.hasSource) {
    // 图先于链：图片常常包在链接里，点在图上要的是「另存/复制图片」，不是「打开链接」
    if (h.isImage && h.inProse) return { kind: 'image' }
    if (h.linkHref !== null && h.inProse) return { kind: 'link', href: h.linkHref }
    if (h.inTask) return { kind: 'task' }
    if (h.inBlock) return { kind: 'block' }
    return { kind: 'blankArea' }
  }

  // 正文之外：选中了文字才给东西（设置里的说明、侧栏、状态行都能选中复制）
  if (h.hasSelection) return { kind: 'copySelection' }
  return { kind: 'none' }
}
