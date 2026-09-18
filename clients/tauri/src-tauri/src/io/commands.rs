use std::{fs, path::PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{
  fs::{
    atomic_write, canonical, decode_base64, file_mtime_ms, is_text_doc, resolve_link_target,
    sanitize_image_name, sanitize_image_subdir, unique_path, MAX_IMAGE_BYTES,
  },
  watch::watch_file,
  window::{open_path, rebuild_allowed_dirs, PendingOpens, WindowRegistry},
};
use crate::protocol;

#[derive(Serialize)]
pub struct ReadResult {
  path: String,
  content: String,
  mtime_ms: u64,
  /// 磁盘字节数。前端用它决定是否进入大文件模式——用字符数（UTF-16 码元）
  /// 判会把中文文档的阈值抬高约 3 倍，且和用户在资源管理器里看到的大小对不上。
  byte_len: u64,
}

#[derive(Serialize)]
pub struct WriteResult {
  ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  conflict: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  current_mtime_ms: Option<u64>,
}

/// 打开文档里的本地链接：同一文件已打开就聚焦那个窗口，否则开一个新窗口。
///
/// 路径解析与校验都在这里（web 层只传「当前文档 + 链接原文」）——`paths.ts` 顶上
/// 那句「真正的路径权威在壳侧」就是这条。
#[tauri::command]
pub fn open_link(app: AppHandle, doc_path: String, href: String) -> Result<(), String> {
  let target = resolve_link_target(&doc_path, &href)?;
  if !target.is_file() {
    return Err("missing".into());
  }
  if !is_text_doc(&target) {
    return Err("not_text".into());
  }
  open_path(&app, &target.to_string_lossy());
  Ok(())
}

#[tauri::command]
pub fn read_file(path: String, app: AppHandle) -> Result<ReadResult, String> {
  let p = std::path::Path::new(&path);
  let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
  // 读到文件就意味着"这份文档已经打开了"，顺手把它的目录放进协议白名单。
  // 不能等 bind_document：前端拿到内容就渲染，图片请求可能早于 bind_document 到达，
  // 那时白名单还没有这个目录 → 403 → 图片塌成 0 高（切一次档才恢复）。
  protocol::allow_dir(&app.state::<protocol::AllowedDirs>(), &path);
  // mtime 与字节数来自同一次 metadata，不额外读盘
  let md = fs::metadata(p).ok();
  let mtime_ms = md
    .as_ref()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  let byte_len = md.map(|m| m.len()).unwrap_or_else(|| content.len() as u64);
  Ok(ReadResult {
    path,
    content,
    mtime_ms,
    byte_len,
  })
}

/// 拖入图片的字节读取：web 层拿到后包成 File 走既有插入管线（落点定位、
/// 复制进 assets、插相对路径都不变）。与 read_file 同权限模型——用户显式
/// 拖入的文件，读它的字节就是「插入」动作的一部分。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
  fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(
  path: String,
  content: String,
  mtime_ms: u64,
  force: Option<bool>,
) -> Result<WriteResult, String> {
  let p = std::path::Path::new(&path);
  // 目标不存在（另存为新文件）时无冲突可言，直接写。
  let exists = p.exists();
  let current = file_mtime_ms(p).unwrap_or(0);
  if !force.unwrap_or(false) && exists && current != mtime_ms {
    return Ok(WriteResult {
      ok: false,
      conflict: Some(true),
      current_mtime_ms: Some(current),
    });
  }
  atomic_write(p, content.as_bytes()).map_err(|e| e.to_string())?;
  let after = file_mtime_ms(p).unwrap_or(current);
  Ok(WriteResult {
    ok: true,
    conflict: None,
    current_mtime_ms: Some(after),
  })
}

/// 正文里的链接交给系统浏览器打开。
///
/// 安全：只放行 http/https/mailto。这条命令由 Web 层用文档内容里的 href 调用，
/// 而文档内容不可信——若不做白名单，一篇 md 里的 `file:///etc/passwd` 或
/// 自定义协议就能被一键触发。校验放壳侧，Web 侧的 safeHref 只是第一道。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
  let u = url.trim();
  let lower = u.to_ascii_lowercase();
  let allowed = lower.starts_with("http://")
    || lower.starts_with("https://")
    || lower.starts_with("mailto:");
  if !allowed {
    return Err(format!("refused to open non-http url: {u}"));
  }
  crate::menu::open_external(u).map_err(|e| e.to_string())
}

/// 用系统默认应用打开当前文件：联动其他编辑器（复杂编辑、预览）的逃生口。
/// 路径来自 Web 侧当前文档——它本身就是打开过的磁盘文件，不扩大权限面。
#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
  let p = PathBuf::from(&path);
  if !p.is_absolute() {
    return Err(format!("not an on-disk file: {path}"));
  }
  #[cfg(target_os = "macos")]
  let r = std::process::Command::new("open").arg(&p).spawn();
  #[cfg(target_os = "windows")]
  let r = std::process::Command::new("explorer").arg(&p).spawn();
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let r = std::process::Command::new("xdg-open").arg(&p).spawn();
  r.map(|_| ()).map_err(|e| e.to_string())
}

/// 用**用户指定的应用**打开当前文件（设置里的「用其他应用打开」）。
/// 约定与图片自定义命令一致：可执行文件 + 参数数组，文件路径追加在最后——
/// 不拼 shell 字符串，所以没有注入面。app 为空时调用方回退到 open_with_default。
#[tauri::command]
pub fn open_with_app(path: String, app: String, args: Vec<String>) -> Result<(), String> {
  let p = PathBuf::from(&path);
  if !p.is_absolute() {
    return Err(format!("not an on-disk file: {path}"));
  }
  let exe = app.trim();
  if exe.is_empty() {
    return Err("empty external app".into());
  }
  let mut cmd = std::process::Command::new(exe);
  cmd.args(&args).arg(&p);
  // macOS 的外部应用是 .app 包：直接 spawn 包路径会失败，包内的真正可执行体在
  // Contents/MacOS/ 下。交给系统的 open -a 去解析包，是最省事也最稳的做法。
  #[cfg(target_os = "macos")]
  if exe.ends_with(".app") {
    return std::process::Command::new("open")
      .args(["-a", exe])
      .arg(&p)
      .spawn()
      .map(|_| ())
      .map_err(|e| e.to_string());
  }
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 在系统文件管理器中显示当前文件（Finder 显示 / 资源管理器选中）。
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
  let p = PathBuf::from(&path);
  if !p.is_absolute() {
    return Err(format!("not an on-disk file: {path}"));
  }
  #[cfg(target_os = "macos")]
  let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
  #[cfg(target_os = "windows")]
  let r = {
    // explorer 的 `/select,` 认不出混合分隔符（`D:\dir/sub/file`），会把整串当成
    // 无效目标、退到默认目录（用户看到的是"打开了桌面"）。统一成反斜杠再传。
    let target = p.to_string_lossy().replace('/', "\\");
    std::process::Command::new("explorer")
      .arg(format!("/select,{target}"))
      .spawn()
  };
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let r = {
    let dir = p.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::process::Command::new("xdg-open").arg(dir).spawn()
  };
  r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watch(path: String, app: AppHandle) -> Result<bool, String> {
  watch_file(&app, &path);
  Ok(true)
}

/// 读系统剪贴板（右键菜单里的「粘贴」用）。
///
/// 为什么不让 web 层直接调 clipboard-manager 插件：这里只走自定义命令，
/// 不给 webview 开插件通配能力（同文件读写那条规矩，见 capabilities 的说明）。
///
/// **必须是 async**：插件自己警告 read_text 不能跑在主线程（Linux 上会死锁，
/// 尤其是复制源就是本应用里刚复制的文本时）。同步命令默认在主线程执行，
/// 这个函数体里没有 await，所以它只借到 async 运行时的线程上跑，不会挡 UI。
#[tauri::command]
pub async fn read_clipboard(app: AppHandle) -> Result<String, String> {
  use tauri_plugin_clipboard_manager::ClipboardExt;
  app.clipboard().read_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn take_pending_open(window: tauri::Window, app: AppHandle) -> Option<String> {
  let pending = app.state::<PendingOpens>();
  let path = crate::lock(&pending.0).remove(window.label());
  path
}

/// 读取设置 JSON（app 配置目录 lector-settings.json）。无则 None。
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  let path = dir.join("lector-settings.json");
  if !path.exists() {
    return Ok(None);
  }
  let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
  Ok(Some(serde_json::from_str(&s).map_err(|e| e.to_string())?))
}

/// 写设置 JSON。前端已用 core normalizeSettings 校验，壳只负责落盘。
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join("lector-settings.json");
  let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
  atomic_write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
  Ok(())
}

const RECENT_MAX: usize = 20;

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  Ok(dir.join("lector-recent.json"))
}

/// 最近打开列表（读接口，新在前）。
///
/// 壳一直在维护 lector-recent.json，但之前只喂给原生菜单；而 Windows/Linux 不建原生菜单
/// （避开初始化闪现），那份列表在界面上完全没有入口——数据在，用户够不着。
#[tauri::command]
pub fn recent_list(app: AppHandle) -> Vec<String> {
  load_recent(&app)
}

/// 清空「最近打开」。空态列表给了 Web 层「清空」入口（Windows/Linux 没有原生菜单，
/// 只读不给清等于耍流氓）；写入仍只在壳里发生，Web 拿到的只是这一个动作。
#[tauri::command]
pub fn recent_clear(app: AppHandle) {
  clear_recent(&app);
}

/// 读「最近打开」列表（新在前）。文件缺失或损坏都当空表。
pub fn load_recent(app: &AppHandle) -> Vec<String> {
  let Ok(path) = recent_file(app) else {
    return Vec::new();
  };
  let Ok(s) = fs::read_to_string(&path) else {
    return Vec::new();
  };
  serde_json::from_str::<Vec<String>>(&s).unwrap_or_default()
}

fn save_recent(app: &AppHandle, list: &[String]) {
  let Ok(path) = recent_file(app) else {
    return;
  };
  if let Some(dir) = path.parent() {
    let _ = fs::create_dir_all(dir);
  }
  if let Ok(text) = serde_json::to_string_pretty(&list) {
    let _ = atomic_write(&path, text.as_bytes());
  }
}

/// 去重置顶、截断到上限。纯函数，便于测试。
fn push_recent_list(mut list: Vec<String>, path: String) -> Vec<String> {
  list.retain(|p| p != &path);
  list.insert(0, path);
  list.truncate(RECENT_MAX);
  list
}

/// 打开一篇文档后登记到「最近打开」。壳单点读写，Web 不参与。
fn push_recent(app: &AppHandle, path: &str) {
  let list = push_recent_list(load_recent(app), path.to_string());
  save_recent(app, &list);
}

pub fn remove_recent(app: &AppHandle, path: &str) {
  let mut list = load_recent(app);
  list.retain(|p| p != path);
  save_recent(app, &list);
}

pub fn clear_recent(app: &AppHandle) {
  save_recent(app, &[]);
}

#[tauri::command]
pub fn bind_document(window: tauri::Window, app: AppHandle, path: String) -> Result<bool, String> {
  let canon = canonical(&path).unwrap_or_else(|| PathBuf::from(&path));
  let label = window.label().to_string();
  {
    let registry = app.state::<WindowRegistry>();
    let mut map = crate::lock(&registry.0);
    map.retain(|_, l| l != &label);
    map.insert(canon, label);
  }
  // 白名单按路径表重建，顺带收紧旧目录。
  rebuild_allowed_dirs(&app);
  push_recent(&app, &path);
  let _ = crate::menu::create(&app);
  Ok(true)
}

#[derive(Serialize)]
pub struct SaveImageResult {
  relative_path: String,
  /// 落盘的绝对路径：命令模式要把这张图的路径交给用户命令，壳端返回真实盘符。
  abs_path: Option<String>,
}

#[tauri::command]
pub fn save_image(
  app: AppHandle,
  doc_path: String,
  filename: String,
  bytes_base64: String,
  subdir: Option<String>,
) -> Result<SaveImageResult, String> {
  let canon = canonical(&doc_path).ok_or_else(|| "document path not found".to_string())?;
  let registry = app.state::<WindowRegistry>();
  let bound = crate::lock(&registry.0).contains_key(&canon);
  if !bound {
    return Err("document is not bound to this app".into());
  }
  let name = sanitize_image_name(&filename).ok_or_else(|| "invalid image name".to_string())?;
  let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
  // 目标子目录：缺省 `images`（老行为）；传了就校验为单段相对路径。
  let sub = match &subdir {
    None => "images".to_string(),
    Some(s) => sanitize_image_subdir(s).ok_or_else(|| "invalid image subdir".to_string())?,
  };
  let dir = parent.join(&sub);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let dest = unique_path(&dir, &name);
  let bytes = decode_base64(&bytes_base64)?;
  if bytes.is_empty() {
    return Err("empty image".into());
  }
  if bytes.len() > MAX_IMAGE_BYTES {
    return Err("image too large".into());
  }
  atomic_write(&dest, &bytes).map_err(|e| e.to_string())?;
  let file = dest
    .file_name()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or(name);
  Ok(SaveImageResult {
    relative_path: format!("{sub}/{file}").replace('\\', "/"),
    abs_path: Some(dest.to_string_lossy().into_owned()),
  })
}

/// web 层就绪信号：此刻 WebView2 必然可见且完成置顶，snap 覆盖层此时 raise
/// 才能稳稳压在它上面（竞态细节见 snap.rs::raise 的注释）。每个窗口的页面
/// 各调一次，命令按调用方窗口各自处理，天然多窗口安全。
#[tauri::command]
pub fn webview_ready(window: tauri::WebviewWindow) {
  #[cfg(target_os = "windows")]
  if let Ok(hwnd) = window.hwnd() {
    crate::snap::raise(hwnd.0 as isize);
  }
  #[cfg(not(target_os = "windows"))]
  let _ = window;
}

/// 界面缩放：改 WebView 的**原生 zoom factor**，而不是给 `<html>` 打 CSS `zoom`。
///
/// CSS zoom 只缩放绘制、不改布局视口：`100vh` 高的骨架按未缩放视口排完、再被整体
/// 放大/缩小，于是放大时状态行被顶到窗口外（还要滚一下才够得着），缩小时窗口底部留
/// 一条空带。原生 zoom 改的是布局视口本身（和浏览器 Ctrl+± 同一套），`100vh` 始终
/// 等于可见高度，命中区与坐标也跟着缩放。
///
/// 范围与前端 `uiZoom` 的 clamp（70–160）一致，这里放宽到 0.2–5.0 只为兜底防脏值。
#[tauri::command]
pub fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
  if !scale.is_finite() || !(0.2..=5.0).contains(&scale) {
    return Err("zoom scale out of range".into());
  }
  window.set_zoom(scale).map_err(|e| e.to_string())
}

// ───────────────────── 图片上传命令（用户配置，命令模式专用） ─────────────────────
// 契约：`executable [args…] <图片绝对路径>` → stdout 每行一个 http(s) URL。
// 注意：这是「用户显式配置要执行什么」的退路，不是 Web 层可随手调用的任意 shell。
// 所以故意不用 shell（Command 直接 spawn，不解析 `;` `&&` `$(...)`），
// 也不传额外环境变量，只把图片路径追加在最后。

#[derive(Serialize, Default)]
pub struct ImageCommandResult {
  ok: bool,
  url: Option<String>,
  error: Option<String>,
  stdout: String,
  stderr: String,
  exit_code: Option<i32>,
}

/// 执行用户配置的图床上传命令：`executable [args…] <image_path>`。
/// std 没有 wait_timeout，所以用轮询实现超时（每 100ms 探一次，到时 kill）。
fn run_command(executable: &str, args: &[String], image_path: &str, timeout_ms: u64) -> ImageCommandResult {
  use std::process::{Command as StdCommand, Stdio};

  let mut res = ImageCommandResult::default();
  if executable.trim().is_empty() {
    res.error = Some("empty image command".into());
    return res;
  }
  let mut cmd = StdCommand::new(executable);
  cmd.args(args).arg(image_path).stdin(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别让截图工具的命令窗口在旁边闪现
  }
  let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
    Ok(c) => c,
    Err(e) => {
      res.error = Some(format!("spawn failed: {e}"));
      return res;
    }
  };

  let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        res.exit_code = status.code();
        break;
      }
      Ok(None) => {
        if std::time::Instant::now() >= deadline {
          let _ = child.kill();
          res.error = Some(format!("timed out after {timeout_ms}ms"));
          return res;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
      }
      Err(e) => {
        res.error = Some(format!("wait failed: {e}"));
        return res;
      }
    }
  }

  let output = match child.wait_with_output() {
    Ok(o) => o,
    Err(e) => {
      res.error = Some(format!("read output failed: {e}"));
      return res;
    }
  };
  res.stdout = String::from_utf8_lossy(&output.stdout).into_owned();
  res.stderr = String::from_utf8_lossy(&output.stderr).into_owned();
  if let Some(code) = res.exit_code {
    if code != 0 {
      res.error = Some(format!("exit code {code}"));
      return res;
    }
  }
  // 契约：非零退出/超时/无 URL 都算失败；stdout 首个 http(s) URL 才算成功。
  let url = res
    .stdout
    .split('\n')
    .map(|l| l.trim())
    .find(|l| l.starts_with("http://") || l.starts_with("https://"));
  match url {
    Some(u) => {
      res.ok = true;
      res.url = Some(u.to_string());
    }
    None => {
      res.error = Some("command succeeded but no http(s) URL on stdout".into());
    }
  }
  res
}

#[tauri::command]
pub async fn run_image_command(
  executable: String,
  args: Vec<String>,
  image_path: String,
  timeout_ms: u64,
) -> ImageCommandResult {
  run_command(&executable, &args, &image_path, timeout_ms)
}

/// 设置面板「测试命令」：喂一个内置 1×1 PNG，看它吐不吐 URL。不落任何库。
#[tauri::command]
pub fn test_image_command(executable: String, args: Vec<String>, timeout_ms: u64) -> ImageCommandResult {
  static PIXEL: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
    0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
    0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x01, 0x3D, 0x3C, 0x3B, 0x78, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
  ];
  let tmp = std::env::temp_dir().join("lector-test-pixel.png");
  let _ = std::fs::write(&tmp, PIXEL);
  let r = run_command(&executable, &args, tmp.to_string_lossy().as_ref(), timeout_ms);
  let _ = std::fs::remove_file(&tmp);
  r
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::io::fs::{tdir, tmp_leftovers};

  #[test]
  fn write_conflict_when_mtime_differs() {
    let dir = tdir("conflict");
    let path = dir.join("a.md");
    atomic_write(&path, b"a").unwrap();
    let real = file_mtime_ms(&path).unwrap();
    assert!(real > 0, "mtime must be readable, otherwise the check is vacuous");
    // 用「一分钟前」而不是 real-1：有些文件系统 mtime 粒度是秒，减 1 毫秒可能
    // 落回同一个值，断言就变成随机的。
    let stale = real.saturating_sub(60_000);
    let res = write_file(path.to_string_lossy().into(), "b".into(), stale, Some(false)).unwrap();
    assert_eq!(res.ok, false);
    assert_eq!(res.conflict, Some(true));
    assert_eq!(fs::read_to_string(&path).unwrap(), "a");
    let forced = write_file(path.to_string_lossy().into(), "b".into(), 0, Some(true)).unwrap();
    assert!(forced.ok);
    assert_eq!(fs::read_to_string(&path).unwrap(), "b");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn write_new_file_without_conflict() {
    let dir = tdir("newfile");
    let path = dir.join("brand-new.md");
    let res = write_file(path.to_string_lossy().into(), "hi".into(), 0, Some(false)).unwrap();
    assert!(res.ok);
    assert_eq!(fs::read_to_string(&path).unwrap(), "hi");
    assert!(tmp_leftovers(&dir).is_empty());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn push_recent_dedupes_and_caps() {
    let list: Vec<String> = (0..25).map(|i| format!("/tmp/f{i}.md")).collect();
    let list = push_recent_list(list, "/tmp/f3.md".into());
    assert_eq!(list.len(), RECENT_MAX);
    assert_eq!(list[0], "/tmp/f3.md");
    assert_eq!(list.iter().filter(|p| p.as_str() == "/tmp/f3.md").count(), 1);
    let list = push_recent_list(Vec::new(), "/tmp/a.md".into());
    assert_eq!(list, vec!["/tmp/a.md".to_string()]);
  }

  #[test]
  fn run_command_rejects_empty_executable() {
    let r = run_command("", &[], "/tmp/x.png", 1000);
    assert!(!r.ok);
    assert!(r.error.as_deref().unwrap().contains("empty"));
  }

  #[test]
  fn run_command_spawn_failure_is_error_not_panic() {
    // 不存在的可执行：spawn 直接返回 Err，不应 panic；结果 ok=false、有 error。
    let r = run_command("/this/does/not/exist/__nope__", &[], "/tmp/x.png", 1000);
    assert!(!r.ok);
    assert!(r.error.is_some());
  }
}
