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

### `lector:menu` —— 菜单 / 快捷键动作

```ts
payload: { action: string }   // 如 'save-as'
```

原生菜单（macOS 有，Windows/Linux 走自绘顶栏）与全局快捷键触发的动作经此下发。**保存不在这条链路里**：⌘S 由 Web 自己处理，菜单的 Save 也走 `lector:menu`，壳不替 Web 保存。

### `lector:file-changed` —— 磁盘外部变更（watch 回调）

```ts
payload: { path: string, mtimeMs: number }
```

Web 展示「磁盘已变，覆盖 / 重新加载」，用户选择后再动。

### `lector:drag-hover` / `lector:drop-files` —— 拖放通道

原生拖放（`RunEvent::WindowEvent` 的 `DragDropEvent`）归壳：WebView 的 `File` 对象拿不到磁盘路径，所以**文档必须走原生**。

```ts
// 拖入内容类型变化：悬停提示亮灭
'lector:drag-hover' → 'image' | 'doc' | 'other' | 'none'
// 图片落下：路径 + 逻辑像素坐标（物理像素已按窗口缩放折算）
'lector:drop-files'   → { paths: string[], x: number, y: number }
```

- 图片：壳把**逻辑坐标**给 Web，由 `elementFromPoint` 决定插到哪个块附近。
- 文档（`.md/.markdown/.txt`）：**不经过 Web**，壳直接 `emit('lector:open')` 给拖入的那个窗口就地打开（`lector:open` 自带「先读后确认脏文档」）。多个文档只开第一个——就地打开语义下逐个确认反而混乱。
- Drop 时壳会补发一次 `drag-hover: none`：Windows 不保证 Drop 之后还有 `Leave` 事件，不清提示会一直挂着。

### `lector:win-max-hover` —— 自绘最大化按钮的悬停

```ts
payload: boolean
```

Windows 无边框窗口的 Snap 覆盖层会接管最大化按钮的鼠标事件，`:hover` 因此不会自己亮；壳在窗口过程里收到悬停后转告 Web 层补这颗按钮的悬停态。**只发给本窗口**（裸 `emit` 会广播，所有窗口的最大化按钮会一起亮）。

### `lector:asset`（协议注入）—— 相对图片资源

壳注册自定义协议 `lector-file://`，URL 形如：

```
lector-file:///<baseDir>/<relative-path>#mtime
```

Web 侧通过 `resolveImageSrc` 构造。壳侧解析：归一化后校验 `relative-path` 不越出 `<baseDir>`，否则返回 403（防穿越）。

`baseDir` **不经过单独的查询命令**（早期有一条 `dir_for`，已删）：白名单在 `bind_document` / `read_file` 时按「本窗口打开过的文件」重建，因此协议只映射当前窗口真的打开过的目录树。

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

### `read_file_bytes`

```ts
invoke('read_file_bytes', { path: string }) → number[]
```

拖入图片的字节读取：Web 拿到后包成 `File` 走既有插入管线（落点定位、复制进子目录、插相对路径都不变）。与 `read_file` 同权限模型——用户**显式拖入**的文件，读它的字节就是「插入」这个动作的一部分。返回原始 `number[]`（壳不 base64，Web 侧拷进定长缓冲当 `BlobPart`）。

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

### `open_url` / `open_with_default` / `reveal_in_folder`

壳作为「系统集成代理」的三条最小出口：

```ts
invoke('open_url', { url: string }) → void           // 用系统浏览器打开 http/https/mailto
invoke('open_with_default', { path: string }) → void // 用系统默认应用打开当前文件
invoke('reveal_in_folder', { path: string }) → void  // 在文件管理器里显示（Finder 显示 / 资源管理器选中）
```

- `open_url` 的**白名单在壳侧**：只放行 `http://` / `https://` / `mailto:`。入参是文档内容里的 href，而文档不可信——少了这道，一篇 md 里的 `file:///…` 或自定义协议就能被一键触发（Web 侧的 `safeHref` 只是第一道）。
- `open_with_default` / `reveal_in_folder` 只接受**绝对路径**（来自 Web 侧当前文档），不扩大权限面。
- `reveal_in_folder` 在 Windows 上要把 `/` 统一成 `\`：`explorer /select,` 认不出混合分隔符，会把整串当无效目标、退到默认目录（表现为「打开了桌面」）。

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

### `open_link`

打开文档里的本地链接：同一文件已打开就聚焦那个窗口，否则开一个新窗口（`open_path` 那条路）。

Web 层只传「当前文档路径 + 链接原文」——**相对路径怎么解析、允不允许，全在壳侧**。链接是文档内容，属不可信输入，判定必须待在能看清真实文件系统的那一层。

尺度**比相对图片宽，这是有意的**：相对图片锁在文档目录树内，因为它是渲染时自动加载的（无手势，一份文档就能静默读盘）；链接是手势门控的（用户点了才走），结果只是开一个只读窗口显示文件，没有外发通道、不执行脚本、不写目标。所以相对路径（含 `../`）、绝对路径、`file://` 都认，与 Typora 对齐。剩下的门槛是零成本的三道：扩展名限 `.md/.markdown/.txt`、目标必须是存在的普通文件、其它 scheme 一律拒。

失败时返回短码字符串：`bad_href` / `scheme` / `missing` / `not_text`，由 Web 层翻成人话。

```ts
invoke('open_link', { docPath: string, href: string }) → void
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
  abs_path: string | null,  // 给上传命令用：把图床命令的 <image_path> 指着这里
}
```

### `stage_image` / `discard_staged_image`

「不保存本地副本」时上传命令的中转：命令吃的是绝对路径，所以先把字节写成系统临时目录
（`<temp>/lector-stage/`）里的一个文件，传完就删——文档目录始终干净。

```ts
invoke('stage_image', { filename: string, bytesBase64: string }) → string  // 绝对路径
invoke('discard_staged_image', { path: string }) → void
```

`discard_staged_image` 由 Web 层调用，所以**只允许删暂存目录里的文件**：两边 canonicalize
之后再比前缀，软链接指到目录外也删不掉（不是「删任意路径」的口子）。

### `run_image_command`（上传配置专用）

**不是 Web 层随手可调的任意 shell**：这条命令是用户在「图片 → 图床 → 上传命令」里**显式**配置的退路，所以壳只给它一条很窄的输入：可执行名 + 固定参数 + 图片绝对路径，没有环境变量、没有 shell。

契约：`executable [args…] <image_path>` → stdout 首行 http(s) URL 视为结果；非零退出/超时/无 URL 都算失败。失败后的后果由 Web 端按「要不要复制」处理：留副本的走法把正文写成相对路径，不留副本的走法补落一份副本兜底（绝不丢图）。Windows `CREATE_NO_WINDOW` 隐藏命令窗口。

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

### `recent_list` / `recent_clear`

```ts
invoke('recent_list') → string[]   // 新在前
invoke('recent_clear') → void
```

壳一直在维护 `lector-recent.json`，但早先只喂给**原生菜单**；而 Windows / Linux 不建原生菜单（避开初始化闪现），那份列表在界面上没有任何入口——数据在，用户够不着。于是开两个最小接口：读列表（空态展示）与清空（只读不给清等于耍流氓）。**写入仍然只在壳里发生**，Web 拿到的只是这两个动作。

### `webview_ready`

```ts
invoke('webview_ready') → void
```

Web 层就绪信号，页面加载后每个窗口各调一次。Windows 上此刻 WebView2 必然可见且已置顶，`snap` 覆盖层此时 raise 才能稳稳压在它上面（竞态细节见 `snap.rs::raise`）。命令按调用方窗口各自处理，天然多窗口安全。

### `set_zoom`

```ts
invoke('set_zoom', { scale: number }) → void
```

界面缩放：调 WebView 的原生 zoom factor（1 = 100%）。**不是**给 `<html>` 打 CSS `zoom`——那只缩放绘制、不改布局视口，会把 `100vh` 高的骨架放大到窗口外（放大时状态行被顶出去、缩小时底部留空带）。原生 zoom 改的是布局视口本身，等同浏览器 Ctrl+±。范围 0.2–5.0 兜底。

壳侧 PDF 导出（`print_to_pdf`）期间会临时复位到 1 再还原，避免打印带上缩放。

### `print_to_pdf`

```ts
invoke('print_to_pdf', { path: string }) → void
```

把当前窗口渲染成 PDF 写到 `path`（路径来自 dialog 的 `save()`）。Windows 上走 WebView2 的 `PrintToPdf`，那是**异步 COM 调用**：结果经完成回调送达，所以命令只发起调用不阻塞，再用 channel + 超时把结果带回命令线程。版式由 `html.printing` 那套样式负责（Web 侧在调用前后挂/摘类）。

---

## 最近打开与另存为

**最近打开**：壳单点维护配置目录 `lector-recent.json`（字符串数组，新在前，≤20，去重）。Web 侧只有 `recent_list` / `recent_clear` 两个最小接口（空态展示与清空）；**写入仍然只在壳里发生**。

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

- 2026-09-17：按代码逐条对齐。补 8 条**没记录**的命令：`read_file_bytes`（拖入图片取字节）、`open_url` / `open_with_default` / `reveal_in_folder`（系统集成三出口）、`recent_list` / `recent_clear`（Windows/Linux 没有原生菜单，最近打开原本在界面上够不着）、`webview_ready`（snap 覆盖层的就绪信号）、`print_to_pdf`（导出 PDF）。补 4 个没记录的事件：`lector:menu`（菜单/快捷键动作，取代已不存在的 `lector:save-request`）、`lector:drag-hover` / `lector:drop-files`（原生拖放通道）、`lector:win-max-hover`（自绘最大化按钮悬停）。删掉 `dir_for`（命令已移除，baseDir 由 `bind_document` / `read_file` 时重建的协议白名单决定）。
- 2026-09-17：补 `open_link`（文档里的本地链接：相对路径按当前文档解析，开新窗口/聚焦已有窗口；路径判定在壳侧，尺度与相对图片不同，理由见该节）。
- 2026-09-17：补 `read_clipboard`（壳装 `tauri-plugin-clipboard-manager`，但只经自定义命令暴露读；webview 自己的 `readText()` 在 macOS 上必被拒，右键菜单的「粘贴」因此一直失败）。不动 capabilities：插件命令不开给 webview。
- 2026-09-03：补「最近打开」（壳单点 `lector-recent.json` + 原生菜单）与「另存为」（dialog save + `write_file` force）；`write_file` 目标不存在时直接写；`bind_document` 副作用收白名单、记最近、重建菜单。
- 2026-08-31：补 `bind_document` / `save_image`（粘贴拖入图片写 `./images/`）。
- 2026-08-31：命令名去掉 `lector:` 前缀以符合 Tauri 2 ACL；读/写收回 Rust；补 `take_pending_open` 与写回真实 mtime。
- 2026-08-23：初版契约。命令名与事件名锁定，未定 `openFile`/`closeWindow` 等后续再议。
