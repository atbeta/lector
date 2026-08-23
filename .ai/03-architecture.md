# 架构方案（推荐）

## 总览

```
磁盘 .md  ──读──►  SourceBuffer（原文，只读一份）
                      │
                      ▼
              micromark → mdast（带 position）
                      │
                      ▼
              BlockView[]   raw = source.slice(start, end)
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
     未聚焦：Preview          聚焦：CodeMirror 6
     (mdast → DOM)           (只编这一块的 raw)
          │                       │
          │                  用户改字 → dirty=true
          │                       │
          └───────────┬───────────┘
                      ▼
              serialize：脏块 stringify 或采用 CM 文本
                         净块用原始 raw
                      ▼
                 写回同一路径
```

**内核不变量：** 未编辑块的 `raw` 字节（或 Unicode 码位切片，见下）在保存时原样输出。整篇 `remark-stringify` 禁止作为默认保存。

## 核心类型（建议锁定）

```ts
/** 打开后的不可变原文。保存时只在脏区间替换。 */
export interface SourceDocument {
  path: string
  encoding: 'utf-8'
  /** 打开时的全文。换行统一记为 { newline: '\n' | '\r\n' }，写回还原。 */
  text: string
  newline: '\n' | '\r\n'
  mtimeMs: number
}

export type BlockKind =
  | 'paragraph' | 'heading' | 'list' | 'code' | 'blockquote'
  | 'thematicBreak' | 'html' | 'yaml' | 'table' | 'unknown'

export interface BlockView {
  id: string
  kind: BlockKind
  /** 在 SourceDocument.text 中的 [start, end)（JS 字符串下标） */
  start: number
  end: number
  /** 打开时切下的原文，净块保存用这个 */
  raw: string
  /** mdast 节点（预览用）。脏了以后可重 parse 这一块 */
  mdast: unknown
  dirty: boolean
}

export interface EditorSession {
  source: SourceDocument
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean // 任一块 dirty 或结构变化（插入/删除块）
}
```

换行：读盘时检测 `\r\n` vs `\n`，内存统一 `\n`，写回按 `newline` 还原。BOM 若存在则写回保留。

## 解析

- `mdast-util-from-markdown` + micromark
- 扩展：`micromark-extension-gfm`（可分期）、`micromark-extension-frontmatter`、日后 math
- 用每个 **root child** 的 `position` 切片成 `BlockView`
- `position` 缺失的节点（部分扩展）并入 `unknown`，整段当一块 raw，预览降级为源码或转义文本，**不要丢**
- 相邻 YAML frontmatter 单独成块，预览可折成「属性」条，编辑仍是源码

列表：GFM 里一个 `list` 是一块还是每项一块？

- **v1 建议：整个 list 一块。** 减少焦点跳变；项内换行/嵌套在 CM 里编。
- 勾任务：预览态可点 checkbox → 只改这一块 raw 里对应 `- [ ]` / `- [x]`，标 dirty。不要为此上 PM。

## 预览

自绘，不要走整页 CM。

- 标题 / 段落 / 行内：mdast → 轻量 DOM 渲染（原生 DOM 或极轻框架；行内 `emphasis`/`strong`/`link`/`inlineCode`/`image`）
- 图片 `src`：相对路径经壳协议解析到 md 目录（禁止 `file://` 直打任意盘；只允许 md 目录树内，防穿越，逻辑同 NoteFast `readLocalImageCandidate`）
- 代码块：高亮用轻量库（Shiki 或 highlight.js），不要为预览起 LSP
- HTML 块：v1 预览显示为源码块（安全）；不要 `dangerouslySetInnerHTML` 任意 HTML
- 未知块：等宽源码

样式：自建 token，浅色默认。不要 Google Fonts 外链。可借鉴 NoteFast 的阅读排版感觉，但**不要依赖 NoteFast 包**（复制 token 值可以，不要 workspace 引用）。

**阅读优先的排版是核心卖点**：字体栈、行宽（~70 字符）、行高、中西文混排、段落间距、大纲浮窗，按阅读器标准打磨，不是编辑器附属品。

## 焦点块 = CodeMirror 6

- 文档 = 该块 `raw`（若 dirty 则用上次 CM 文档）
- **禁止** image/table/math 的 `Decoration.replace`
- 允许：markdown 语法高亮、括号、最少 keymap（⌘B 等可后做）
- 中文 IME：这是普通 CM，无 widget
- Escape / 点预览其他块：把 CM 文本写回 `raw`，`dirty = (raw !== originalRaw)`，失焦
- 在块末回车「再开一段」：分裂块（当前块截断 + 插入新 paragraph）。这是结构变化，要测

块级 keymap（v1 就要）：

- 空段落里 Backspace 到块首：与上块合并
- 标题行 `Enter`：下插一段落
- `` ``` `` 语言行行为可后做

## 保存

```
function serialize(session: EditorSession): string {
  return session.blocks.map(b => b.dirty ? normalizeBlockRaw(b) : b.raw).join('')
}
```

注意 **块之间的缝**：mdast 的 position 一般含块尾换行。切片必须 **无缝覆盖全文**（`blocks[0].start === 0`，`blocks[i].end === blocks[i+1].start`，`last.end === text.length`）。若解析器在块间留下空隙，把空隙做成 `unknown` 块，不要丢掉空行——Typora 用户靠空行分段。

`normalizeBlockRaw`：脏块用 CM 文本；确保块尾换行约定与邻居一致（通常每块自带结尾 `\n`，最后一块按原文是否以换行结束）。

写盘：原子写（写 temp + rename），避免崩一半。Windows 注意同目录 replace。

外部修改：保存前比 `mtimeMs`；冲突则提示「磁盘已变，覆盖 / 重新加载」。

## 打开路径（秒开）

```
OS 双击 → 壳拿到路径 → 单进程内查路径表
  → 该文件已开？聚焦已有窗口（完成）
  → 否则创建窗口
  → Web 已就绪？
       是：postMessage({ type: 'open', path })
       否：pendingPath，bundle 加载完再 open
  → readFile（Tauri fs）
  → 先把全文塞进「纯文本降级层」（可选，<50ms）
  → parse + 建 BlockView（普通文 <50ms）
  → 切 IR
```

没有：homepage、splash、engine handshake、导入 API、inbox、Tab。

最近列表：`{ path, title, openedAt }[]` 写用户目录一个 json。title 取文件名或首个 H1。

## 窗口模型

- **单进程多窗口**，一个窗口 = 一个 `EditorSession`，状态天然隔离
- 无应用内 Tab；macOS 系统级「合并所有窗口」可白嫖 Tab 体验
- 窗口间不共享编辑器状态；「最近打开」json 由壳单点读写
- 同一文件只开一个窗口（路径表去重），规避双开抢文件

## 图片

| 动作 | 行为 |
|---|---|
| 打开已有 `![](a.png)` | 预览读 md 同目录，不复制 |
| 粘贴位图 | 存 `./images/pasted-YYYYMMDD-HHMMSS.png`，插入相对路径 |
| 拖入图片文件 | 拷到 `./images/`（或用户选「引用原路径」——v1 只拷，避免原盘移动后碎图） |
| 网络图 `https://` | 预览走 http；不下载进库 |

Windows：粘贴写新文件会触杀软，这是用户动作，可接受。打开旧文不写 media。

## 与 NoteFast 配套（后做，预留口）

```
POST {notefast}/api/v1/import/markdown
{ markdown, title, status: 'inbox', source: { provider: 'lector', external_id: <file path> } }
```

本应用只当 HTTP 客户端。Token / 实例地址放本机设置。失败则提示，不重试成库。

不要在 v1 做。接口放 `companion.ts` 空实现即可。

## 进程与包

```
repo/
  packages/core      # SourceDocument, parse, serialize, BlockView — 无 DOM
  packages/editor    # IR 视图 + 聚焦块 CM，可 vite 单独打开
  packages/shell-web # 菜单绑定、打开保存、最近、窗口协调
  clients/tauri      # Tauri 2 薄壳（macOS + Windows）
```

`core` 必须能在 bun test 里做：parse 切片覆盖、未编辑保存恒等、脏一块只动一块。

包管理：Bun。钉版本。不要从 NoteFast monorepo workspace 链过来。

## 安全

- 本地 md 目录外的相对路径 `../`：预览拒绝（碎图 + 日志），保存不改用户源码
- 不执行 md 里的 HTML/script
- 自定义协议只映射已打开文件的 baseDir
- 无 Node 集成到页面全局；文件 IO 走壳 IPC

## 明确拒绝的架构

1. 整页 CM hybrid（SoloMD 走这条，可行但保真非其目标；我们排除）
2. Milkdown/PM 作为默认文档模型（MarkText/Muya 的往返保真原罪）
3. Vditor 当内核
4. 打开即导入 NoteFast
5. Rust/GPUI 重写 v1
6. Electron「先抄 MarkText」
7. 应用内 Tab / 字面多进程实例
