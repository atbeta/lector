use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::io;

/// 原生菜单文案（zh / en）。
///
/// 系统标准动作（撤销/复制/退出…）走 `PredefinedMenuItem`，由系统本地化；
/// 但**应用动作**是我们自己建的 MenuItem，macOS 不会替我们翻译——英文系统下
/// 应用内全英文、菜单栏却一串中文。这里模仿 Web 层 i18n.ts 的结构：一张 zh 表、
/// 一张 en 表，建菜单时按 locale 取一套。
struct MenuText {
  new_doc: &'static str,
  open: &'static str,
  save: &'static str,
  save_as: &'static str,
  reload: &'static str,
  export_pdf: &'static str,
  open_default: &'static str,
  reveal: &'static str,
  clear_recent: &'static str,
  recent: &'static str,
  file_menu: &'static str,
  find: &'static str,
  insert_image: &'static str,
  edit_menu: &'static str,
  outline: &'static str,
  theme: &'static str,
  settings: &'static str,
  ui_zoom_in: &'static str,
  ui_zoom_out: &'static str,
  ui_zoom_reset: &'static str,
  font_in: &'static str,
  font_out: &'static str,
  font_reset: &'static str,
  view_menu: &'static str,
  markdown_help: &'static str,
  help_menu: &'static str,
}

const ZH: MenuText = MenuText {
  new_doc: "新建",
  open: "打开…",
  save: "保存",
  save_as: "另存为…",
  reload: "从磁盘重新载入",
  export_pdf: "导出为 PDF…",
  open_default: "用默认应用打开",
  reveal: "在 Finder 中显示",
  clear_recent: "清除菜单",
  recent: "最近打开",
  file_menu: "文件",
  find: "查找",
  insert_image: "插入图片…",
  edit_menu: "编辑",
  outline: "大纲",
  theme: "切换主题",
  settings: "设置…",
  ui_zoom_in: "放大界面",
  ui_zoom_out: "缩小界面",
  ui_zoom_reset: "恢复界面缩放",
  font_in: "增大字号",
  font_out: "减小字号",
  font_reset: "恢复默认字号",
  view_menu: "显示",
  markdown_help: "Markdown 语法参考",
  help_menu: "帮助",
};

const EN: MenuText = MenuText {
  new_doc: "New",
  open: "Open…",
  save: "Save",
  save_as: "Save As…",
  reload: "Reload from Disk",
  export_pdf: "Export as PDF…",
  open_default: "Open with Default App",
  reveal: "Reveal in Finder",
  clear_recent: "Clear Menu",
  recent: "Open Recent",
  file_menu: "File",
  find: "Find",
  insert_image: "Insert Image…",
  edit_menu: "Edit",
  outline: "Outline",
  theme: "Toggle Theme",
  settings: "Settings…",
  ui_zoom_in: "Zoom Interface In",
  ui_zoom_out: "Zoom Interface Out",
  ui_zoom_reset: "Reset Interface Zoom",
  font_in: "Increase Font Size",
  font_out: "Decrease Font Size",
  font_reset: "Reset Font Size",
  view_menu: "View",
  markdown_help: "Markdown Syntax Reference",
  help_menu: "Help",
};

/// 菜单语言：设置里的 language（zh-CN / en）优先，缺省跟随系统。
///
/// 与 Web 层的取值链一致（window.rs 建窗时把同一设置注入 __lectorLocale）。
/// 设置是「跟随系统」或没配时问操作系统——壳侧没有 navigator，只能走 sys-locale。
/// 菜单只在启动（与清空最近打开）时重建，所以运行中改语言要重启才轮到菜单。
fn menu_text(app: &AppHandle) -> &'static MenuText {
  let lang = crate::io::portable::resolve_config_dir(app)
    .ok()
    .and_then(|dir| std::fs::read_to_string(dir.join("lector-settings.json")).ok())
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .and_then(|v| v.get("language").and_then(|l| l.as_str()).map(str::to_string))
    .filter(|l| l == "zh-CN" || l == "en")
    .or_else(sys_locale::get_locale)
    .unwrap_or_default();
  if lang.to_lowercase().starts_with("zh") {
    &ZH
  } else {
    &EN
  }
}

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
  let mt = menu_text(app);
  let new_doc = MenuItem::with_id(app, "file-new", mt.new_doc, true, Some("CmdOrCtrl+N"))?;
  let open = MenuItem::with_id(app, "file-open", mt.open, true, Some("CmdOrCtrl+O"))?;
  let save = MenuItem::with_id(app, "file-save", mt.save, true, Some("CmdOrCtrl+S"))?;
  let save_as = MenuItem::with_id(app, "file-save-as", mt.save_as, true, Some("CmdOrCtrl+Shift+S"))?;
  // ⌘R 挂原生加速键是安全的：R 是纯 Latin 字符，没有下面缩放/字号那组
  // 「Shift 下字符变形」的匹配坑（见「显示」菜单段的长注释）。菜单吃掉按键后
  // keydown 不再进 webview，与 ⌘O / ⌘S 同批，不存在双重触发。
  let reload = MenuItem::with_id(app, "file-reload", mt.reload, true, Some("CmdOrCtrl+R"))?;
  let export_pdf = MenuItem::with_id(app, "file-export-pdf", mt.export_pdf, true, None::<&str>)?;
  let open_default = MenuItem::with_id(app, "file-open-default", mt.open_default, true, None::<&str>)?;
  let reveal = MenuItem::with_id(app, "file-reveal", mt.reveal, true, None::<&str>)?;

  let recent = io::load_recent(app);
  let mut recent_items: Vec<MenuItem<Wry>> = Vec::new();
  for (i, p) in recent.iter().enumerate() {
    let title = std::path::Path::new(p)
      .file_name()
      .map(|s| s.to_string_lossy().into_owned())
      .unwrap_or_else(|| p.clone());
    recent_items.push(MenuItem::with_id(app, format!("recent-{i}"), title, true, None::<&str>)?);
  }
  let clear = MenuItem::with_id(app, "recent-clear", mt.clear_recent, !recent.is_empty(), None::<&str>)?;
  let mut recent_refs: Vec<&dyn IsMenuItem<Wry>> =
    recent_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
  let sep = PredefinedMenuItem::separator(app)?;
  if !recent_items.is_empty() {
    recent_refs.push(&sep);
  }
  recent_refs.push(&clear);
  let recent_menu = Submenu::with_items(app, mt.recent, true, &recent_refs)?;

  let file_menu = Submenu::with_items(
    app,
    mt.file_menu,
    true,
    &[
      &new_doc,
      &open,
      &recent_menu,
      &PredefinedMenuItem::separator(app)?,
      &save,
      &save_as,
      &PredefinedMenuItem::separator(app)?,
      &reload,
      &export_pdf,
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
  let find = MenuItem::with_id(app, "edit-find", mt.find, true, Some("CmdOrCtrl+F"))?;
  let insert_image = MenuItem::with_id(app, "edit-insert-image", mt.insert_image, true, None::<&str>)?;
  let edit_menu = Submenu::with_items(
    app,
    mt.edit_menu,
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
  let outline = MenuItem::with_id(app, "view-outline", mt.outline, true, Some("CmdOrCtrl+Shift+O"))?;
  let theme = MenuItem::with_id(app, "view-theme", mt.theme, true, None::<&str>)?;
  let settings = MenuItem::with_id(app, "view-settings", mt.settings, true, Some("CmdOrCtrl+,"))?;
  // 界面缩放 / 字号这组的快捷键**不挂原生加速键**，由 Web 层接管（shortcutDispatch.ts）。
  // 两个原因：
  //   1. macOS 菜单的 key equivalent 按「字符」匹配，而这些键的字符在 Shift 下会变
  //      （= → +、- → _、0 → )）。muda 的加速键语法只认无 Shift 的字符，表达不出
  //      +/_/)："CmdOrCtrl+Plus" 直接解析失败被静默丢掉（所以「放大界面/增大字号」
  //      的加速键一直是空的）。
  //   2. 更糟的是撞车：⌘0 与 ⇧⌘0 的 key equivalent 都是 "0"，macOS 会把 ⇧⌘0 判给
  //      排在前面的「恢复界面缩放」，事件被菜单吃掉，Web 层的 font-size 分支根本收不到
  //      ——这正是「⇧⌘0 恢复默认字号不生效」。⌘- / ⇧⌘- 同理。
  // Web 层本来就拥有全部快捷键（Windows 没有菜单栏，⌘R 之类也走这条路），菜单项留着
  // 供点击与发现，键位说明以 ⌘/ 的键位表为准。
  let ui_zoom_in = MenuItem::with_id(app, "view-ui-zoom-in", mt.ui_zoom_in, true, None::<&str>)?;
  let ui_zoom_out = MenuItem::with_id(app, "view-ui-zoom-out", mt.ui_zoom_out, true, None::<&str>)?;
  let ui_zoom_reset = MenuItem::with_id(app, "view-ui-zoom-reset", mt.ui_zoom_reset, true, None::<&str>)?;
  let font_in = MenuItem::with_id(app, "view-font-in", mt.font_in, true, None::<&str>)?;
  let font_out = MenuItem::with_id(app, "view-font-out", mt.font_out, true, None::<&str>)?;
  let font_reset = MenuItem::with_id(app, "view-font-reset", mt.font_reset, true, None::<&str>)?;
  let view_menu = Submenu::with_items(
    app,
    mt.view_menu,
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
    MenuItem::with_id(app, "help-markdown", mt.markdown_help, true, None::<&str>)?;
  let help_menu = Submenu::with_items(app, mt.help_menu, true, &[&markdown_help])?;

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
    "file-new" => "new",
    "file-open" => "open",
    "file-save" => "save",
    "file-save-as" => "save-as",
    "file-reload" => "reload",
    "file-export-pdf" => "export-pdf",
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
    // 定向发给聚焦窗口：Emitter::emit 是全窗口广播，菜单动作（保存/查找/主题…）
    // 会在每个窗口各执行一遍。EventTarget 用全限定路径——本文件没有（也不该有）
    // cfg 门控的导入，直接 import 会在 macOS 构建报 unused。
    let _ = win.emit_to(
      tauri::EventTarget::webview_window(win.label().to_string()),
      "lector:menu",
      payload,
    );
  } else if let Some(main) = app.get_webview_window("main") {
    let _ = main.emit_to(
      tauri::EventTarget::webview_window(main.label().to_string()),
      "lector:menu",
      payload,
    );
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
