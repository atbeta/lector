# @lector/shell-web

菜单绑定、打开/保存、最近列表（≤20 条本机 json）、与 Tauri 壳的 IPC 接口层。

## 红线

- Web 层不直接读任意路径；读/写走 `read_file` / `write_file`，对话框可用官方 dialog 插件
- 「送到 NoteFast」只留 `companion.ts` 空实现，v1 不做
