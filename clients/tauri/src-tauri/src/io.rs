use std::{
  collections::HashMap,
  fs,
  io,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
  },
  time::UNIX_EPOCH,
};
use notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
// 恢复窗口状态的方法在 trait 上，必须显式引入才能调用（E0599 会提示「trait 未在作用域内」）
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::protocol;

/// path → window label，同一文件只开一个窗口。
#[derive(Default)]
pub struct WindowRegistry(pub Mutex<HashMap<PathBuf, String>>);

/// path → watcher，关窗时卸掉。
#[derive(Default)]
pub struct WatcherStore(pub Mutex<HashMap<PathBuf, RecommendedWatcher>>);

/// 新建窗口尚未就绪时，路径先挂在这里。
#[derive(Default)]
pub struct PendingOpens(pub Mutex<HashMap<String, String>>);

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct DirResult {
  base_dir: String,
}

#[derive(Serialize)]
pub struct ReadResult {
  path: String,
  content: String,
  mtime_ms: u64,
}

#[derive(Serialize)]
pub struct WriteResult {
  ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  conflict: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  current_mtime_ms: Option<u64>,
}

pub fn file_mtime_ms(path: &std::path::Path) -> io::Result<u64> {
  let md = fs::metadata(path)?;
  let t = md.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
  Ok(t.as_millis() as u64)
}

fn canonical(path: &str) -> Option<PathBuf> {
  fs::canonicalize(path).ok()
}

/// 原子写：同目录 temp + rename。Windows 先删目标再 rename。
pub fn atomic_write(path: &std::path::Path, content: &[u8]) -> io::Result<()> {
  let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
  let tmp = dir.join(format!(
    ".lector-tmp-{}-{}",
    std::process::id(),
    std::time::SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0)
  ));
  fs::write(&tmp, content)?;
  let rename = fs::rename(&tmp, path);
  if rename.is_err() && path.exists() {
    let _ = fs::remove_file(path);
    if let Err(e) = fs::rename(&tmp, path) {
      let _ = fs::remove_file(&tmp);
      return Err(e);
    }
    return Ok(());
  }
  if let Err(e) = rename {
    let _ = fs::remove_file(&tmp);
    return Err(e);
  }
  Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadResult, String> {
  let p = std::path::Path::new(&path);
  let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
  let mtime = file_mtime_ms(p).unwrap_or(0);
  Ok(ReadResult {
    path,
    content,
    mtime_ms: mtime,
  })
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

#[tauri::command]
pub fn dir_for(path: String) -> Result<DirResult, String> {
  let p = std::path::Path::new(&path);
  let dir = p.parent().unwrap_or_else(|| std::path::Path::new("."));
  Ok(DirResult {
    base_dir: dir.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
pub fn watch(path: String, app: AppHandle) -> Result<bool, String> {
  watch_file(&app, &path);
  Ok(true)
}

#[tauri::command]
pub fn take_pending_open(window: tauri::Window, app: AppHandle) -> Option<String> {
  let pending = app.state::<PendingOpens>();
  let path = pending.0.lock().unwrap().remove(window.label());
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
pub fn push_recent(app: &AppHandle, path: &str) {
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

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif"];
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

fn sanitize_image_name(name: &str) -> Option<String> {
  let base = name.replace('\\', "/");
  let base = base.rsplit('/').next().unwrap_or("");
  if base.is_empty() || base == "." || base == ".." {
    return None;
  }
  let (stem, ext) = base.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if !IMAGE_EXTS.contains(&ext.as_str()) {
    return None;
  }
  let mut out = String::new();
  for c in stem.chars() {
    if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
      out.push(c);
    } else {
      out.push('-');
    }
  }
  let stem = out.trim_matches('-');
  if stem.is_empty() {
    return None;
  }
  Some(format!("{stem}.{ext}"))
}

fn unique_path(dir: &std::path::Path, filename: &str) -> PathBuf {
  let dest = dir.join(filename);
  if !dest.exists() {
    return dest;
  }
  let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, "png"));
  for i in 2..1000 {
    let cand = dir.join(format!("{stem}-{i}.{ext}"));
    if !cand.exists() {
      return cand;
    }
  }
  dir.join(format!("{stem}-{}.{}", std::process::id(), ext))
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
  fn val(c: u8) -> Option<u8> {
    match c {
      b'A'..=b'Z' => Some(c - b'A'),
      b'a'..=b'z' => Some(c - b'a' + 26),
      b'0'..=b'9' => Some(c - b'0' + 52),
      b'+' => Some(62),
      b'/' => Some(63),
      _ => None,
    }
  }
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
  let mut buf = 0u32;
  let mut n = 0;
  for &c in bytes {
    if c == b'=' || c.is_ascii_whitespace() {
      continue;
    }
    let v = val(c).ok_or_else(|| "invalid base64".to_string())?;
    buf = (buf << 6) | u32::from(v);
    n += 6;
    if n >= 8 {
      n -= 8;
      out.push((buf >> n) as u8);
    }
  }
  Ok(out)
}

#[tauri::command]
pub fn bind_document(window: tauri::Window, app: AppHandle, path: String) -> Result<bool, String> {
  let canon = canonical(&path).unwrap_or_else(|| PathBuf::from(&path));
  let label = window.label().to_string();
  {
    let registry = app.state::<WindowRegistry>();
    let mut map = registry.0.lock().unwrap();
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

/// 图片子目录只允许单段（无 `/` `\`）、非空、非 `..`、非绝对路径。
/// 与 editor 的 expandImageDir 是同一判据；壳侧再验一次，双保险。
fn sanitize_image_subdir(s: &str) -> Option<String> {
  let t = s.trim();
  if t.is_empty() || t.contains('/') || t.contains('\\') || t.contains("..") {
    return None;
  }
  if t.contains(':') {
    return None; // 拒绝盘符 / 兜底
  }
  if t.len() > 120 {
    return None;
  }
  Some(t.to_string())
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
  let bound = registry.0.lock().unwrap().contains_key(&canon);
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

fn rebuild_allowed_dirs(app: &AppHandle) {
  let registry = app.state::<WindowRegistry>();
  let allowed = app.state::<protocol::AllowedDirs>();
  let paths: Vec<PathBuf> = registry.0.lock().unwrap().keys().cloned().collect();
  protocol::reset_dirs(&allowed);
  for p in paths {
    protocol::allow_dir(&allowed, &p.to_string_lossy());
  }
}

/// 窗口销毁：从路径表、watcher、协议白名单里拿掉。
pub fn forget_window(app: &AppHandle, label: &str) {
  let registry = app.state::<WindowRegistry>();
  let dropped = {
    let mut map = registry.0.lock().unwrap();
    let hit = map.iter().find(|(_, l)| l.as_str() == label).map(|(p, _)| p.clone());
    if let Some(ref p) = hit {
      map.remove(p);
    }
    hit
  };
  if let Some(p) = dropped {
    unwatch(app, &p);
  }
  let pending = app.state::<PendingOpens>();
  pending.0.lock().unwrap().remove(label);
  rebuild_allowed_dirs(app);
}

fn unwatch(app: &AppHandle, path: &std::path::Path) {
  let store = app.state::<WatcherStore>();
  store.0.lock().unwrap().remove(path);
}

/// 打开一篇文档：去重（已开则聚焦），否则新建窗口并记下 pending path。
pub fn open_path(app: &AppHandle, path: &str) {
  let canon = canonical(path).unwrap_or_else(|| PathBuf::from(path));
  protocol::allow_dir(&app.state::<protocol::AllowedDirs>(), path);
  let registry = app.state::<WindowRegistry>();
  let key = canon.clone();

  let existing = {
    let map = registry.0.lock().unwrap();
    map.get(&key).cloned()
  };

  if let Some(label) = existing {
    if let Some(win) = app.get_webview_window(&label) {
      let _ = win.set_focus();
      let _ = win.emit("lector:open", serde_json::json!({ "path": path }));
      return;
    }
    // 登记还在、窗口已关：清掉再新建
    registry.0.lock().unwrap().remove(&key);
    unwatch(app, &key);
  }

  let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
  let label = format!("doc-{seq}");
  let pending = app.state::<PendingOpens>();
  pending.0.lock().unwrap().insert(label.clone(), path.to_string());

  match build_doc_window(app, &label) {
    Ok(_win) => {
      let _ = registry.0.lock().unwrap().insert(key, label);
    }
    Err(e) => {
      pending.0.lock().unwrap().remove(&label);
      log::error!("failed to open window {label}: {e}");
    }
  }
}

/// 窗口边框的平台差异，单独成函数以便单测（无 GUI 也能验配置对不对）。
///
/// 教训写在这里，别再踩：**tauri.conf.json 里的 window 配置会覆盖 builder**。
/// 曾经在 config 里写了 `"decorations": false`，又在 macOS 分支里调
/// `.decorations(true)` 想改回来——不起作用，macOS 的红绿灯连同原生边框一起消失，
/// 用户只能从系统菜单关窗口。所以 config 只放不变量，平台差异一律在 builder 里做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowChrome {
  /// 是否保留系统绘制的窗口边框（macOS 的红绿灯就长在这里）
  pub decorations: bool,
}

#[cfg(target_os = "macos")]
pub const fn window_chrome() -> WindowChrome {
  // macOS：保留原生边框 + 覆盖式标题栏。红绿灯是 mac 用户的肌肉记忆，
  // 自绘一套会立刻显得「不是 mac 应用」。
  WindowChrome { decorations: true }
}

#[cfg(not(target_os = "macos"))]
pub const fn window_chrome() -> WindowChrome {
  // Windows / Linux：无边框自绘，最小化/最大化/关闭由 Web 层的 chrome.ts 调窗口命令。
  WindowChrome { decorations: false }
}

/// 平台级的窗口观感微调，在窗口创建后、显示前调用。
///
/// Windows：向 DWM 显式申请圆角（DWMWA_WINDOW_CORNER_PREFERENCE = ROUND）。
/// 无边框窗口不保证吃到 Win11 的默认圆角——本应用就是反例；Win10 没有这个
/// 属性，调用失败静默忽略即可。macOS 原生边框自带圆角，无此事。
#[cfg(target_os = "windows")]
fn apply_platform_window_tweaks(win: &tauri::WebviewWindow) {
  use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
  };
  const DWMWCP_ROUND: u32 = 2;
  let Ok(hwnd) = win.hwnd() else { return };
  let preference: u32 = DWMWCP_ROUND;
  unsafe {
    let _ = DwmSetWindowAttribute(
      hwnd.0 as windows_sys::Win32::Foundation::HWND,
      DWMWA_WINDOW_CORNER_PREFERENCE as _,
      &preference as *const u32 as *const _,
      std::mem::size_of::<u32>() as u32,
    );
  }
}

#[cfg(not(target_os = "windows"))]
fn apply_platform_window_tweaks(_win: &tauri::WebviewWindow) {}

/// 主窗口也必须由此函数创建，不能交给 tauri.conf.json 的 app.windows。
///
/// 原因：config 里的 window 配置会覆盖 builder，而且是**所有平台共用**的。
/// 只要有一处窗口来自 config，就会出现「主窗口有原生边框、双击打开的窗口没有」
/// 这种平台差异跑偏——macOS 红绿灯消失那次的成因就是 config 与 builder 打架。
/// 统一入口后，平台差异只有 window_chrome() 一个来源。
pub fn ensure_main_window(app: &AppHandle) -> tauri::Result<()> {
  if app.get_webview_window("main").is_some() {
    return Ok(());
  }
  build_doc_window(app, "main")?;
  Ok(())
}

/// 首次启动的默认窗口尺寸：按主屏工作区算，不写死。
///
/// 原来写死 900×720：在 1080p 上只占中间一小块，2K/4K 上更明显（用户反馈过
/// 「默认窗口不满」）；而随便换一个更大的固定值，又会在 1366×768 这类屏上顶出屏幕。
/// 取宽七成、高七成八，两端都能落到「合适」。
///
/// 只影响**第一次**启动：之后由 window-state 插件恢复用户自己调过的尺寸与位置。
fn default_window_size(app: &AppHandle) -> (f64, f64) {
  let fallback = (1180.0, 820.0);
  let Ok(Some(monitor)) = app.primary_monitor() else {
    return fallback;
  };
  let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
  (
    (logical.width * 0.72).clamp(960.0, 1680.0),
    (logical.height * 0.78).clamp(680.0, 1120.0),
  )
}

fn build_doc_window(app: &AppHandle, label: &str) -> tauri::Result<tauri::WebviewWindow> {
  let chrome = window_chrome();
  #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
  let (w, h) = default_window_size(app);
  let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
    .title("Lector")
    .inner_size(w, h)
    .min_inner_size(480.0, 360.0)
    // 无边框窗口在 Windows 上需要显式要投影，否则窗口和桌面糊在一起
    .shadow(true)
    .decorations(chrome.decorations);
  #[cfg(target_os = "macos")]
  {
    builder = builder
      .hidden_title(true)
      .title_bar_style(tauri::TitleBarStyle::Overlay)
      .accept_first_mouse(true)
      // 46px 顶栏里把 13px 高的灯组垂直居中：(46-13)/2 ≈ 16。
      // x=20 是 macOS 惯例（第一颗按钮距左边缘 20pt），顶栏左内边距留了 80px 给它。
      .traffic_light_position(tauri::LogicalPosition::new(20.0, 16.0));
  }
  let win = builder.build()?;
  // Windows 的无边框窗口 DWM 不保证给圆角（截图里就是直角的），显式向 DWM 要。
  apply_platform_window_tweaks(&win);
  // 恢复上次的尺寸/位置/最大化，然后才让它露面。
  // 顺序是必须的：window-state 的自动恢复发生在窗口就绪之后，若此刻窗口已可见，
  // 用户会看到「小窗口闪一下 → 跳到最大化」。显式调用把顺序钉死（restore 与 show
  // 在同一个同步块里，中间不会插进一次绘制），与插件的自动恢复幂等。
  let _ = win.restore_state(StateFlags::all() & !StateFlags::MAXIMIZED);
  let _ = win.show();
  Ok(win)
}

/// 监听文件所在目录，变化时 emit lector:file-changed。
pub fn watch_file(app: &AppHandle, path: &str) {
  use notify::{RecursiveMode, Watcher};
  let target = PathBuf::from(path);
  let dir = target
    .parent()
    .unwrap_or_else(|| std::path::Path::new("."))
    .to_path_buf();
  let emit_app = app.clone();
  let watched = target.clone();
  let watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    if let Ok(ev) = res {
      for p in ev.paths {
        if p == watched {
          let _ = emit_app.emit(
            "lector:file-changed",
            serde_json::json!({
              "path": p.to_string_lossy(),
              "mtime_ms": file_mtime_ms(&watched).unwrap_or_default()
            }),
          );
        }
      }
    }
  }) {
    Ok(w) => w,
    Err(e) => {
      log::warn!("watcher init failed: {e}");
      return;
    }
  };
  let mut w = watcher;
  if let Err(e) = w.watch(&dir, RecursiveMode::NonRecursive) {
    log::warn!("watch failed: {e}");
    return;
  }
  let store = app.state::<WatcherStore>();
  store.0.lock().unwrap().insert(target, w);
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

  /// 回归防线：tauri.conf.json 里的 window 配置会覆盖 builder，
  /// 一旦有人在 config 里写死 decorations:false，macOS 会连红绿灯一起丢掉，
  /// 而这个问题在 macOS 上跑 `cargo test` 也不会报错（配置合法），
  /// 所以必须显式读 config 断言。
  #[test]
  fn window_config_does_not_hardcode_decorations() {
    let raw = include_str!("../tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(raw).expect("tauri.conf.json 应当是合法 JSON");
    let windows = conf["app"]["windows"].as_array().expect("应有 app.windows");
    // 窗口一律由 io::build_doc_window / ensure_main_window 创建。
    // 一旦有人把窗口写回 config，就会多出一条创建路径，平台差异必然跑偏
    // （macOS 红绿灯消失那次就是 config 与 builder 打架）。
    assert!(
      windows.is_empty(),
      "app.windows 必须为空：窗口由 Rust 创建，平台差异只写在 window_chrome()"
    );
    for (i, w) in windows.iter().enumerate() {
      if let Some(d) = w.get("decorations") {
        panic!("app.windows[{i}].decorations = {d}：config 会覆盖 builder，不要在这里固定");
      }
    }
    // macOS 必须有原生边框，否则没有红绿灯
    #[cfg(target_os = "macos")]
    assert!(window_chrome().decorations, "macOS 必须保留原生窗口边框（红绿灯）");
    // Windows / Linux 走无边框自绘
    #[cfg(not(target_os = "macos"))]
    assert!(!window_chrome().decorations, "非 macOS 走 decorations:false 自绘");
  }

  /// 每个用例独占一个刚建出来的空目录，并且只在开始时清一次。
  ///
  /// 不要在系统临时目录里用 `lector-xxx-<pid>.md` 这种固定名字：上一次被杀掉的
  /// 进程会留下同名文件，下一次跑（pid 往往复用）就带着脏状态开始——「目标不存在」
  /// 与「mtime 冲突」两条断言都会莫名其妙地翻。测试必须自备干净环境。
  fn tdir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lector-test-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn tmp_leftovers(dir: &std::path::Path) -> Vec<String> {
    fs::read_dir(dir)
      .unwrap()
      .filter_map(|e| e.ok())
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .filter(|n| n.starts_with(".lector-tmp-"))
      .collect()
  }

  #[test]
  fn atomic_write_roundtrip() {
    let dir = tdir("atomic");
    let path = dir.join("a.md");
    atomic_write(&path, b"hello").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    atomic_write(&path, b"world").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"world");
    // 覆盖写不能留下临时文件——那是写进用户文档目录里的垃圾。
    assert!(tmp_leftovers(&dir).is_empty(), "leftover: {:?}", tmp_leftovers(&dir));
    let _ = fs::remove_dir_all(&dir);
  }

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
  fn sanitize_image_name_strips_paths() {
    assert_eq!(sanitize_image_name("photo.png").as_deref(), Some("photo.png"));
    assert_eq!(sanitize_image_name("a/../x.PNG").as_deref(), Some("x.png"));
    assert_eq!(sanitize_image_name("weird name.webp").as_deref(), Some("weird-name.webp"));
    assert!(sanitize_image_name("../x.png").is_none() || sanitize_image_name("../x.png").as_deref() == Some("x.png"));
    assert!(sanitize_image_name("x.txt").is_none());
    assert!(sanitize_image_name("..").is_none());
  }

  #[test]
  fn decode_base64_hello() {
    assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
  }

  #[test]
  fn unique_path_adds_suffix() {
    let dir = tdir("uniq");
    atomic_write(&dir.join("shot.png"), b"1").unwrap();
    let next = unique_path(&dir, "shot.png");
    assert_eq!(next.file_name().unwrap().to_string_lossy(), "shot-2.png");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn sanitize_image_subdir_rejects_evil_input() {
    // 合法
    assert_eq!(sanitize_image_subdir("images"), Some("images".into()));
    assert_eq!(sanitize_image_subdir("读书笔记.assets"), Some("读书笔记.assets".into()));
    // 拒：穿越
    assert_eq!(sanitize_image_subdir(".."), None);
    assert_eq!(sanitize_image_subdir("../evil"), None);
    assert_eq!(sanitize_image_subdir("a/../b"), None);
    // 拒：路径分隔
    assert_eq!(sanitize_image_subdir("a/b"), None);
    assert_eq!(sanitize_image_subdir("a\\b"), None);
    // 拒：盘符
    assert_eq!(sanitize_image_subdir("C:evil"), None);
    // 拒：空
    assert_eq!(sanitize_image_subdir(""), None);
    assert_eq!(sanitize_image_subdir("   "), None);
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
