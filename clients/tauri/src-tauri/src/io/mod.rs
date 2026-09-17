//! 文件与窗口 IO。按域拆成子模块只为可读性——对外仍是 `crate::io::*` 一个面。
//!
//! 命令函数定义在 `commands`：`#[tauri::command]` 生成的包装宏只在定义模块里
//! 可达，所以 `lib.rs` 的 `generate_handler!` 必须写 `io::commands::<name>`，
//! 不能走下面的重导出。

pub(crate) mod commands;
mod fs;
mod watch;
mod window;

pub use commands::{clear_recent, load_recent, remove_recent};
pub use fs::{is_image_ext, is_text_doc};
pub use watch::WatcherStore;
pub use window::{ensure_main_window, forget_window, open_path, PendingOpens, WindowRegistry};
