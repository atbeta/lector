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

目标**不存在**（另存为新文件）时无冲突可言，直接写；此时客户端传 `mtime_ms: 0`。另存为覆盖已有文件由系统保存对话框确认，Web 随后用 `force: true` 写。

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

Web 打开一篇文档后登记到当前窗口（对话框打开的 main 窗口也要登记，否则相对图协议与粘贴落盘无法授权）。副作用三件：协议白名单按路径表重建（收紧旧目录）、写入「最近打开」、重建原生菜单。

```ts
invoke('bind_document', { path: string }) → boolean
```

### `read_clipboard`

读系统剪贴板文本，右键菜单里的「粘贴」用。

Web 层的 `navigator.clipboard.readText()` 在 macOS 的 WKWebView 里一律被拒（Tauri 2 的剪贴板能力在 `tauri-plugin-clipboard-manager` 里，而壳不把插件命令开放给 webview——同文件读写那条规矩），菜单里那一项因此长期只能弹「请用 ⌘V」。写（复制/剪切）不走这里：`writeText` / `execCommand` 一直好用，不必多开能力。

```ts
invoke('read_clipboard') → string
```

### `save_image`

把位图写到该文档同目录的子目录下，返回正斜杠相对路径和落盘绝对路径。仅当 `path` 已 bind / 在路径表中。文件名由壳再消毒；重名自动加 `-2`。
`subdir` 缺省 `images`（保持老行为）；指定时必须是单段相对路径——拒 `..`、分隔符、盘符。

```ts
invoke('save_image', {
  docPath: string,
  filename: string,
  bytesBase64: string,
  subdir?: string | null,   // 单一子目录，缺省 'images'
}) → {
  relative_path: string,   // 永远正斜杠，便于直接写进 md
  abs_path: string | null,  // 给命令模式用：把图床命令的 <image_path> 指着这里
}
```

### `run_image_command`（图片命令模式专用）

**不是 Web 层随手可调的任意 shell**：这条命令是用户在「图片 → 命令模式」里**显式**配置的退路，所以壳只给它一条很窄的输入：可执行名 + 固定参数 + 图片绝对路径，没有环境变量、没有 shell。

契约：`executable [args…] <image_path>` → stdout 首行 http(s) URL 视为结果；非零退出/超时/无 URL 都算失败。失败由 Web 端静默降级为本地副本，正文写相对路径。Windows `CREATE_NO_WINDOW` 隐藏命令窗口。

```ts
invoke('run_image_command', {
  executable: string, args: string[], image_path: string, timeout_ms: number,
}) → {
  ok: boolean, url: string | null, error: string | null,
  stdout: string, stderr: string, exit_code: number | null,
}
```

### `test_image_command`

设置面板「测试命令」按钮：壳生成一个 1×1 PNG 喂给命令，看 stdout 能否拿到 URL，不落任何库。参数同上，不传 `image_path`。

### `load_settings` / `save_settings`

读写 app 配置目录 `lector-settings.json`。

---

## 最近打开与另存为

**最近打开**：壳单点维护配置目录 `lector-recent.json`（字符串数组，新在前，≤20，去重）。Web 无读接口。

- 记入时机：`bind_document`（覆盖对话框打开、双击关联、argv、单实例转发、另存为后切换全部路径）。
- 展示：原生菜单 File > Open Recent。条目 id `recent-<i>`；点击由壳直接 `open_path`（已开则聚焦，未开新窗口），**不经 Web**。文件已不存在 → 从列表移除并重建菜单。
- 「Clear Menu」（id `recent-clear`）清空并重建菜单。
- 列表变化（bind / clear / 移除失效项）后整体重建菜单。

**另存为**：菜单 `file-save-as`（⇧⌘S）→ emit `{ action: 'save-as' }` → Web 走 dialog 插件 `save()` 拿路径 → `write_file(path, content, 0, force: true)` → 成功后 `loadSession` 切到新路径（随之 bind + watch + 记最近）。

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

- 2026-09-17：补 `read_clipboard`（壳装 `tauri-plugin-clipboard-manager`，但只经自定义命令暴露读；webview 自己的 `readText()` 在 macOS 上必被拒，右键菜单的「粘贴」因此一直失败）。不动 capabilities：插件命令不开给 webview。
- 2026-09-03：补「最近打开」（壳单点 `lector-recent.json` + 原生菜单）与「另存为」（dialog save + `write_file` force）；`write_file` 目标不存在时直接写；`bind_document` 副作用收白名单、记最近、重建菜单。
- 2026-08-31：补 `bind_document` / `save_image`（粘贴拖入图片写 `./images/`）。
- 2026-08-31：命令名去掉 `lector:` 前缀以符合 Tauri 2 ACL；读/写收回 Rust；补 `take_pending_open` 与写回真实 mtime。
- 2026-08-23：初版契约。命令名与事件名锁定，未定 `openFile`/`closeWindow` 等后续再议。
