# clients/tauri

Tauri 2 薄壳（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理（单进程多窗口、路径去重聚焦）、拖放、原子写盘、外部变更监听、自定义协议（相对图片 baseDir 沙箱）。

## 红线

- 禁止复用 NoteFast engine / bootstrap / NF_READY
- 业务逻辑不下沉 Rust；Rust 只做文件系统与系统集成的诚实代理
- Windows 安装包用 NSIS 补丁写 `Software\Classes\Markdown\DefaultIcon` 实现关联文件图标

## Windows 打包

NSIS 安装器**只能在 Windows 上打**，macOS 本机无法交叉编译。出包走
`.github/workflows/build-windows.yml`（`windows-latest` + `x86_64-pc-windows-msvc`）：

```
bun run tauri:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

产物：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
（安装器，`installMode: currentUser`，无需管理员），CI 另附一份免安装的
`lector-portable.exe`，推 `v*` tag 时挂到 draft release。

### 窗口边框只有一个来源（踩过两次）

`tauri.conf.json` 的 `app.windows` **是空的**，窗口一律由 `io::build_doc_window` 创建
（主窗口走 `io::ensure_main_window`）。原因：

- config 里的 window 配置**会覆盖 builder**。曾经在 config 写 `"decorations": false`，
  又在 macOS 分支里调 `.decorations(true)` 想改回来——不生效，macOS 的红绿灯连同原生
  边框一起消失，只能从系统菜单关窗口。
- config 是**所有平台共用**的。只要有一个窗口来自 config，就会分出两条创建路径，
  迟早出现「主窗口有边框、双击打开的窗口没有」这种跑偏。

所以：平台差异只写在 `io.rs` 的 `window_chrome()`（macOS 保留原生边框与红绿灯，
Windows/Linux 无边框自绘），`cargo test` 里有一条断言盯着 config 不许再写 `decorations`。

两个坑，都踩过了：

- **hook 的 cwd 是仓库根目录**：Tauri 执行 `beforeBuildCommand` 时把 cwd 设成 repo 根
  （在 runner 上实测过，不是配置目录、也不是调用目录）。所以 `cd packages/editor` 只有
  从根目录调用时才对——CI 必须 `bun run tauri:build`，不要 `working-directory: clients/tauri`。
- **`RunEvent::Opened` 是 macOS 专属 variant**：不 gate 掉，Windows 目标直接编译失败。
  Windows 的文件关联走 argv + `tauri-plugin-single-instance`。

本机想验 Windows 行为时，只能靠这个流水线；不要声称在 macOS 上验证过 Windows。

### 关联文件图标（官方不支持，自行补丁）

Tauri 会注册一个**用 `fileAssociations[].name` 命名的类键**（本仓库是 `Markdown`），
路径 `HKCU\Software\Classes\Markdown`（`installMode: currentUser`，hive 由 `SHCTX` 决定），
并让 `.md` / `.markdown` / `.txt` 指向它。它建了 `DefaultIcon` 子键但**默认值是空的**，
资源管理器于是退化用白纸图标。

补丁在 `src-tauri/windows/nsis-hooks.nsh`：`NSIS_HOOK_POSTINSTALL` 把
`Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon` 写成 `$INSTDIR\lector.exe,0`，
并调 `SHChangeNotify` 刷新图标缓存；卸载只删这个值，不动类键本身。

- 类名经 `!define LECTOR_FILE_CLASS` 传入，必须等于 `fileAssociations[].name`。
  `build-windows.yml` 的 `check` job 做静态比对，改一处必须改另一处。
- 写之前先读 `shell\open\command`，为空说明类键不是本安装器写的，跳过、不抢。
- **CI 会真装一遍再读注册表**（静默安装到临时目录 → 断言 `.md -> Markdown`、
  `DefaultIcon` 指向 `Lector.exe`、卸载后值为空 → 卸载）。NSIS 脚本是压缩存放的，
  在安装器二进制里 grep 字符串是假阴性，别用那种办法验。
