# 技术调研

调研日期：2026-08-23（当日更新：MarkText 复活确认、SoloMD 深研）。结论服务「纯本地 md 阅读/编辑器 / 对标 Typora IR / 文件保真」，不是通用富文本选型。

## 1. Typora 实际在做什么

Typora 的「即时渲染」不是左右分栏，也不是在源码上盖一层 CSS。

模型是：

1. 把文档拆成块（段落、标题、列表、代码、表…）
2. **未聚焦的块显示渲染结果**
3. **当前块切成 Markdown 源码**（或极轻的原地编辑）
4. 焦点离开，这块收成预览
5. 磁盘文件仍是 Markdown；保存 = 序列化

这是一棵会切换视图的文档树，不是带妆的 textarea。

CodeMirror / ProseMirror 的官方定位（Marijn）：CM 是文本编辑器，PM 是富文本文档模型；二者不混用同一套 API。用 CM 的 Decoration/Widget 仿 IR，得到的是 NoteFast 已经摸到的天花板：源码还在，图/表/公式是 widget，选区、IME、嵌套结构会漏。

## 2. 四条技术路

### A. 整页 CodeMirror + 装饰（NoteFast hybrid）

- **做法：** 一篇文本，用 `Decoration.replace` 把图/表/公式换成 widget，语法标记用 mark 藏起来。
- **优点：** 实现路径熟；长文虚拟滚动是 CM 的强项。
- **缺点：** 做不出「点哪块、哪块变源码」；IME 与多层 decoration 打架（CM discuss 有 composition/selection 旧伤）；跨块选、任务列表勾选都要桥。
- **备注（2026-08-23 更新）：** SoloMD 走的就是这条路（Tauri 2 + CM6 整页 WYSIWYG），证明工程上可行，但文件保真不是它的设计目标，也不在它的卖点里。我们的定位把保真当命门，结论不变。
- **结论：整页画布排除。** CM 只留给「当前块的源码框」。

### B. ProseMirror / Milkdown / Tiptap

- **做法：** 文档是 PM 树；Milkdown 用 remark 做 md ↔ PM。
- **优点：** 所见即所得手感接近；插件生态大；Milkdown 仍活跃（~1.1 万星）。
- **缺点：**
  - `mdast-util-to-markdown` 自己承认：**完整 round-trip 不可能**（任意 AST 注入后无法还原原文空白、标记风格、硬换行）。
  - 用户打开同事的 Typora 文件，保存后 `*`/`_`、列表符号、表格空格被重写 → 「改了一个字，diff 炸了」。对「替代 Typora」是致命伤。
  - PM 不虚拟化长文（官方明确 out of scope），万行会卡。
  - Safari/WebView 表格内 IME 有已知坑。
- **结论：不作内核。** 日后若做「纯所见即所得模式」可以再评估，不能当默认保存路径。

### C. Vditor（IR 参考实现）

- 浏览器组件，三模式：WYSIWYG / **IR** / 分屏。IR 明确对标 Typora。
- 解析走 **Lute**（中文语境优化，Go / JS），不是 micromark。
- 思源笔记同门，中文输入、任务列表、表在 IR 里能用，适合**对标手感**。
- **不作内核：** 绑定 Lute + 其 DOM 约定；包体与 CDN 历史重；定制「切片保真保存」要跟它的内部模型死磕；桌面文件协议、相对图片、无库定位都要在外壳打补丁。
- **结论：开 IR 原型时当对照，不 npm 进生产内核。**

### D. 自研 IR + 源码切片保真（推荐）

见 [03-architecture.md](./03-architecture.md)。解析用 micromark/mdast（拿 position），每个块记住原文切片；未脏块保存时原样拼回。焦点块用 CM6 编源码。预览用自绘 DOM，不经过 PM。

这是唯一同时满足「像 Typora」和「保存不糟蹋文件」的路。

## 3. 独立 App 竞品（2026-08-23 核实）

| 产品 | 模型 | 2026 状态 | 启示 |
|---|---|---|---|
| Typora | 闭源 IR | 收费（$14.99）、仍是品类标杆 | 手感与大纲/标题内联格式是用户记得住的；它开始管文件是用户流失点 |
| MarkText | Electron + 自研 Muya（文档树 WYSIWYG） | **已复活且活跃**：60.4k 星，v0.20.0-rc.1 @ 2026-07-05，develop 分支持续提交 | 它占「免费写作工具」位；Electron ~150MB、文档树重写文件的抱怨是路线 B 原罪。可读其表格编辑/粘贴转换实现，不要 fork |
| SoloMD | Tauri 2 + Vue 3 + CM6 整页 WYSIWYG | **活跃但已转型**：2026-04 创建，896 星，v4 转向 Agent 平台（MCP/AutoGit/recipes），v4.6 长出知识图谱与白板 | 见 §3.1 |
| Obsidian | 库 + 实时预览 | 活、重 | 用户要的不是这个 |
| VS Code | 分栏预览 | 不是写作 App | 对照「不要做成 IDE」 |
| HyperMD | CM5 WYSIWYM | 已死 | 不要走 CM 装饰这条老路 |

### 3.1 SoloMD 专题：反面教材与市场信号

SoloMD（github.com/zhitongblog/solomd）的轨迹：

- v1–v3：正经的「文件夹上的 Markdown 编辑器」
- **v4.0：转向 Agent 平台**——Agent Panel、YAML 定时 recipes、MCP server（13 工具）、AutoGit 分支沙箱、CLI、REST API、14 家 BYOK、GitHub 同步 + E2EE
- **v4.6：知识图谱**——frontmatter 属性面板、类型驱动侧栏、双向关系、关系图谱、保存视图、Inbox 工作流、tldraw 白板
- 现 slogan：*"The editor where agents live"*——编辑器是 Agent 平台的载体

三条价值：

1. **反面教材**：功能引力真实存在，「编辑器 → Agent 操作系统」只花了 4 个大版本。我们的「不做清单」必须是打回需求的依据。
2. **市场信号**：它全力卷「AI + Markdown 库」，把「专注阅读小工具」的位置彻底让出。
3. **技术参照**：证明 Tauri 2 + Web 内核在小体积下可行（mac 32MB dmg 签名公证齐全）；CJK 编码检测、Windows 光标跳变等边角修复都在公开 commit 里，可免费读。它的 build（Rust + Node/pnpm + `pnpm tauri dev`）也验证了我们栈的常规性。

### 3.2 差异化结论

MarkText 占「写作工具」且被 Electron + 文档树锁死；SoloMD 占「AI 库」；Obsidian 占「知识库」。**「专注阅读小工具」无人防守。** 我们的三件套对方结构性过不来：文本为真（字节级不偷改）、阅读一等公民、轻（Tauri ~10MB vs Electron ~150MB）。

## 4. 解析 / 序列化栈

| 库 | 用途 | 选用 |
|---|---|---|
| **micromark** + **mdast-util-from-markdown** | CommonMark 分词 → mdast，带 `position` | **解析必选** |
| **remark-gfm** / micromark GFM 扩展 | 表、任务列表、删除线、autolink | v1.1 加上；v1 可先不做表 |
| **remark-frontmatter** | `---` YAML | 要：打开不丢 frontmatter |
| **remark-math** | `$` / `$$` | v1.5+ |
| **mdast-util-to-markdown** | AST → md | **只用于脏块**；禁止整篇 stringify |
| markdown-it | 偏 HTML 输出，AST 弱 | 不采用（Milkdown 老路径） |
| Lute | Vditor/思源 | 不采用 |

**保真策略不依赖 stringify 完美。** 依赖 `position` 切片。remark 官方：stringify 尽力而为，完整往返做不到。我们承认这一点，所以默认不走整篇 stringify。

打开后应跑一条黄金测试：随机抽仓库里的真实 md（含 Typora 旧文）→ 打开不改 → 保存 → `Buffer` 相等。失败即 blocker。

## 5. 中文 IME

| 方案 | 风险 |
|---|---|
| 整页 CM + 装饰 | 高（composition 与 mark/replace 叠） |
| 整页 contenteditable / PM | 中（表、嵌套列表） |
| **焦点块 = 裸 CM（无 decoration）** | **低**：合成发生在普通文本框 |
| 焦点块 = textarea | 最低，但无语法高亮，v0 可用 |

推荐：焦点块 CM 关掉所有 replace widget；最多语法高亮 mark。IME 问题被关在一块小编辑器里。

## 6. 图片与打开耗时

本应用**不把图收进资源库**。相对路径按「md 所在目录」解析，预览用自定义协议（如 `lector-file://` 或 Tauri/WK 的本地映射），只读原文件。

和 NoteFast file-open 对比：那边要 SHA + 写 `data/media` + 改写成 `asset:`，Windows Defender 扫新文件，配图多会到秒级。这边打开路径上**没有写盘**（除非用户粘贴新图）。

粘贴截图：写到 `./images/` 或 md 同目录，再插入相对引用。这是用户主动保存语义，Occasional，可接受 Windows 杀软那一下。

## 7. 桌面壳（2026-08-23 更新：Tauri 2 双端）

~~macOS SwiftUI + WKWebView、Windows Tauri 2 双壳并行~~ → **统一 Tauri 2 薄壳（macOS + Windows）**。理由：单壳一套代码；Tauri 在 macOS 本来就走 WKWebView，Swift 壳省不掉 Web 层只多一份维护。

| 项 | 决策 |
|---|---|
| 壳职责 | 文件对话框、文件关联、窗口管理（单进程多窗口）、拖放路径、原子写盘、外部变更监听 |
| 窗口模型 | 无 Tab；双击新文件开新窗；双击已打开文件聚焦已有窗口 |
| 启动 | 双击文件：argv/openFile 把路径交给 Web，直接读盘渲染；**没有 homepage** |
| Win 图标 | Tauri 文件关联不支持自定义图标 → NSIS 安装脚本写注册表 `HKCR\<ProgID>\DefaultIcon` 补丁 |
| 复用禁忌 | 不要复用 NoteFast engine / bootstrap / NF_READY。壳比 NoteFast 更薄 |

Rust 里重写 IR（Velotype/GPUI 路线）能压启动，但和现有 TypeScript 节奏冲突，**v1 不做**。若冷启动实在超 1.5s，再考虑原生首屏纯文本。

## 8. 调研来源（节选）

- CodeMirror discuss：CM vs PM；decoration 与 IME
- ProseMirror discuss：不做 viewport 虚拟化；`remark-prosemirror` 的往返动机
- `mdast-util-to-markdown` README：完整 round-trip 不可能
- remark#1477：stringify/parse 硬换行丢语义
- Vditor README：IR / WYSIWYG / SV；Lute
- MarkText repo：v0.20.0-rc.1 @ 2026-07-05；60.4k 星；Muya = snabbdom 虚拟 DOM 文档树内核
- SoloMD repo/README：v4 Agent 转向、v4.6 知识图谱；Tauri 2 + Vue 3 + CM6；mac dmg ~32MB
- Milkdown：PM + remark，面向嵌入，不是桌面文件编辑器
- NoteFast 自身：`packages/web` CM widget 混合编辑；file-open 收图进资源库的耗时
