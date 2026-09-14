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
}

#[tauri::command]
pub fn save_image(
  app: AppHandle,
  doc_path: String,
  filename: String,
  bytes_base64: String,
) -> Result<SaveImageResult, String> {
  let canon = canonical(&doc_path).ok_or_else(|| "document path not found".to_string())?;
  let registry = app.state::<WindowRegistry>();
  let bound = registry.0.lock().unwrap().contains_key(&canon);
  if !bound {
    return Err("document is not bound to this app".into());
  }
  let name = sanitize_image_name(&filename).ok_or_else(|| "invalid image name".to_string())?;
  let parent = canon.parent().ok_or_else(|| "no parent dir".to_string())?;
  let dir = parent.join("images");
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
    relative_path: format!("images/{file}").replace('\\', "/"),
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
  // 恢复上次的尺寸/位置/最大化，然后才让它露面。
  // 顺序是必须的：window-state 的自动恢复发生在窗口就绪之后，若此刻窗口已可见，
  // 用户会看到「小窗口闪一下 → 跳到最大化」。显式调用把顺序钉死（restore 与 show
  // 在同一个同步块里，中间不会插进一次绘制），与插件的自动恢复幂等。
  let _ = win.restore_state(StateFlags::all());
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
}
