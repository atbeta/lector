# clients/tauri

Tauri 2 薄壳（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理（单进程多窗口、路径去重聚焦）、拖放、原子写盘、外部变更监听、自定义协议（相对图片 baseDir 沙箱）。

## 红线

- 禁止复用 NoteFast engine / bootstrap / NF_READY
- 业务逻辑不下沉 Rust；Rust 只做文件系统与系统集成的诚实代理
- Windows 安装包用 NSIS 补丁写 `HKCR\<ProgID>\DefaultIcon` 实现关联文件图标

## Windows 打包

NSIS 安装器**只能在 Windows 上打**，macOS 本机无法交叉编译。出包走
`.github/workflows/build-windows.yml`（`windows-latest` + `x86_64-pc-windows-msvc`）：

```
bunx tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

产物：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
（安装器，`installMode: currentUser`，无需管理员），CI 另附一份免安装的
`lector-portable.exe`，推 `v*` tag 时挂到 draft release。

本机想验 Windows 行为时，只能靠这个流水线；不要声称在 macOS 上验证过 Windows。

### 关联文件图标（官方不支持，自行补丁）

`bundle.fileAssociations` 只写 ProgID 与 `OpenWithProgids`，**不写 `DefaultIcon`**，
所以默认装完还是白纸图标。补丁在 `src-tauri/windows/nsis-hooks.nsh`：
`NSIS_HOOK_POSTINSTALL` 里写 `Software\Classes\com.lector.reader.{md,markdown,txt}\DefaultIcon`
指向 `$INSTDIR\lector.exe,0`，并调 `SHChangeNotify` 刷新图标缓存；卸载时只删该图标值。

- 用 `SHCTX` 而非写死 hive，避免 perMachine / both 模式下写错位置。
- 签名匹配到 `shell\open\command` 为空时跳过，不抢别家已接管的 ProgID。
- 该文件的 ProgID 列表必须与 `tauri.conf.json` 的 `bundle.fileAssociations` 一致，
  `build-windows.yml` 的 `check` job 会做 hash 比对，改一处必须改另一处。
