mod io;
mod menu;
mod protocol;

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
      for path in paths_from_argv(&std::env::args().collect::<Vec<_>>()) {
        open_if_markdown(app.handle(), &path);
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
      io::dir_for,
      io::watch,
      io::take_pending_open,
      io::load_settings,
      io::save_settings,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app, event| match event {
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
