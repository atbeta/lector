mod io;
mod menu;
mod pdf;
mod protocol;
#[cfg(target_os = "windows")]
mod snap;

use std::path::PathBuf;
use tauri::{AppHandle, Manager, RunEvent};

use io::{open_path, PendingOpens, WatcherStore, WindowRegistry};
use protocol::AllowedDirs;

fn open_if_markdown(app: &AppHandle, path: &str) {
  // 扩展名表与 open_link 共用一份（io::is_text_doc）
  if io::is_text_doc(&PathBuf::from(path)) {
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
      // 这个回调是在插件隐藏窗口的**窗口过程**里被调的（WM_COPYDATA 处理中，
      // 见 tauri-plugin-single-instance 的 windows.rs）——和 snap.rs 踩过的是同一类坑：
      // 在窗口过程里同步调 Tauri 建窗 API 会重入死锁，症状就是「双击再开一个 md，
      // 新窗口卡死只能强杀」（第一个窗口走 setup，不在窗口过程里，所以没事）。
      // 修法与 snap.rs 一致：先跳出窗口过程，把建窗丢给普通线程，
      // 由它经事件循环回到主线程执行。
      let app = app.clone();
      let paths = paths_from_argv(&argv);
      std::thread::spawn(move || {
        for path in paths {
          open_if_markdown(&app, &path);
        }
      });
    }))
    .plugin(tauri_plugin_dialog::init())
    // 剪贴板读：右键菜单里的「粘贴」靠它（web 的 navigator.clipboard.readText
    // 在 macOS webview 里必被拒，见 Cargo.toml 注释）。
    .plugin(tauri_plugin_clipboard_manager::init())
    // 窗口状态：退出时记住尺寸/位置/是否最大化，启动时恢复。
    // 必须在建窗口（setup 里的 ensure_main_window）**之前**注册——
    // 插件是靠 on_window_ready 钩子把状态写回刚建好的窗口上的。
    // 主窗口跳过插件的自动恢复：几何由 io.rs::build_doc_window 在建窗前预应用
  // （窗口可见前），插件的恢复发生在窗口就绪后——可见窗口被二次挪动就是
  // 「打开时位置变化」。动态文档窗口（doc-N）的 label 无法提前注册跳过，
  // 但其预应用与插件恢复读同一存档、同值幂等，且插件自带显示器存在性检查。
  // 保存不受影响，仍归插件。
  .plugin(
    tauri_plugin_window_state::Builder::default()
      .skip_initial_state("main")
      .build(),
  )
    .setup(|app| {
      // 日志三路：Stdout（开发）、Webview（控制台）、文件（Windows 双击启动时唯一能找回的）。
      // 之前整段包在 cfg!(debug_assertions) 里——用户装的 release 包一条日志都没有，
      // 排查「第二个窗口卡死」时无据可查（上次加的埋点就是这么丢的）。
      // release 也落文件，级别降到 Info；文件在 %APPDATA%\com.lector.reader\logs\。
      let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
      } else {
        log::LevelFilter::Info
      };
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(level)
          .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
          ])
          .build(),
      )?;
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
      io::read_clipboard,
      io::open_link,
      io::load_settings,
      io::save_settings,
      io::bind_document,
      io::save_image,
      io::run_image_command,
      io::test_image_command,
      io::recent_list,
      io::recent_clear,
      pdf::print_to_pdf,
      io::webview_ready,
      io::export_pdf_background,
      io::print_job_done,
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
