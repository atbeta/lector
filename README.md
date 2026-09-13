# Lector

一个打开 `.md` 文件的工具。不是知识库，不是文件管理器，没有账号，没有同步。读得舒服，改得顺手，保存走人。

## 为什么

- Typora 收费闭源，还想把文件管理也做了
- MarkText 是写作工具，Electron 重，文档树内核会重写你的文件
- SoloMD 在做 Agent 平台，编辑器只是载体
- AI 时代，**读** 远大于 **写**。Markdown 是 AI 内容的事实格式，但没有一个专注、精美、秒开的阅读工具

## 原则

- 磁盘上的 `.md` 是唯一真相。打开 = 读，保存 = 写回原路径
- 未改过的内容，保存后字节级不变——你的文件永远不会被编辑器"顺手优化"
- 一个文档一个窗口，没有 Tab，没有侧栏文件树
- 阅读体验是一等公民：排版、大纲、秒开

## 状态

内核切片、编辑器预览/聚焦块、Tauri 壳已在开发中。方案见 [.ai/](./.ai/README.md)。质量门：`bun test` + `bun run typecheck` + `cargo test`。

## 发版

Windows 包只能由 CI 出（NSIS 在 macOS 上打不出来），所以发版是一条命令：

```
node tools/release.mjs 0.2.0
```

它改掉四处版本号（`tauri.conf.json` / `clients/tauri/package.json` / `Cargo.toml` / `Cargo.lock`）、
跑本地质量门（`bun test` + `typecheck` + `design-audit`）、提交、打 tag、推。
CI 接着在 Windows 上重跑全套检查（含静默安装与注册表校验），然后自动发布：

- `Lector_<版本>_x64-setup.exe` —— 安装器，无需管理员权限，装完带 `.md` / `.markdown` / `.txt` 关联与图标
- `lector-portable.exe` —— 免安装，双击即用
- `SHA256SUMS.txt` —— 校验和

tag 与版本号对不上、或哪个文件漏改了，CI 在第一分钟就拦下来，不会发出一个版本号对不上的包。
带后缀的 tag（`v0.2.0-rc.1`）自动标成预发布。只想拿构建产物不发版：

```
gh run download --repo atbeta/lector --name lector-windows-x64
```

macOS 版暂不发：签名与公证还没做，先不发未签名的包。

## License

MIT
