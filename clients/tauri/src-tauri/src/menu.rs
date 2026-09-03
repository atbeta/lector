use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::io;

/// 构建原生菜单栏：macOS 带应用菜单（About/Quit），其余为 File/Edit/View。
/// 菜单项交给 web 处理：统一 emit `lector:menu`（payload = { action }）。
/// 「最近打开」变化后会整体重建（bind_document / Clear Menu 触发）。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "file-open", "Open…", true, Some("CmdOrCtrl+O"))?;
  let save = MenuItem::with_id(app, "file-save", "Save", true, Some("CmdOrCtrl+S"))?;
  let save_as = MenuItem::with_id(app, "file-save-as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;
  let find = MenuItem::with_id(app, "edit-find", "Find", true, Some("CmdOrCtrl+F"))?;
  let theme = MenuItem::with_id(app, "view-theme", "Toggle Theme", true, None::<&str>)?;
  let outline = MenuItem::with_id(app, "view-outline", "Outline", true, Some("CmdOrCtrl+Shift+O"))?;

  let recent = io::load_recent(app);
  let mut recent_items: Vec<MenuItem<Wry>> = Vec::new();
  for (i, p) in recent.iter().enumerate() {
    let title = std::path::Path::new(p)
      .file_name()
      .map(|s| s.to_string_lossy().into_owned())
      .unwrap_or_else(|| p.clone());
    recent_items.push(MenuItem::with_id(app, format!("recent-{i}"), title, true, None::<&str>)?);
  }
  let clear = MenuItem::with_id(app, "recent-clear", "Clear Menu", !recent.is_empty(), None::<&str>)?;
  let mut recent_refs: Vec<&dyn IsMenuItem<Wry>> =
    recent_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
  let sep = PredefinedMenuItem::separator(app)?;
  if !recent_items.is_empty() {
    recent_refs.push(&sep);
  }
  recent_refs.push(&clear);
  let recent_menu = Submenu::with_items(app, "Open Recent", true, &recent_refs)?;

  let file_menu = Submenu::with_items(
    app,
    "File",
    true,
    &[
      &open,
      &recent_menu,
      &PredefinedMenuItem::separator(app)?,
      &save,
      &save_as,
    ],
  )?;
  let edit_menu = Submenu::with_items(app, "Edit", true, &[&find])?;
  let view_menu = Submenu::with_items(app, "View", true, &[&theme, &outline])?;

  let mut owned: Vec<Submenu<Wry>> = Vec::new();
  #[cfg(target_os = "macos")]
  owned.push(Submenu::with_items(
    app,
    "Lector",
    true,
    &[
      &PredefinedMenuItem::about(app, None, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?);
  owned.push(file_menu);
  owned.push(edit_menu);
  owned.push(view_menu);

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
  let action = match id {
    "file-open" => "open",
    "file-save" => "save",
    "file-save-as" => "save-as",
    "edit-find" => "find",
    "view-theme" => "theme",
    "view-outline" => "outline",
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
