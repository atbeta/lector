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
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};

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

pub fn file_mtime_ms(path: &std::path::Path) -> io::Result<u64> {
  let md = fs::metadata(path)?;
  let t = md.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
  Ok(t.as_millis() as u64)
}

fn canonical(path: &str) -> Option<PathBuf> {
  fs::canonicalize(path).ok()
}

/// 本应用能打开的文档扩展名表（open_if_markdown 与 open_link 共用一份）。
pub fn is_text_doc(path: &std::path::Path) -> bool {
  matches!(
    path.extension()
      .and_then(|e| e.to_str())
      .map(str::to_lowercase)
      .as_deref(),
    Some("md") | Some("markdown") | Some("txt")
  )
}

/// 把文档里的链接解析成一个待打开的本地路径。只解析，不碰文件系统。
///
/// **尺度比相对图片宽，这是有意的**：相对图片必须锁在文档目录树内（防路径穿越），
/// 因为图片是渲染时**自动加载**的，没有用户手势——一份文档就能静默去读机器上的文件。
/// 链接则是**手势门控**的：用户真的点了才走，结果也只是开一个只读窗口显示那个文件，
/// 没有外发通道、不执行脚本、不写目标。所以相对路径（含 `../`）、绝对路径、`file://`
/// 都认，跟 Typora 对齐。剩下的门槛都是零成本的那几道：扩展名、存在性、scheme。
fn resolve_link_target(doc_path: &str, href: &str) -> Result<PathBuf, String> {
  let raw = href.trim();
  if raw.is_empty() {
    return Err("bad_href".into());
  }
  // 锚点与查询串不是路径的一部分（文内锚点本轮不做）
  let cut = raw.find(['#', '?']).unwrap_or(raw.len());
  let path_part = &raw[..cut];
  if path_part.is_empty() {
    return Err("bad_href".into());
  }

  if path_part.to_ascii_lowercase().starts_with("file://") {
    // 交给 url：百分号转义、Windows 盘符、UNC 它都比手写稳
    let u = url::Url::parse(path_part).map_err(|_| "bad_href".to_string())?;
    return u.to_file_path().map_err(|_| "bad_href".to_string());
  }

  // Windows 盘符（`C:\` / `C:/`）看着像 scheme，先认出来，别被下面的判断误杀
  let b = path_part.as_bytes();
  let is_drive = b.len() >= 2
    && b[0].is_ascii_alphabetic()
    && b[1] == b':'
    && (b.len() == 2 || matches!(b[2], b'/' | b'\\'));
  if !is_drive {
    if let Some(i) = path_part.find(':') {
      let scheme = &path_part[..i];
      let looks_like_scheme = !scheme.is_empty()
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
      // http / mailto / obsidian 这些 web 层已经分过流；走到这里说明不是预期的输入，
      // 明确拒掉而不是拿去拼路径
      if looks_like_scheme {
        return Err("scheme".into());
      }
    }
  }

  let p = PathBuf::from(path_part);
  if p.is_absolute() {
    return Ok(p);
  }
  // 相对路径按当前文档所在目录解析。文档路径必须是绝对路径：壳里它来自对话框/argv，
  // 一定绝对；不是绝对就说明前端传错了东西，宁可拒掉也不要按进程 CWD 拼出一个
  // "碰巧存在"的路径
  let doc = PathBuf::from(doc_path.trim());
  if doc_path.trim().is_empty() || !doc.is_absolute() {
    return Err("bad_href".into());
  }
  let dir = doc.parent().ok_or_else(|| "bad_href".to_string())?;
  Ok(dir.join(p))
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
pub fn read_file(path: String, app: AppHandle) -> Result<ReadResult, String> {
  let p = std::path::Path::new(&path);
  let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
  // 读到文件就意味着"这份文档已经打开了"，顺手把它的目录放进����议白名单。
  // 不能等 bind_document：前端拿到内容就渲染，图片请求可能早于 bind_document 到达，
  // 那时白名单还没有这个目录 → 403 → 图片塌成 0 高（切一次档才恢复）。
  protocol::allow_dir(&app.state::<protocol::AllowedDirs>(), &path);
  // mtime 与字节数来自同一次 metadata，不额外读盘
  let md = fs::metadata(p).ok();
  let mtime_ms = md
    .as_ref()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
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

/// 正文里的链接交�����系��������览器打开。
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
    // 用 Unicode 的 is_alphanumeric（而非 ascii��：��和��端 safeDropName 的
    // `\p{L}\p{N}` 保持一致，否则「截图_2026.png」拖进来会被落成「--_2026.png」。
    if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
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

/// 图片子目录只允许单段（无 `/` `\`）、非空��非 `..`、非绝对路径。
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

  // 标题在**建窗时**就设成目标文档的名字，而不是先写 "Lector" 等 Web 层来纠正：
  // 首帧必然先出现那个占位标题，随后才切成文档名——用户看到的是"标题栏先闪一下
  // Lector，再出现文档"。占位一旦被画出来就已经晚了，所以必须在这里给对。
  let title = std::path::Path::new(path)
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or("Lector");
  match build_doc_window(app, &label, title) {
    Ok(_w) => {
      log::info!("[win] 文档窗口已就绪 {label}");
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
/// `.decorations(true)` 想改��来——不起作用，macOS 的红绿灯连同原生边框一起消失，
/// 用户只能从系统菜单关窗口。所以 config 只放不变量，平台差异一律在 builder 里做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowChrome {
  /// 是否保留系统绘制的窗口边框（macOS 的红绿灯就长在这里）
  pub decorations: bool,
  /// 窗口是否透明。Windows 需要：透明 + Mica/Acrylic 材质才有系统圆角
  /// （见 apply_platform_window_tweaks）。macOS 不需要。
  pub transparent: bool,
}

#[cfg(target_os = "macos")]
pub const fn window_chrome() -> WindowChrome {
  // macOS：保留原生边框 + 覆盖式标题栏。红绿灯是 mac 用户的肌肉记忆，
  // 自绘一套会立刻显得「不是 mac 应用」。
  WindowChrome { decorations: true, transparent: false }
}

#[cfg(not(target_os = "macos"))]
pub const fn window_chrome() -> WindowChrome {
  // Windows / Linux：无边框自绘，最小化/最大化/关闭由 Web 层的 chrome.ts 调窗口命令。
  // Windows 透明窗口是圆角的前提（DWM 材质方案，见 apply_platform_window_tweaks）。
  WindowChrome { decorations: false, transparent: true }
}

/// 平台级的窗口观感微调，在窗口创建后、显示前调用。
///
/// Windows 圆角方案（沿用 RelayCraft 验证过的路子）：无边框 + 透明窗口 +
/// DWM 背景材质——Win11 上 Mica，不支持时退回 Acrylic。只要挂了 DWM 材质，
/// DWM 就会按系统圆角裁窗口并画出原生投影；正文背景由 CSS 的 --background
/// 画满，材质只在窗口边缘可见。
/// 之前试过 DWMWA_WINDOW_CORNER_PREFERENCE：对无边框窗口（popup 样式）不生效，
/// 别再走回头路。材质色调按创建时的系统主题选一次，之后切主题不重刷
/// （影响只有边缘几像素的材质色调，可接受）。
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

#[cfg(target_os = "windows")]
fn apply_platform_window_tweaks(win: &tauri::WebviewWindow) {
  use window_vibrancy::{apply_acrylic, apply_mica};
  let dark = matches!(win.theme(), Ok(tauri::Theme::Dark));
  if dark {
    let _ = apply_acrylic(win, Some((18, 18, 22, 80)));
  } else if apply_mica(win, Some(false)).is_err() {
    // Win10 没有 Mica
    let _ = apply_acrylic(win, Some((242, 242, 250, 50)));
  }
  // 悬停最大化按钮弹 Snap 布局浮窗（Win11）——无边框窗口默认没有这个行为。
  // 覆盖层会接管那颗按钮的鼠标，所以点击在 Rust 侧 toggle，悬停再转告 web 层补 :hover。
  if let Ok(hwnd) = win.hwnd() {
    let toggle_win = win.clone();
    let hover_win = win.clone();
    let label = win.label().to_string();
    crate::snap::install(
      hwnd.0 as isize,
      move || {
        // 这个闭包是在**窗口过程**里被调的（WM_* 处理中），而 Tauri 的窗口 API
        // 会把调用派回主线程并等待结果——在窗口过程里重入就是死锁。
        // 实测症状：第一个窗口正常，再开第二个直接卡死、必须强杀。
        // 所以先跳出当前线程再碰 Tauri：窗口过程立刻返回，宿主线程自己去等。
        let w = toggle_win.clone();
        std::thread::spawn(move || {
          // tauri 没有 toggle_maximize，用 is_maximized 自己分派
          if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
          } else {
            let _ = w.maximize();
          }
        });
      },
      move |hovering| {
        // 同上：窗口过程里不能直接调 Tauri。emit_to 也要走一遍宿主线程。
        // 只发给本窗口：裸 emit 会广播，所有窗口的最大化按钮会一起亮。
        let w = hover_win.clone();
        let lbl = label.clone();
        std::thread::spawn(move || {
          let _ = w.emit_to(EventTarget::webview_window(lbl), "lector:win-max-hover", hovering);
        });
      },
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
  build_doc_window(app, "main", "Lector")?;
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

/// 上次退出时这个窗口标签的几何（读 window-state 插件的存档）。
/// (x, y, 宽, 高, 是否最大化)。最大化时用 prev_x/prev_y 作还原矩形。
fn saved_window_geometry(app: &AppHandle, label: &str) -> Option<(f64, f64, f64, f64, bool)> {
  let dir = app.path().app_config_dir().ok()?;
  let text = fs::read_to_string(dir.join(".window-state.json")).ok()?;
  let map: serde_json::Value = serde_json::from_str(&text).ok()?;
  let st = map.get(label)?;
  let num = |k: &str| st.get(k).and_then(|v| v.as_f64());
  let (w, h) = (num("width")?, num("height")?);
  let maximized = st.get("maximized").and_then(|v| v.as_bool()).unwrap_or(false);
  if maximized {
    // 最大化时 x/y 是显示器左上角，prev_* 才是还原矩形的位置
    let x = num("prev_x").unwrap_or_else(|| num("x").unwrap_or(0.0));
    let y = num("prev_y").unwrap_or_else(|| num("y").unwrap_or(0.0));
    Some((x, y, w, h, true))
  } else {
    Some((num("x")?, num("y")?, w, h, false))
  }
}

/// 存档位置是否还在某块屏的工作区内（换过显示器布局时把窗口拉回居中）。
fn position_on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
  app.monitor_from_point(x, y).ok().flatten().is_some()
}

fn build_doc_window(app: &AppHandle, label: &str, title: &str) -> tauri::Result<tauri::WebviewWindow> {
  let chrome = window_chrome();
  let (w, h) = default_window_size(app);
  // 预读 window-state 存档，让窗口「出生即在正确位置」。
  //
  // 为什么不能建出来再 restore_state：那时窗口已可见，用户会看到「先在默认位置
  // 出现 → 再跳回上次位置」。而先 visible(false) 再 show 更糟——隐藏窗口里的
  // WKWebView 会被 WebKit 挂起乃至终结内容进程，第二个窗口直接卡死（实测复现，
  // 创建即 content process terminated；可见窗口能自动 reload 恢复，隐藏窗口不会）。
  // 预应用几何是唯一两头都对的做法：插件的就绪时自动恢复仍会执行，同值幂等。
  let saved = saved_window_geometry(app, label).filter(|(x, y, _, _, _)| position_on_screen(app, *x, *y));
  // 主题早应用：把设置里的明暗模式在首帧前交给页面（index.html 的内联脚本消费）。
  // 前端 load_settings 要等模块加载完才到——深色用户会先看到一帧浅色再变深，
  // 系统��色 + 应用深色时最刺眼。这里同步读一次设置文件，成本可忽略。
  let theme_mode = app
    .path()
    .app_config_dir()
    .ok()
    .and_then(|dir| fs::read_to_string(dir.join("lector-settings.json")).ok())
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(str::to_string))
    .unwrap_or_default();
  let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
    .title(title)
    // 把文档名交给页面：<head> 里的内联脚本在首帧之前就用它替换占位标题。
    // 只设窗口标题不够——页面加载后会按自己的逻辑写标题（见 resetTitle），
    // 那一下就会把 "Lector" 闪出来。
    .initialization_script(&format!(
      "window.__lectorTitle = {}; window.__lectorTheme = {};",
      // serde_json 的字符串序列化就是合法的 JS 字面量（JSON ⊂ JS），
      // 文档名里的引号、反斜杠天然安全——不要手写转义。
      serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".into()),
      serde_json::to_string(&theme_mode).unwrap_or_else(|_| "\"\"".into())
    ))
    .min_inner_size(480.0, 360.0)
    // Tauri 默认的原生拖放处理器会把文件拖放截胡成 tauri://drag-drop 事件，
    // WebView 里的 HTML5 drop 永远不会触发——表现为「拖入图片没有任何行为」。
    // 我们的拖放逻辑（落���定位、复制进 assets）全在 Web 层，用不到原生通道。
    .disable_drag_drop_handler()
    // 无边框窗口在 Windows 上需要显式要投影，否则窗口和桌面糊在一起
    .shadow(true)
    .decorations(chrome.decorations);
  if let Some((x, y, sw, sh, maximized)) = saved {
    // 存档是物理像素（window-state 插件按 PhysicalPosition/PhysicalSize 存取），
    // 而 builder 的 position/inner_size 是逻辑像素（tauri 文档原文）。不换算的话
    // HiDPI 屏（125%/150% 缩放）上预应用的位置和尺寸都按缩放偏大，插件就绪时
    // 再按物理值恢复一次——窗口「出现在一个位置、随后挪到另一个位置」。
    // 按落点显示器的缩放折算成逻辑值，预应用与插件恢复重合，不再跳动。
    let scale = app
      .monitor_from_point(x, y)
      .ok()
      .flatten()
      .map(|m| m.scale_factor())
      .unwrap_or(1.0);
    builder = builder.position(x / scale, y / scale).inner_size(sw / scale, sh / scale);
    if maximized {
      builder = builder.maximized(true);
    }
  } else {
    // 所有新窗口先以同一规则居中；没有历史记录时避免空态窗口和
    // 文件关联启动窗口落在不同的默认位置。
    builder = builder.inner_size(w, h).center();
  }
  // transparent 在 macOS 上要 macos-private-api 私有特性，而我们只用原生边框，不需要它；
  // Windows 透明窗口是圆角的前提（DWM 材质方案，见 apply_platform_window_tweaks）。
  #[cfg(not(target_os = "macos"))]
  {
    builder = builder.transparent(chrome.transparent);
  }
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
  log::info!("[win] 准备建窗 {label}");
  let win = builder.build()?;
  log::info!("[win] 建窗完成 {label}");
  // Windows 的无边框窗口 DWM 不保证给圆角（截图里就是直角的），显式向 DWM 要。
  apply_platform_window_tweaks(&win);
  // 几何已在 builder 阶段预应用（见上方注释）。window-state 插件的自动恢复已关
  // （lib.rs with_dont_restore）：它恢复时窗口已可见，且它不做离屏过滤——
  // 换过显示器布局后会把窗口从居中位置拽回存档的屏外坐标，用户看到的就是
  // 「打开时位置跳一下」。恢复只走预应用这一条路，保存仍归插件。
  Ok(win)
}

/// 事件路径与目标路径是否指向同一个文件。
///
/// Windows 的文件系统大小写不敏感，而 notify 报回来的大小写可能与用户打开时不同
/// （`C:\x\README.md` vs 磁盘上的 `readme.md`）——直接 `==` 会漏掉这次外部变更，
/// 表现为"别的程序改了文件，Lector 没有任何反应"。
fn paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
  #[cfg(windows)]
  {
    let a_s = a.as_os_str().to_string_lossy();
    let b_s = b.as_os_str().to_string_lossy();
    a_s.eq_ignore_ascii_case(b_s.as_ref())
  }
  #[cfg(not(windows))]
  {
    a == b
  }
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
        if paths_equal(&p, &watched) {
          let _ = emit_app.emit(
            "lector:file-changed",
            serde_json::json!({
              // 报「我们记录的那条路径」而不是事件路径：两者的分隔符/大小写可能不同，
              // 而前端是按 `===` 精确比对的，报事件路径会被它当成别的文件过滤掉。
              "path": watched.to_string_lossy(),
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

// ───────────────────── 图片上��命令（用户配置，命令模式专用） ─────────────────────
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
    // 中文名要留住（与前端 safeDropName 的 \p{L} 对���），不能被整段换成 '-'
    assert_eq!(sanitize_image_name("截图_2026.png").as_deref(), Some("截图_2026.png"));
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

  // ── 文档里的本地链接：路径解析（open_link） ──
  //
  // 这一段是**不可信内容**进来的地方，规则要么对要么全错，所以逐条钉住。

  /// 平台无关的测试用绝对路径。
  ///
  /// **不能写死 `/docs/book/ch1.md`**：Windows 上 `/…` 不是绝对路径（缺盘��前缀），
  /// `Path::is_absolute()` 为 false，于是会被 resolve_link_target 里那条
  /// 「文档路径必须是绝对路径」的守卫拒掉——上一版就是这么在 Windows runner 上
  /// 挂了三条（本机 macOS 全绿，只有 CI 的 Windows 作业才看得见）。
  fn abs_path(rel: &str) -> PathBuf {
    let base = if cfg!(windows) { "C:\\docs" } else { "/docs" };
    let sep = if cfg!(windows) { "\\" } else { "/" };
    PathBuf::from(format!("{base}{sep}{}", rel.replace('/', sep)))
  }

  /// 按**路径段**比较，不按字符串比。
  ///
  /// `Path::join` 会把链接原文里的分隔符原样留着（Windows 上 `./sub/ch2.md` 拼出来是
  /// `…\book\./sub/ch2.md`），所以逐字节比较会在 Windows 上假红。段比较既是平台无关的，
  /// 也更接近这几条断言真正说的意思——「这段相对路径解析到了哪儿」。
  /// （`Components` 会吃掉中间的 `.`，`..` 保留。）
  fn segs(p: &std::path::Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect()
  }

  #[test]
  fn link_test_fixtures_are_absolute_on_this_platform() {
    // 给下一个人留的路标：fixture 不是绝对路径时，上面那些用例会以 panic 的形式挂掉，
    // 而不是以「断言失败」的形式说清原因。这条先把话说在前面。
    assert!(abs_path("a.md").is_absolute());
  }

  #[test]
  fn link_relative_resolves_against_document_dir() {
    let doc = abs_path("book/ch1.md");
    let doc = doc.to_str().unwrap();

    // 链接原文一律写成带 `/` 的样子：那是作者在 md 里实际��写的形态
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md").unwrap()), segs(&abs_path("book/ch2.md")));
    assert_eq!(
      segs(&resolve_link_target(doc, "./sub/ch2.md").unwrap()),
      segs(&abs_path("book/sub/ch2.md"))
    );

    // 允许 ../ 出去：尺度对齐 Typora（手势门控，见函数上的说明）
    assert_eq!(
      segs(&resolve_link_target(doc, "../other/ch2.md").unwrap()),
      segs(&abs_path("book/../other/ch2.md"))
    );
  }

  #[test]
  fn link_strips_fragment_and_query() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md#小节").unwrap()), segs(&abs_path("ch2.md")));
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md?x=1#y").unwrap()), segs(&abs_path("ch2.md")));
    // 纯锚点没有路径可开
    assert_eq!(resolve_link_target(doc, "#小节"), Err("bad_href".into()));
  }

  #[test]
  fn link_absolute_and_file_url() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();

    // 绝对路径的**形状按平台来**：Windows 上得带盘符才算绝对
    let abs_href = abs_path("elsewhere/b.md");
    assert_eq!(
      resolve_link_target(doc, abs_href.to_str().unwrap()).unwrap(),
      abs_href
    );

    // file:// 同样按平台取形状，解析交给 url
    let (url, expect) = if cfg!(windows) {
      ("file:///C:/tmp/it%20has%20spaces.md", "C:\\tmp\\it has spaces.md")
    } else {
      ("file:///tmp/it%20has%20spaces.md", "/tmp/it has spaces.md")
    };
    assert_eq!(resolve_link_target(doc, url).unwrap(), PathBuf::from(expect));
  }

  #[test]
  fn link_rejects_other_schemes_but_not_windows_drive() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();
    assert_eq!(resolve_link_target(doc, "http://x/y.md"), Err("scheme".into()));
    assert_eq!(resolve_link_target(doc, "obsidian://open?vault=x"), Err("scheme".into()));
    // 盘符不是 scheme：C:/ 开头的绝对路径要认（Windows 上全靠这条）
    #[cfg(windows)]
    assert_eq!(
      resolve_link_target("C:\\docs\\a.md", "D:/other/b.md").unwrap(),
      PathBuf::from("D:/other/b.md")
    );
    // 非 Windows 上盘符路径当普通绝对路径处理即可，至少不能被当成 scheme 拒掉
    #[cfg(not(windows))]
    assert!(resolve_link_target(doc, "D:/other/b.md").is_ok());
  }

  #[test]
  fn link_requires_absolute_document_path() {
    // 文档路径不是绝对路径 → 拒。否则会按进程 CWD 拼出一个"碰巧存在"的路径
    assert_eq!(resolve_link_target("a.md", "b.md"), Err("bad_href".into()));
    assert_eq!(resolve_link_target("", "b.md"), Err("bad_href".into()));
    // 空链接先于文档路径被拒，所以这里的文档路径用哪种形状都行——但仍然按平台给
    let doc = abs_path("a.md");
    assert_eq!(resolve_link_target(doc.to_str().unwrap(), "   "), Err("bad_href".into()));
  }

  #[test]
  fn text_doc_extension_table() {
    for ok in ["a.md", "a.MD", "a.markdown", "a.txt"] {
      assert!(is_text_doc(std::path::Path::new(ok)), "{ok} 应当可打开");
    }
    for no in ["a.pdf", "a.png", "a", "a.md.bak"] {
      assert!(!is_text_doc(std::path::Path::new(no)), "{no} 不该可打开");
    }
  }
}
