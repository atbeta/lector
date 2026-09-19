use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::io;

/// 构建原生菜单栏。
///
/// 为什么要原生菜单：macOS 上没有菜单栏，用户会怀疑「这个应用没有另存为」；
/// 而窗口控件（复制/撤销/最小化）本来就该由系统菜单驱动，自绘一遍是重复劳动。
/// Windows 上菜单挂在每个窗口顶部，同样成立。
///
/// 分工：
/// - **系统标准动作**（撤销/重做/剪切/复制/粘贴/全选/窗口/退出）交给
///   `PredefinedMenuItem`，由系统本地化并自动作用于焦点控件，不用我们写实现。
/// - **应用动作**（打开/保存/查找/主题/大纲）emit `lector:menu`（payload = { action }），
///   由 Web 层处理——壳不认识文档状态，不该替 Web 做决定。
/// - 最近打开由壳直接协调窗口（打开或聚焦已有窗口），不经 Web。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
  // Windows / Linux 上不设菜单：默认菜单会闪一下再被我们覆掉，
  // 不设就没闪。快捷键另由 Web 层接管（见 packages/editor/src/main.ts）。
  if !cfg!(target_os = "macos") {
    return Ok(());
  }
  // ── 文件 ──
  let open = MenuItem::with_id(app, "file-open", "打开…", true, Some("CmdOrCtrl+O"))?;
  let save = MenuItem::with_id(app, "file-save", "保存", true, Some("CmdOrCtrl+S"))?;
  let save_as = MenuItem::with_id(app, "file-save-as", "另存为…", true, Some("CmdOrCtrl+Shift+S"))?;
  let reload = MenuItem::with_id(app, "file-reload", "从磁盘重新载入", true, None::<&str>)?;
  let open_default = MenuItem::with_id(app, "file-open-default", "用默认应用打开", true, None::<&str>)?;
  let reveal = MenuItem::with_id(app, "file-reveal", "在 Finder 中显示", true, None::<&str>)?;

  let recent = io::load_recent(app);
  let mut recent_items: Vec<MenuItem<Wry>> = Vec::new();
  for (i, p) in recent.iter().enumerate() {
    let title = std::path::Path::new(p)
      .file_name()
      .map(|s| s.to_string_lossy().into_owned())
      .unwrap_or_else(|| p.clone());
    recent_items.push(MenuItem::with_id(app, format!("recent-{i}"), title, true, None::<&str>)?);
  }
  let clear = MenuItem::with_id(app, "recent-clear", "清除菜单", !recent.is_empty(), None::<&str>)?;
  let mut recent_refs: Vec<&dyn IsMenuItem<Wry>> =
    recent_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
  let sep = PredefinedMenuItem::separator(app)?;
  if !recent_items.is_empty() {
    recent_refs.push(&sep);
  }
  recent_refs.push(&clear);
  let recent_menu = Submenu::with_items(app, "最近打开", true, &recent_refs)?;

  let file_menu = Submenu::with_items(
    app,
    "文件",
    true,
    &[
      &open,
      &recent_menu,
      &PredefinedMenuItem::separator(app)?,
      &save,
      &save_as,
      &PredefinedMenuItem::separator(app)?,
      &reload,
      &PredefinedMenuItem::separator(app)?,
      &open_default,
      &reveal,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::close_window(app, None)?,
    ],
  )?;

  // ── 编辑 ──
  // 撤销/剪切/复制/粘贴走系统实现：它们作用于当前焦点控件（CodeMirror），
  // 由系统派发标准 selector，比我们自己转发按键可靠。
  let find = MenuItem::with_id(app, "edit-find", "查找", true, Some("CmdOrCtrl+F"))?;
  let insert_image = MenuItem::with_id(app, "edit-insert-image", "插入图片…", true, None::<&str>)?;
  let edit_menu = Submenu::with_items(
    app,
    "编辑",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &find,
      &insert_image,
    ],
  )?;

  // ── 显示 ──
  let outline = MenuItem::with_id(app, "view-outline", "大纲", true, Some("CmdOrCtrl+Shift+O"))?;
  let theme = MenuItem::with_id(app, "view-theme", "切换主题", true, None::<&str>)?;
  let settings = MenuItem::with_id(app, "view-settings", "阅读设置…", true, Some("CmdOrCtrl+,"))?;
  let ui_zoom_in = MenuItem::with_id(app, "view-ui-zoom-in", "放大界面", true, Some("CmdOrCtrl+Plus"))?;
  let ui_zoom_out = MenuItem::with_id(app, "view-ui-zoom-out", "缩小界面", true, Some("CmdOrCtrl+-"))?;
  let ui_zoom_reset = MenuItem::with_id(app, "view-ui-zoom-reset", "恢复界面缩放", true, Some("CmdOrCtrl+0"))?;
  let font_in = MenuItem::with_id(app, "view-font-in", "增大字号", true, Some("CmdOrCtrl+Shift+Plus"))?;
  let font_out = MenuItem::with_id(app, "view-font-out", "减小字号", true, Some("CmdOrCtrl+Shift+-"))?;
  let font_reset = MenuItem::with_id(app, "view-font-reset", "恢复默认字号", true, Some("CmdOrCtrl+Shift+0"))?;
  let view_menu = Submenu::with_items(
    app,
    "显示",
    true,
    &[
      &outline,
      &PredefinedMenuItem::separator(app)?,
      &ui_zoom_in,
      &ui_zoom_out,
      &ui_zoom_reset,
      &PredefinedMenuItem::separator(app)?,
      &font_in,
      &font_out,
      &font_reset,
      &PredefinedMenuItem::separator(app)?,
      &theme,
      &settings,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::fullscreen(app, None)?,
    ],
  )?;

  // ── 帮助 ──
  let markdown_help =
    MenuItem::with_id(app, "help-markdown", "Markdown 语法参考", true, None::<&str>)?;
  let help_menu = Submenu::with_items(app, "帮助", true, &[&markdown_help])?;

  let mut owned: Vec<Submenu<Wry>> = Vec::new();
  #[cfg(target_os = "macos")]
  owned.push(Submenu::with_items(
    app,
    "Lector",
    true,
    &[
      &PredefinedMenuItem::about(app, None, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::services(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::hide_others(app, None)?,
      &PredefinedMenuItem::show_all(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?);
  owned.push(file_menu);
  owned.push(edit_menu);
  owned.push(view_menu);
  owned.push(help_menu);

  let refs: Vec<&dyn IsMenuItem<Wry>> = owned.iter().map(|s| s as &dyn IsMenuItem<Wry>).collect();
  let menu = Menu::with_items(app, &refs)?;
  app.set_menu(menu)?;
  Ok(())
}

/// 菜单事件 → 只发给当前焦点窗口；最近打开由壳直接协调窗口。
pub fn route(app: &AppHandle, id: &str) {
  if id == "recent-clear" {
    io::clear_recent(app);
    let _ = create(app);
    return;
  }
  if let Some(idx) = id.strip_prefix("recent-") {
    if let Ok(i) = idx.parse::<usize>() {
      let path = io::load_recent(app).get(i).cloned();
      if let Some(path) = path {
        if std::path::Path::new(&path).exists() {
          io::open_path(app, &path);
        } else {
          io::remove_recent(app, &path);
          let _ = create(app);
        }
      }
    }
    return;
  }
  // 帮助里的外部链接由壳直接开浏览器：不需要 Web 参与
  if id == "help-markdown" {
    let _ = open_external("https://commonmark.org/help/");
    return;
  }
  let action = match id {
    "file-open" => "open",
    "file-save" => "save",
    "file-save-as" => "save-as",
    "file-reload" => "reload",
    "file-open-default" => "open-default",
    "file-reveal" => "reveal",
    "edit-find" => "find",
    "edit-insert-image" => "insert-image",
    "view-theme" => "theme",
    "view-outline" => "outline",
    "view-settings" => "settings",
    "view-ui-zoom-in" => "ui-zoom-in",
    "view-ui-zoom-out" => "ui-zoom-out",
    "view-ui-zoom-reset" => "ui-zoom-reset",
    "view-font-in" => "font-size-in",
    "view-font-out" => "font-size-out",
    "view-font-reset" => "font-size-reset",
    _ => return,
  };
  let payload = serde_json::json!({ "action": action });
  let focused = app
    .webview_windows()
    .into_values()
    .find(|w| w.is_focused().unwrap_or(false));
  if let Some(win) = focused {
    let _ = win.emit("lector:menu", payload);
  } else if let Some(main) = app.get_webview_window("main") {
    let _ = main.emit("lector:menu", payload);
  }
}

/// 用系统默认浏览器打开外链。
#[cfg(target_os = "macos")]
pub fn open_external(url: &str) -> std::io::Result<()> {
  std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
pub fn open_external(url: &str) -> std::io::Result<()> {
  use std::os::windows::process::CommandExt;
  // 不能直接 spawn url：Windows 会把带 & 的 URL 解析成命令分隔符。
  // 交给 cmd 的 start，空标题参数是 start 的固定语法。cmd 是控制台程序，
  // 从 GUI 进程 spawn 会闪黑窗——CREATE_NO_WINDOW 压掉。
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  std::process::Command::new("cmd")
    .args(["/C", "start", "", url])
    .creation_flags(CREATE_NO_WINDOW)
    .spawn()
    .map(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn open_external(url: &str) -> std::io::Result<()> {
  std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
}
