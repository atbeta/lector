# 壳 IPC 契约（shell ↔ web）

Lector 是「单进程多窗口」：一个 Tauri 壳进程，每个窗口加载同一份 Web 编辑器。**文件 IO 只发生在壳（Rust）**，Web 层不读任意路径。本文档定义壳与 Web 之间的消息形状，先定契约再写两端代码。

## 传输与方向

- 壳 → Web 用 `WebviewWindow` 的 **emit**（tauri `window.emit` / `window.listen`）。
- Web → 壳用 **invoke**（`@tauri-apps/api/core.invoke`，走全局命令表）。
- Web 侧屏障在 `packages/shell-web`：一份 `IPC` 单例，命令与事件名集中定义，不裸散。

## 事件（壳 → Web）

所有事件带 `payload`，事件名以 `lector:` 为前缀，避免与 webview 默认事件冲突。

### `lector:open` —— 提醒响应当前窗口打开一篇文档

触发：双击文件（含 argv / macOS `file` 事件）、菜单「打开」。

```ts
payload: { path: string }
```

窗口行为：
- 当前窗口空闲（无未保存脏块）→ 直接打开 `path`。
- 当前窗口有脏块 → 先弹「丢弃 / 取消」（v1 简化：丢弃并打开）。
- 若该 `.md` 已由另一窗口打开 → 转发给壳，由壳协调（见「窗口协调」）。

### `lector:save-request` —— 菜单 / ⌘S 触发的保存

Web 收到后自行执行 `invoke('lector:write_file', …)`，并回报结果。壳不替 Web 保存。

```ts
payload: { path: string }
```

### `lector:file-changed` —— 磁盘外部变更（watch 回调）

```ts
payload: { path: string, mtimeMs: number }
```

Web 展示「磁盘已变，覆盖 / 重新加载」，用户选择后再动。

### `lector:asset`（协议注入）—— 相对图片资源

壳注册自定义协议 `lector-file://`，URL 形如：

```
lector-file:///<baseDir>/<relative-path>#mtime
```

Web 侧通过 `resolveImageSrc` 构造。壳侧解析：归一化后校验 `relative-path` 不越出 `<baseDir>`，否则返回 403（防穿越）。

---

## 命令（Web → 壳，invoke）

Tauri 2 命令名是 Rust 函数名，**不能**带 `lector:` 前缀（`:` 是插件权限分隔符）。事件名仍用 `lector:`。

打开对话框走官方 `plugin-dialog`（只拿 path）；读/写必须走下面两条，禁止 Web 用 fs 插件碰盘。

### `read_file`

```ts
invoke('read_file', { path: string }) → {
  path: string
  content: string      // 原始字节文本（含 BOM / \r\n，壳不做归一）
  mtime_ms: number
}
```

### `write_file`

写回同一路径。**原子写**（temp + rename）。仅在 `mtime_ms` 匹配当前磁盘 mtime 时写；不匹配返回 `conflict: true`。`force: true` 跳过冲突检查（用户明确选「覆盖」）。

```ts
invoke('write_file', { path: string, content: string, mtime_ms: number, force?: boolean }) → {
  ok: true, current_mtime_ms: number
} | { ok: false, conflict: true, current_mtime_ms: number }
```

`content` 为**最终字节文本**（Web 已按 newline/BOM 还原），壳不再做换行归一，只负责写。成功时返回磁盘真实 `current_mtime_ms`，禁止客户端用 `Date.now()` 猜。

### `watch`

开始监听某目录/文件，外部变化以 `lector:file-changed` 事件回推。关窗时壳卸掉 watcher。

```ts
invoke('watch', { path: string }) → { ok: boolean }
```

### `dir_for`

取某文档所在目录（baseDir），供相对图片协议与粘贴落盘定位。

```ts
invoke('dir_for', { path: string }) → { base_dir: string }
```

### `take_pending_open`

新建窗口时壳先记下 path。Web 就绪后调用，避免 `lector:open` 早于监听。

```ts
invoke('take_pending_open') → string | null
```

### `bind_document`

Web 打开一篇文档后登记到当前窗口（对话框打开的 main 窗口也要登记，否则相对图协议与粘贴落盘无法授权）。

```ts
invoke('bind_document', { path: string }) → boolean
```

### `save_image`

把位图写到该文档同目录 `images/`，返回正斜杠相对路径。仅当 `path` 已 bind / 在路径表中。文件名由壳再消毒；重名自动加 `-2`。

```ts
invoke('save_image', { docPath: string, filename: string, bytesBase64: string }) → {
  relative_path: string
}
```

### `load_settings` / `save_settings`

读写 app 配置目录 `lector-settings.json`。

---

## 窗口协调（单进程多窗口，去重）

壳持有 `path → windowLabel` 映射。`lector:open` 到达后：

1. 若无窗口打开 `path` → 新建窗口；将 `path` 记入映射。
2. 若已有窗口打开 `path` → 不新开，`emit('lector:open', { path })` 给**该窗口**并置前（focus）。
3. 窗口关闭时从映射移除。

Web 侧不维护跨窗口状态；「最近打开」仅壳单点读写用户目录 json。

## 安全红线

- 相对图片协议只映射已打开文件的 baseDir，拒绝 `..` 逃逸（`sanitizeRelative` 已在 editor 实现，壳侧须重复校验）。
- Web 层不做路径穿越 / 任意读盘；一律经 shell IPC。
- 不执行 md 内 HTML/script（editor 预览已转义降级）。
- 无 Node 集成到 Web 全局；壳只做文件与系统集成的诚实代理。

## 变更记录

- 2026-08-31：补 `bind_document` / `save_image`（粘贴拖入图片写 `./images/`）。
- 2026-08-31：命令名去掉 `lector:` 前缀以符合 Tauri 2 ACL；读/写收回 Rust；补 `take_pending_open` 与写回真实 mtime。
- 2026-08-23：初版契约。命令名与事件名锁定，未定 `openFile`/`closeWindow` 等后续再议。
