use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

/// 构建原生菜单栏：macOS 带应用菜单（About/Quit），其余为 File/Edit/View。
/// 菜单项交给 web 处理：统一 emit `lector:menu`（payload = { action }）。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "file-open", "Open…", true, Some("CmdOrCtrl+O"))?;
  let save = MenuItem::with_id(app, "file-save", "Save", true, Some("CmdOrCtrl+S"))?;
  let find = MenuItem::with_id(app, "edit-find", "Find", true, Some("CmdOrCtrl+F"))?;
  let theme = MenuItem::with_id(app, "view-theme", "Toggle Theme", true, None::<&str>)?;
  let outline = MenuItem::with_id(app, "view-outline", "Outline", true, Some("CmdOrCtrl+Shift+O"))?;

  let file_menu =
    Submenu::with_items(app, "File", true, &[&open, &PredefinedMenuItem::separator(app)?, &save])?;
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

/// 菜单事件 → web 事件。
pub fn route(app: &AppHandle, id: &str) {
  let action = match id {
    "file-open" => "open",
    "file-save" => "save",
    "edit-find" => "find",
    "view-theme" => "theme",
    "view-outline" => "outline",
    _ => return,
  };
  let _ = app.emit("lector:menu", serde_json::json!({ "action": action }));
}
