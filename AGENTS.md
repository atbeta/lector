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
- **壳 = Tauri 2 双端**（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理、拖放、原子写盘、外部变更监听、以及**执行用户配置的图床上传命令**（图片命令模式专用；std::process::Command 不过 shell、不传额外环境变量、stdout 首个 http(s) URL 视为结果、失败静默降级本地副本）。文件 IO 走壳 IPC，Web 层不能读任意路径。
- Windows 关联文件图标用 NSIS 安装脚本写注册表 `HKCR\<ProgID>\DefaultIcon` 解决（Tauri 官方不支持，自行补丁）。
- 相对图片只允许已打开文件的目录树内（防路径穿越）；预览不执行 md 里的 HTML/script。

## 工程

- **Bun + TypeScript**（bun workspaces）。`packages/core` 无 DOM、测试先行：`bun test` 覆盖切片无缝覆盖全文、未编辑保存恒等、脏一块只动一块、CRLF/BOM 还原。
- 质量门：`bun test` + `bun run typecheck`；改动完成前运行与变更范围匹配的检查。
- 渲染层回归：`bun run verify:ui`（自动起 Vite 5199 + 自动找浏览器）。覆盖三份：
  `ui-verify`（合成后的对比度/版式/交互）、`refactor-verify`（大纲、阅读位置、复制、预览、入口初始化）、
  `block-indicator-verify`（轨道/把手/聚焦描边）。改动界面、层叠或交互后跑一次。
  **没浏览器时它会打印 SKIP 并以 0 退出**——服务器上没有浏览器是常态，不是失败；
  想让它变严格用 `bun run verify:ui -- --strict`，想指定浏览器用 `LECTOR_BROWSER=<exe>`。
- 文本完整性：**新增的行里不许出现替换字符（U+FFFD）**。仓库里那 455 处注释腐化不是一次
  事故，是历次编辑攒出来的（某些提交新增的行里就带着它），所以只清存量没用。
  本机装一次：`git config core.hooksPath .githooks`；CI 挂着同一条（只查本次新增的行）。
  绕过用 `git commit --no-verify`。整棵树的代码与字符串另有 `bun test` 的 text-integrity 守着。
- **别用 PowerShell 的 `Get-Content` / `Set-Content` 往返编辑含中文的文件**：那会把中文写成替换字符，
  仓库里那 455 处注释腐化就是这么来的（上一轮的临时脚本又踩了一次）。改文件走 `edit` / `write`
  工具，或在 `bun -e` 里用 `fs.readFileSync(f, 'utf8')` / `writeFileSync`；临时脚本也一样，
  别让它经过 PowerShell 的文本管道。
- 代码注释中文；**用户文案 i18n（zh-CN + en）从第一天就做**，不后补。
- 最小变更。不提交密钥。`testdata/` 只放自造夹具，不提交别人的私密笔记。
- Commit messages：Conventional Commits，`type(scope): subject`，简洁英文。

## 发版

- 版本号只有一个入口：`node tools/release.mjs <版本>`——改四处版本号 → 本地质量门 → 提交 → 打 tag → 推。
  不要手改版本号，也不要手打 tag 后才发现文件没跟。
- tag 必须等于打包版本号。CI 的 `check` job 第一件事就是查这个：对不上直接失败，
  否则 Release 里会躺着一个版本号不相符的安装器。
- `v*` tag 推上去后 CI 自动构建并发布 Windows 包（安装器 + 便携版 + 校验和），不需要人工点确认。
  分支上的推送只出 artifact，不动 Release。
- macOS 签名与公证暂不在范围内，也不发未签名的 macOS 包。
- **CHANGELOG.md 是面向用户的版本日志**：每版按 Conventional Commits 前缀(`feat:` `fix:` `refactor:` `perf:` `style:` `ci:` `docs:`)归入「新增 / 修复 / 改进 / 内部」四栏。
  `chore:` 与 `test:` 不进版本日志。发版时 `tools/release.mjs` 从 CHANGELOG.md 抽出本版小节写进 `.github/release-notes/<version>.md`,
  CI 的 release job 拿这个文件作发行说明;CHANGELOG.md 缺失或没本版小节则退回通用 notes。
- 发布前的 CHANGELOG.md 维护:上一版 `chore(release): vX.Y.Z` 与本版之间所有 commit,
  按上面的分类规则整理进 CHANGELOG.md;旧版的 rot / encoding 修复 / 仓库维护 commit 直接跳过。

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
4. 粘贴/拖入图片写 md 同目录或 `./images/`（默认模式）/ `./<文档名>.assets/`（assets 模式），正文插相对路径；图床命令模式则把命令返回的 http(s) URL 写进正文，但本地副本始终在 `assets/` 兜底——任何模式下都不进任何库。
