mod io;
mod menu;
mod protocol;
#[cfg(target_os = "windows")]
mod snap;

use std::path::PathBuf;
use tauri::{AppHandle, Manager, RunEvent};

use io::{open_path, PendingOpens, WatcherStore, WindowRegistry};
use protocol::AllowedDirs;

fn open_if_markdown(app: &AppHandle, path: &str) {
  let p = PathBuf::from(path);
  let is_md = matches!(
    p.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(),
    Some("md") | Some("markdown") | Some("txt")
  );
  if is_md {
    open_path(app, path);
  }
}

/// 从 argv 里挑出 markdown 路径（跳过程序自身与 flag）。
fn paths_from_argv(argv: &[String]) -> Vec<String> {
  argv
    .iter()
    .filter(|a| !a.starts_with('-'))
    .skip(1)
    .cloned()
    .collect()
}

pub fn run() {
  let app = tauri::Builder::default()
    .manage(WindowRegistry::default())
    .manage(WatcherStore::default())
    .manage(AllowedDirs::default())
    .manage(PendingOpens::default())
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      for path in paths_from_argv(&argv) {
        open_if_markdown(app, &path);
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    // 窗口状态：退出时记住尺寸/位置/是否最大化，启动时恢复。
    // 必须在建窗口（setup 里的 ensure_main_window）**之前**注册——
    // 插件是靠 on_window_ready 钩子把状态写回刚建好的窗口上的。
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Debug)
            .targets([
              tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
              tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ])
            .build(),
        )?;
      }
      let _ = menu::create(app.handle());
      let argv: Vec<String> = std::env::args().collect();
      let opened = paths_from_argv(&argv);
      if opened.is_empty() {
        // 没有带文件启动：建主窗口（空态）。
        // 窗口由 io::ensure_main_window 统一创建，见该函数上的注释。
        if let Err(e) = io::ensure_main_window(app.handle()) {
          log::error!("failed to create main window: {e}");
        }
      } else {
        for path in &opened {
          open_if_markdown(app.handle(), path);
        }
      }
      Ok(())
    })
    .register_uri_scheme_protocol("lector-file", |ctx, request| {
      let allowed = ctx.app_handle().state::<AllowedDirs>();
      protocol::handle(&allowed, request)
    })
    .invoke_handler(tauri::generate_handler![
      io::read_file,
      io::write_file,
      io::open_url,
      io::open_with_default,
      io::reveal_in_folder,
      io::watch,
      io::take_pending_open,
      io::load_settings,
      io::save_settings,
      io::bind_document,
      io::save_image,
      io::run_image_command,
      io::test_image_command,
      io::recent_list,
      io::recent_clear,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app, event| match event {
    // 只有 macOS 有这一路：Finder 的双击/拖到 Dock 走 Apple Event。
    // Windows 的文件关联走 argv（见 setup 与 single-instance 回调），
    // 所以在别的平台这个 variant 根本不存在，必须 gate 掉，否则 Windows 编不过。
    #[cfg(target_os = "macos")]
    RunEvent::Opened { urls } => {
      for url in urls {
        if let Ok(p) = url.to_file_path() {
          open_if_markdown(app, &p.to_string_lossy());
        }
      }
    }
    RunEvent::WindowEvent {
      label,
      event: tauri::WindowEvent::Destroyed,
      ..
    } => {
      io::forget_window(app, &label);
    }
    RunEvent::MenuEvent(id) => menu::route(app, id.id().0.as_str()),
    RunEvent::ExitRequested { .. } => {}
    _ => {}
  });
}
