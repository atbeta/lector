# clients/tauri

Tauri 2 薄壳（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理（单进程多窗口、路径去重聚焦）、拖放、原子写盘、外部变更监听、自定义协议（相对图片 baseDir 沙箱）。

## 红线

- 禁止复用 NoteFast engine / bootstrap / NF_READY
- 业务逻辑不下沉 Rust；Rust 只做文件系统与系统集成的诚实代理
- Windows 安装包用 NSIS 补丁写 `Software\Classes\Markdown\DefaultIcon` 实现关联文件图标
  （指向随包发的 `markdown.ico`，与应用图标分开，见下）

## Windows 打包

NSIS 安装器**只能在 Windows 上打**，macOS 本机无法交叉编译。出包走
`.github/workflows/build-windows.yml`（`windows-latest` + `x86_64-pc-windows-msvc`）：

```
bun run tauri:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

产物：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`
（安装器，`installMode: currentUser`，无需管理员），CI 另附一份免安装的
`lector-portable.zip`（`lector.exe` + `resources\markdown.ico` + 关联脚本，见 `portable/`），
推 `v*` tag 时挂到 release。

## macOS 打包

出包走 `.github/workflows/build-macos.yml`（`macos-latest` + `aarch64-apple-darwin`），
步骤对齐 NoteFast：导入 Developer ID p12 → `tauri build --bundles app --no-sign` →
自己 `codesign`（Hardened Runtime + `entitlements.plist`）→ `notarytool` 公证 `.app` 与
DMG → `stapler` 钉章。缺凭证时 Tauri 内置公证只会 warn，不能当闸门。

本机 `tauri:dev` / `tauri:build` 继续不签名。只有 CI 的 tag 流水线带 `APPLE_*` secret。
产物：`Lector_<版本>_arm64-apple-darwin.dmg` 与同名 `.zip`，挂到同一个 GitHub Release。

### 便携版的文件关联（portable/*.cmd）

便携包没有安装器写注册表，关联靠两个 `.cmd`：`register-file-assoc.cmd` /
`unregister-file-assoc.cmd`。要点：

- `.reg` 静态文件写不了相对路径（`DefaultIcon` 和 `shell\open\command` 都要绝对路径，
  而解压到哪只有用户机器知道），所以用 `%~dp0` 自动探测目录的 `.cmd`，双击即生效。
- 编码：仓库里 `.cmd` 是 UTF-8，**打包时 CI 转成 GBK(936) 进包**——cmd 按系统码页
  （中文 Windows = CP936）解析脚本，UTF-8 中文会被拆成碎片命令；GBK 字节对在 CP936
  下严丝合缝。不要在仓库里直接存 GBK（diff/grep 全废），也不要加 `chcp 65001`
  （中途切码页救不了已缓冲的行）。冒烟测试会断言包内脚本无 BOM 且 CP936 可解。
- 只写 `HKCU`，不需要管理员权限；ProgID 用独立的 `Lector.Portable.Markdown`，
  与 NSIS 安装器的 `Markdown` 类键互不覆盖，谁后注册谁生效。
- 卸载脚本只在 `.md` 仍指向便携版 ProgID 时才摘除，不误伤用户后来设置的其它程序。
- CI 冒烟测试会解包断言 exe / 图标 / 两个脚本都在 zip 里，再启动进程验活。

### 窗口边框只有一个来源（踩过两次）

`tauri.conf.json` 的 `app.windows` **是空的**，窗口一律由 `io::window::build_doc_window` 创建
（主窗口走 `io::ensure_main_window`）。原因：

- config 里的 window 配置**会覆盖 builder**。曾经在 config 写 `"decorations": false`，
  又在 macOS 分支里调 `.decorations(true)` 想改回来——不生效，macOS 的红绿灯连同原生
  边框一起消失，只能从系统菜单关窗口。
- config 是**所有平台共用**的。只要有一个窗口来自 config，就会分出两条创建路径，
  迟早出现「主窗口有边框、双击打开的窗口没有」这种跑偏。

所以：平台差异只写在 `io/window.rs` 的 `window_chrome()`（macOS 保留原生边框与红绿灯，
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
`Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon` 指向 **`resources\markdown.ico`**，
并调 `SHChangeNotify` 刷新图标缓存；卸载只删这个值，不动类键本身。

`.md` 用的是**独立的文档图标**，不是应用图标：应用图标是满幅深色圆角方块，当文档图标
太重、在一堆文件里也认不出「这是一份文档」。文档图标是浅色纸张 + 折角 + Lector 标记，
放在一堆白色页面里也是一眼能认出的一个。

### 应用图标（macOS 与 Windows 不是同一张）

源文件两份，**不要**用一份 SVG 同时出 `.icns` 和 `.ico`：

- `app-icon.svg`：满幅圆角底板。给 Windows `.ico` 与 PNG（任务栏 / 开始菜单会再裁圆角，留白会显得小）。
- `app-icon-macos.svg`：同一套 L/M，底板按图标网格内缩约 10%。给 `icon.icns`（Dock / Finder）。满幅图在 macOS 上会被系统再套一层超椭圆，光学上比旁边的应用大一圈。
- 底板色相仍是 `#364653`，不要平涂：顶光 + 左上高光 + 内沿，让石墨像缎面而不是色块。空态 `lector-mark.svg` 跟满幅稿同一套光。

```
# Windows（只取 ico；顺带的 icns/android 丢掉）
bunx tauri icon clients/tauri/app-icon.svg -o /tmp/lector-win-icon
cp /tmp/lector-win-icon/icon.ico clients/tauri/src-tauri/icons/icon.ico
cp /tmp/lector-win-icon/32x32.png clients/tauri/src-tauri/icons/32x32.png
cp /tmp/lector-win-icon/128x128.png clients/tauri/src-tauri/icons/128x128.png
cp /tmp/lector-win-icon/128x128@2x.png clients/tauri/src-tauri/icons/128x128@2x.png
cp /tmp/lector-win-icon/icon.png clients/tauri/src-tauri/icons/icon.png

# macOS（只取 icns）
bunx tauri icon clients/tauri/app-icon-macos.svg -o /tmp/lector-mac-icon
cp /tmp/lector-mac-icon/icon.icns clients/tauri/src-tauri/icons/icon.icns
```

空态 / About 的 `lector-mark.svg` 仍用满幅稿，那是页面里的品牌块，不受 Dock 网格约束。

- 源文件 `file-icon.svg`（文档图标，与应用图标分开），重新生成：
  ```
  bunx tauri icon clients/tauri/file-icon.svg -o /tmp/md-icon
  cp /tmp/md-icon/icon.ico clients/tauri/src-tauri/icons/markdown.ico
  ```
  `tauri icon` 会连带生成 android/ios/icns 一堆用不上的东西，只取 `icon.ico`。
  生成的 `.ico` 内含 16/24/32/48/64/256 六档——16px 那档必须单独看，
  它是资源管理器列表视图里真正显示的那张。
- 图标文件由 `bundle.resources` 落到安装目录（`"icons/markdown.ico" -> "resources/markdown.ico"`）。
  这一步是**静默失败**的：落点对不上时 hook 会退回 exe 图标，注册表里照样有值。
  所以 `build-windows.yml` 不只看注册表，还会 `Test-Path` 那个 .ico。
- 类名经 `!define LECTOR_FILE_CLASS` 传入，必须等于 `fileAssociations[].name`；
  图标落点经 `!define LECTOR_FILE_ICON` 传入，必须等于 `bundle.resources` 的目标。
  `ci.yml` 静态比对这两处 + 图标文件是否存在，改一处必须改另一处。
- 写之前先读 `shell\open\command`，为空说明类键不是本安装器写的，跳过、不抢。
- **CI 会真装一遍再读注册表**（静默安装到临时目录 → 断言 `.md -> Markdown`、
  `DefaultIcon` 指向存在的 `markdown.ico`、卸载后值为空 → 卸载）。NSIS 脚本是压缩存放的，
  在安装器二进制里 grep 字符串是假阴性，别用那种办法验。

macOS 文档图标暂时无解：Tauri 不支持 `CFBundleTypeIconFile`，只能跟应用图标一致。
