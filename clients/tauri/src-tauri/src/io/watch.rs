use std::{
  collections::HashMap,
  path::{Path, PathBuf},
  sync::Mutex,
};

use notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager};

use super::fs::file_mtime_ms;

/// path → watcher，关窗时卸掉。
#[derive(Default)]
pub struct WatcherStore(pub Mutex<HashMap<PathBuf, RecommendedWatcher>>);

/// 事件路径与目标路径是否指向同一个文件。
///
/// Windows 的文件系统大小写不敏感，而 notify 报回来的大小写可能与用户打开时不同
/// （`C:\x\README.md` vs 磁盘上的 `readme.md`）——直接 `==` 会漏掉这次外部变更，
/// 表现为"别的程序改了文件，Lector 没有任何反应"。
fn paths_equal(a: &Path, b: &Path) -> bool {
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
pub(crate) fn watch_file(app: &AppHandle, path: &str) {
  use notify::{RecursiveMode, Watcher};
  let target = PathBuf::from(path);
  let dir = target
    .parent()
    .unwrap_or_else(|| Path::new("."))
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
  crate::lock(&store.0).insert(target, w);
}

pub(crate) fn unwatch(app: &AppHandle, path: &Path) {
  let store = app.state::<WatcherStore>();
  crate::lock(&store.0).remove(path);
}
