# clients/tauri

Tauri 2 薄壳（macOS + Windows）。壳只做：文件对话框、文件关联、窗口管理（单进程多窗口、路径去重聚焦）、拖放、原子写盘、外部变更监听、自定义协议（相对图片 baseDir 沙箱）。

## 红线

- 禁止复用 NoteFast engine / bootstrap / NF_READY
- 业务逻辑不下沉 Rust；Rust 只做文件系统与系统集成的诚实代理
- Windows 安装包用 NSIS 补丁写 `HKCR\<ProgID>\DefaultIcon` 实现关联文件图标
