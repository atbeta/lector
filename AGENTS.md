# AGENTS.md

Lector —— 阅读优先的纯 Markdown 编辑器。AI 编码 Agent 与人类协作者的本仓库级行为规范。

## 产品红线（任何需求先过这关）

- **磁盘 `.md` 是唯一权威**。打开 = 读文件，保存 = 写回同一路径。未改过的块保存时必须与原文字节级一致。
- **阅读优先**。AI 时代读远大于写；阅读体验（排版、大纲、秒开）是一等公民，编辑做到"顺手能改"即可。
- **不做文档管理**：无库、无文件夹树、无标签、无图谱、无同步、无账号、无跨文件搜索。
- **无应用内 Tab**。单进程多窗口；同一文件重复打开时聚焦已有窗口。macOS 用户可用系统原生"合并所有窗口"获得 Tab，应用不自建。
- 日后可"送到 NoteFast 收集箱"（HTTP 单向导入）；不嵌 NoteFast engine，不引其 workspace 包。
- 反面教材是 SoloMD：功能引力会让编辑器四年内长成 Agent 平台。新增功能需求对照本节，越界打回。

## 架构（已锁定，不要再选型）

- **内核 = 源码切片 IR**：micromark/mdast 解析（带 `position`），块级切片；未聚焦块自绘预览 DOM，聚焦块挂一个**裸 CodeMirror 6**（禁 `Decoration.replace` widget）只编该块源码。
- **禁止**：整页 CM 装饰（HyperMD 老路）、ProseMirror/Milkdown 当文档模型、Vditor 当内核、默认整篇 `remark-stringify`、Rust/GPUI 重写内核。
- **壳 = Tauri 2 双端**（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理、拖放、原子写盘、外部变更监听。文件 IO 走壳 IPC，Web 层不能读任意路径。
- Windows 关联文件图标用 NSIS 安装脚本写注册表 `HKCR\<ProgID>\DefaultIcon` 解决（Tauri 官方不支持，自行补丁）。
- 相对图片只允许已打开文件的目录树内（防路径穿越）；预览不执行 md 里的 HTML/script。

## 工程

- **Bun + TypeScript**（bun workspaces）。`packages/core` 无 DOM、测试先行：`bun test` 覆盖切片无缝覆盖全文、未编辑保存恒等、脏一块只动一块、CRLF/BOM 还原。
- 质量门：`bun test` + `bun run typecheck`；改动完成前运行与变更范围匹配的检查。
- 代码注释中文；**用户文案 i18n（zh-CN + en）从第一天就做**，不后补。
- 最小变更。不提交密钥。`testdata/` 只放自造夹具，不提交别人的私密笔记。
- Commit messages：Conventional Commits，`type(scope): subject`，简洁英文。

## 目录

```
lector/
├── .ai/                # 立项包（brief / research / architecture / bootstrap）
├── packages/core       # SourceDocument、parse、serialize、BlockView —— 无 DOM
├── packages/editor     # IR 视图 + 聚焦块 CM，可 vite 单独打开
├── packages/shell-web  # 菜单绑定、打开保存、最近列表、窗口协调
├── clients/tauri       # Tauri 2 薄壳（macOS + Windows）
└── testdata/           # 真实 md 夹具（中文、CRLF、GFM、frontmatter）
```

## 成功标准（v1，节选自 .ai/01-brief.md）

1. 应用已在跑时双击普通 md，看见正文 < 300ms；冷启动 < 1.5s（做不到就先纯文本降级再切 IR）。
2. ⌘S / Ctrl+S 写回同一路径，未改段落字节级一致。
3. 中文 IME 段落内输入不丢字、候选窗跟光标。
4. 粘贴/拖入图片写 md 同目录或 `./images/`，正文插相对路径，不进任何库。
