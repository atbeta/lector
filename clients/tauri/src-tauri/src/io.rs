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
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder, WebviewUrl};

use crate::protocol;

/// path → window label 映射，单进程内做「同一文件只开一个窗口」去重。
#[derive(Default)]
pub struct WindowRegistry(pub Mutex<HashMap<PathBuf, String>>);

/// 保活 watch 句柄，避免 watcher 被提前 drop。
#[derive(Default)]
pub struct WatcherStore(pub Mutex<Vec<RecommendedWatcher>>);

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct ReadResult {
  path: String,
  content: String,
  mtime_ms: u64,
}

#[derive(Serialize)]
pub struct DirResult {
  base_dir: String,
}

#[derive(Deserialize)]
pub struct WriteRequest {
  path: String,
  content: String,
  mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteOutcome {
  Ok,
  Conflict { current_mtime_ms: u64 },
}

fn mtime_ms(path: &std::path::Path) -> io::Result<u64> {
  let md = fs::metadata(path)?;
  let t = md.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
  Ok(t.as_millis() as u64)
}

fn canonical(path: &str) -> Option<PathBuf> {
  fs::canonicalize(path).ok()
}

/// 原子写：写临时文件 + rename 到目标（Windows 同目录 replace 亦安全）。
fn atomic_write(path: &std::path::Path, content: &[u8]) -> io::Result<()> {
  let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
  let tmp = dir.join(format!(".lector-tmp-{}", std::process::id()));
  fs::write(&tmp, content)?;
  fs::rename(&tmp, path)?;
  Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadResult, String> {
  let buf = fs::read(&path).map_err(|e| e.to_string())?;
  let content = String::from_utf8_lossy(&buf).into_owned();
  let m = mtime_ms(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
  Ok(ReadResult { path, content, mtime_ms: m })
}

#[tauri::command]
pub fn write_file(req: WriteRequest) -> Result<WriteOutcome, String> {
  let path = std::path::Path::new(&req.path);
  let current = mtime_ms(path).map_err(|e| e.to_string())?;
  if current != req.mtime_ms {
    return Ok(WriteOutcome::Conflict { current_mtime_ms: current });
  }
  atomic_write(path, req.content.as_bytes()).map_err(|e| e.to_string())?;
  Ok(WriteOutcome::Ok)
}

#[tauri::command]
pub fn dir_for(path: String) -> Result<DirResult, String> {
  let p = std::path::Path::new(&path);
  let dir = p.parent().unwrap_or_else(|| std::path::Path::new("."));
  Ok(DirResult { base_dir: dir.to_string_lossy().into_owned() })
}

#[tauri::command]
pub fn watch(path: String, app: AppHandle) -> Result<bool, String> {
  watch_file(&app, &path);
  Ok(true)
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
  fs::write(&path, text).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
  use tauri_plugin_dialog::DialogExt;
  let picked = app
    .dialog()
    .file()
    .add_filter("Markdown", &["md", "markdown", "txt"])
    .blocking_pick_file();
  Ok(picked
    .and_then(|f| f.into_path().ok())
    .map(|p| p.to_string_lossy().into_owned()))
}

/// 打开一篇文档：去重（已开则聚焦），否则新建窗口并 emit lector:open。
pub fn open_path(app: &AppHandle, path: &str) {
  let canon = canonical(path).unwrap_or_else(|| PathBuf::from(path));
  // 放行该文档 baseDir，供 lector-file:// 协议解析相对图片
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
    }
    return;
  }

  let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
  let label = format!("doc-{seq}");
  match WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
    .title("Lector")
    .inner_size(900.0, 720.0)
    .build()
  {
    Ok(win) => {
      let _ = registry.0.lock().unwrap().insert(key, label.clone());
      let _ = win.emit("lector:open", serde_json::json!({ "path": path }));
    }
    Err(e) => log::error!("failed to open window {label}: {e}"),
  }
}

/// 监听文件所在目录，变化时 emit lector:file-changed；watcher 存进 store 保活。
pub fn watch_file(app: &AppHandle, path: &str) {
  use notify::{Config, RecursiveMode, Watcher};
  let target = PathBuf::from(path);
  let dir = target.parent().unwrap_or_else(|| std::path::Path::new(".")).to_path_buf();
  let emit_app = app.clone();
  let watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    if let Ok(ev) = res {
      for p in ev.paths {
        if p == target {
          let _ = emit_app.emit(
            "lector:file-changed",
            serde_json::json!({ "path": p.to_string_lossy(), "mtime_ms": mtime_ms(&target).unwrap_or_default() }),
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
  }
  let store = app.state::<WatcherStore>();
  store.0.lock().unwrap().push(w);
  // 忽略 Config 默认值引用，仅占位避免未用告警
  let _ = Config::default();
}
