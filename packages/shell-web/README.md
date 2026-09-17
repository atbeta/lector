# @lector/shell-web

菜单绑定、打开/保存、最近列表（≤20 条本机 json）、与 Tauri 壳的 IPC 接口层。

## 红线

- Web 层不直接读任意路径；读/写走 `read_file` / `write_file`，对话框可用官方 dialog 插件
- 「送到 NoteFast」v1 不做，接入点见 `.ai/03-architecture.md`（尚未建 `companion.ts`）
