//! 便携模式：exe 同目录存在 `lector.portable` 标记文件时，把配置 / WebView 数据 /
//! 日志全部落在程序目录下的 `data\`，而不是系统 appdata——用户复制整个目录就能带走
//! 自己的全部数据。
//!
//! 为什么看标记文件、而不是「有没有 data 目录」：语义明确，也不会被别的程序留下的
//! 同名目录误触发。安装版目录里没有这个标记，行为与以前完全一致。
//!
//! 目录写不进去（只读介质、解压到 Program Files）时，各处 `*_dir()` 返回 None，
//! 调用方回退系统目录——便携是尽力而为，不能因此启动失败。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 便携标记文件名，随便携包一起发。
const MARKER: &str = "lector.portable";

/// 给定目录下若有标记，返回该目录（便携根）。
fn portable_root_at(dir: &Path) -> Option<PathBuf> {
  dir.join(MARKER).is_file().then(|| dir.to_path_buf())
}

/// 当前可执行文件所在目录。
fn exe_dir() -> Option<PathBuf> {
  std::env::current_exe().ok()?.parent().map(PathBuf::from)
}

/// 便携根 <exe>；非便携 None。
fn root() -> Option<PathBuf> {
  portable_root_at(&exe_dir()?)
}

/// 便携数据根 <exe>/data。
fn data_root() -> Option<PathBuf> {
  root().map(|r| r.join("data"))
}

/// 便携配置目录 <exe>/data/config（会创建）。
pub fn config_dir() -> Option<PathBuf> {
  let dir = data_root()?.join("config");
  std::fs::create_dir_all(&dir).ok()?;
  Some(dir)
}

/// 便携 WebView 数据目录 <exe>/data/webview（会创建）。前端 localStorage 落在这里。
pub fn webview_dir() -> Option<PathBuf> {
  let dir = data_root()?.join("webview");
  std::fs::create_dir_all(&dir).ok()?;
  Some(dir)
}

/// 便携日志目录 <exe>/data/logs（会创建）。
pub fn log_dir() -> Option<PathBuf> {
  let dir = data_root()?.join("logs");
  std::fs::create_dir_all(&dir).ok()?;
  Some(dir)
}

/// 配置目录的唯一解析口：便携模式取 <exe>/data/config，否则系统的 app_config_dir。
///
/// 所有写配置 / 最近打开的地方都必须走这里，否则便携包会把配置漏在 appdata。
pub fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = config_dir() {
    return Ok(dir);
  }
  app.path().app_config_dir().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lector-portable-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn marker_next_to_exe_means_portable() {
    let dir = temp_dir("yes");
    std::fs::write(dir.join(MARKER), b"").unwrap();
    assert_eq!(portable_root_at(&dir).as_deref(), Some(dir.as_path()));
  }

  #[test]
  fn no_marker_is_not_portable() {
    let dir = temp_dir("no");
    assert_eq!(portable_root_at(&dir), None);
  }

  #[test]
  fn data_subdirs_hang_off_the_marked_dir() {
    let dir = temp_dir("dirs");
    std::fs::write(dir.join(MARKER), b"").unwrap();
    let root = portable_root_at(&dir).unwrap();
    assert_eq!(root.join("data").join("config"), dir.join("data").join("config"));
  }
}
