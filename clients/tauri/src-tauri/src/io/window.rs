use std::{
  collections::HashMap,
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
  },
};

#[cfg(target_os = "windows")]
use tauri::webview::PageLoadEvent;
#[cfg(target_os = "windows")]
use tauri::EventTarget;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{fs::canonical, watch::unwatch};
use crate::protocol;

/// path → window label，同一文件只开一个窗口。
#[derive(Default)]
pub struct WindowRegistry(pub Mutex<HashMap<PathBuf, String>>);

/// 新建窗口尚未就绪时，路径先挂在这里。
#[derive(Default)]
pub struct PendingOpens(pub Mutex<HashMap<String, String>>);

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) fn rebuild_allowed_dirs(app: &AppHandle) {
  let registry = app.state::<WindowRegistry>();
  let allowed = app.state::<protocol::AllowedDirs>();
  let paths: Vec<PathBuf> = crate::lock(&registry.0).keys().cloned().collect();
  protocol::reset_dirs(&allowed);
  for p in paths {
    protocol::allow_dir(&allowed, &p.to_string_lossy());
  }
}

/// 窗口销毁：从路径表、watcher、协议白名单里拿掉。
pub fn forget_window(app: &AppHandle, label: &str) {
  let registry = app.state::<WindowRegistry>();
  let dropped = {
    let mut map = crate::lock(&registry.0);
    let hit = map.iter().find(|(_, l)| l.as_str() == label).map(|(p, _)| p.clone());
    if let Some(ref p) = hit {
      map.remove(p);
    }
    hit
  };
  if let Some(p) = dropped {
    unwatch(app, &p);
  }
  let pending = app.state::<PendingOpens>();
  crate::lock(&pending.0).remove(label);
  rebuild_allowed_dirs(app);
}

/// 打开一篇文档：去重（已开则聚焦），否则新建窗口并记下 pending path。
pub fn open_path(app: &AppHandle, path: &str) {
  let canon = canonical(path).unwrap_or_else(|| PathBuf::from(path));
  protocol::allow_dir(&app.state::<protocol::AllowedDirs>(), path);
  let registry = app.state::<WindowRegistry>();
  let key = canon.clone();

  let existing = {
    let map = crate::lock(&registry.0);
    map.get(&key).cloned()
  };

  if let Some(label) = existing {
    if let Some(win) = app.get_webview_window(&label) {
      // 只聚焦，不发 lector:open。注册表条目存在就意味着该窗口的 web 层已加载
      // 此文档（bind_document 在加载完成后才写注册表，新窗口的加载由 pending-open
      // 覆盖）。此前这里 win.emit("lector:open") 有两个害处：
      //   1. Tauri 2 的 Emitter::emit 是广播给**所有**窗口——显示别的文档的窗口
      //      也会收到并加载这条路径，bind_document 覆盖它自己的注册表键，之后
      //      再开那个文档就重复建窗（多文档时打开已打开的文件会又开一个/串窗）。
      //   2. 即便定向发送，web 层收到也会无条件重读重载，脏文档还会弹丢弃确认。
      // 最小化的窗口 set_focus 只给焦点不还原（任务栏图标只闪不弹）——先还原再聚焦。
      if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
      }
      let _ = win.set_focus();
      return;
    }
    // 登记还在、窗口已关：清掉再新建
    crate::lock(&registry.0).remove(&key);
    unwatch(app, &key);
  }

  let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
  let label = format!("doc-{seq}");
  let pending = app.state::<PendingOpens>();
  crate::lock(&pending.0).insert(label.clone(), path.to_string());

  // 标题在**建窗时**就设成目标文档的名字，而不是先写 "Lector" 等 Web 层来纠正：
  // 首帧必然先出现那个占位标题，随后才切成文档名——用户看到的是"标题栏先闪一下
  // Lector，再出现文档"。占位一旦被画出来就已经晚了，所以必须在这里给对。
  let title = std::path::Path::new(path)
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or("Lector");
  match build_doc_window(app, &label, title) {
    Ok(_w) => {
      log::info!("[win] 文档窗口已就绪 {label}");
      let _ = crate::lock(&registry.0).insert(key, label);
    }
    Err(e) => {
      crate::lock(&pending.0).remove(&label);
      log::error!("failed to open window {label}: {e}");
    }
  }
}

/// 窗口边框的平台差异，单独成函数以便单测（无 GUI 也能验配置对不对）。
///
/// 教训写在这里，别再踩：**tauri.conf.json 里的 window 配置会覆盖 builder**。
/// 曾经在 config 里写了 `"decorations": false`，又在 macOS 分支里调
/// `.decorations(true)` 想改回来——不起作用，macOS 的红绿灯连同原生边框一起消失，
/// 用户只能从系统菜单关窗口。所以 config 只放不变量，平台差异一律在 builder 里做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowChrome {
  /// 是否保留系统绘制的窗口边框（macOS 的红绿灯就长在这里）
  pub decorations: bool,
  /// 窗口是否透明。Windows 需要：透明 + Mica/Acrylic 材质才有系统圆角
  /// （见 apply_platform_window_tweaks）。macOS 不需要。
  pub transparent: bool,
}

#[cfg(target_os = "macos")]
pub const fn window_chrome() -> WindowChrome {
  // macOS：保留原生边框 + 覆盖式标题栏。红绿灯是 mac 用户的肌肉记忆，
  // 自绘一套会立刻显得「不是 mac 应用」。
  WindowChrome { decorations: true, transparent: false }
}

/// 关闭按钮中心距窗口顶的逻辑点。只量、不 setFrame，给 Web 顶栏 padding 对齐用。
#[cfg(target_os = "macos")]
pub fn traffic_light_center_from_top(window: &tauri::WebviewWindow) -> Result<f64, String> {
  use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
  use std::sync::mpsc;

  let (tx, rx) = mpsc::channel();
  window
    .with_webview(move |webview| unsafe {
      let ns_window: &NSWindow = &*webview.ns_window().cast();
      let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        let _ = tx.send(Err("traffic light button missing".into()));
        return;
      };
      let in_window = NSView::convertRect_toView(&close, NSView::bounds(&close), None);
      let center = ns_window.frame().size.height - (in_window.origin.y + in_window.size.height / 2.0);
      let _ = tx.send(Ok(center));
    })
    .map_err(|e| e.to_string())?;
  rx.recv().map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
pub const fn window_chrome() -> WindowChrome {
  // Windows / Linux：无边框自绘，最小化/最大化/关闭由 Web 层的 chrome.ts 调窗口命令。
  // Windows 透明窗口是圆角的前提（DWM 材质方案，见 apply_platform_window_tweaks）。
  WindowChrome { decorations: false, transparent: true }
}

/// 平台级的窗口观感微调，在窗口创建后、显示前调用。
///
/// Windows 圆角方案（沿用 RelayCraft 验证过的路子）：无边框 + 透明窗口 +
/// DWM 背景材质——Win11 上 Mica，不支持时退回 Acrylic。只要挂了 DWM 材质，
/// DWM 就会按系统圆角裁窗口并画出原生投影；正文背景由 CSS 的 --background
/// 画满，材质只在窗口边缘可见。
/// 之前试过 DWMWA_WINDOW_CORNER_PREFERENCE：对无边框窗口（popup 样式）不生效，
/// 别再走回头路。材质色调按创建时的系统主题选一次，之后切主题不重刷
/// （影响只有边缘几像素的材质色调，可接受）。
#[cfg(target_os = "windows")]
fn apply_platform_window_tweaks(win: &tauri::WebviewWindow) {
  use window_vibrancy::{apply_acrylic, apply_mica};
  let dark = matches!(win.theme(), Ok(tauri::Theme::Dark));
  if dark {
    let _ = apply_acrylic(win, Some((18, 18, 22, 80)));
  } else if apply_mica(win, Some(false)).is_err() {
    // Win10 没有 Mica
    let _ = apply_acrylic(win, Some((242, 242, 250, 50)));
  }
  // 悬停最大化按钮弹 Snap 布局浮窗（Win11）——无边框窗口默认没有这个行为。
  // 覆盖层会接管那颗按钮的鼠标，所以点击在 Rust 侧 toggle，悬停再转告 web 层补 :hover。
  if let Ok(hwnd) = win.hwnd() {
    let toggle_win = win.clone();
    let hover_win = win.clone();
    let label = win.label().to_string();
    crate::snap::install(
      hwnd.0 as isize,
      move || {
        // 这个闭包是在**窗口过程**里被调的（WM_* 处理中），而 Tauri 的窗口 API
        // 会把调用派回主线程并等待结果——在窗口过程里重入就是死锁。
        // 实测症状：第一个窗口正常，再开第二个直接卡死、必须强杀。
        // 所以先跳出当前线程再碰 Tauri：窗口过程立刻返回，宿主线程自己去等。
        let w = toggle_win.clone();
        std::thread::spawn(move || {
          // tauri 没有 toggle_maximize，用 is_maximized 自己分派
          if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
          } else {
            let _ = w.maximize();
          }
        });
      },
      move |hovering| {
        // 同上：窗口过程里不能直接调 Tauri。emit_to 也要走一遍宿主线程。
        // 只发给本窗口：裸 emit 会广播，所有窗口的最大化按钮会一起亮。
        let w = hover_win.clone();
        let lbl = label.clone();
        std::thread::spawn(move || {
          let _ = w.emit_to(EventTarget::webview_window(lbl), "lector:win-max-hover", hovering);
        });
      },
    );
  }
}

#[cfg(not(target_os = "windows"))]
fn apply_platform_window_tweaks(_win: &tauri::WebviewWindow) {}

/// 主窗口也必须由此函数创建，不能交给 tauri.conf.json 的 app.windows。
///
/// 原因：config 里的 window 配置会覆盖 builder，而且是**所有平台共用**的。
/// 只要有一处窗口来自 config，就会出现「主窗口有原生边框、双击打开的窗口没有」
/// 这种平台差异跑偏——macOS 红绿灯消失那次的成因就是 config 与 builder 打架。
/// 统一入口后，平台差异只有 window_chrome() 一个来源。
pub fn ensure_main_window(app: &AppHandle) -> tauri::Result<()> {
  if app.get_webview_window("main").is_some() {
    return Ok(());
  }
  build_doc_window(app, "main", "Lector")?;
  Ok(())
}

/// 启动时要不要建空主窗口。
///
/// - 命令行已经带了文件：否（那些文件会各自建窗）
/// - 已经有窗口：否（macOS 上 `RunEvent::Opened` 可能比 setup 更早建了文档窗）
/// - 否则：是
pub fn should_create_startup_window(argv_has_files: bool, already_has_window: bool) -> bool {
  !argv_has_files && !already_has_window
}

/// `main` 是不是还停在欢迎空态（没绑定文档、也没有 pending）。
///
/// Finder 双击打开时，setup 可能因为 argv 为空先建了一个空的「Lector」窗；
/// 文档窗起来之后，这个空窗就是多出来的那个实例。
pub fn is_unused_startup_window(bound: bool, has_pending: bool) -> bool {
  !bound && !has_pending
}

/// 没有任何窗口时补一扇空主窗。给 macOS 的 Ready / Reopen 用：
/// 启动时 argv 空不代表没文件，空窗必须等 Opened 有机会先跑。
pub fn ensure_startup_window_if_idle(app: &AppHandle) {
  if !should_create_startup_window(false, !app.webview_windows().is_empty()) {
    return;
  }
  if let Err(e) = ensure_main_window(app) {
    log::error!("failed to create main window: {e}");
  }
}

/// 把空窗创建推迟到 Opened 有机会先到。
///
/// Apple 文档说 `application:openURLs:` 在 `didFinishLaunching` 之前，
/// 但 tao 把两者都转成事件后，偶发会看到 Ready 比 Opened 先到。
/// 空启动多等几十毫秒感觉不到；过早建空窗就会再多一个 Lector。
pub fn schedule_startup_window(app: &AppHandle) {
  let handle = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_millis(80));
    let _ = handle.run_on_main_thread({
      let handle = handle.clone();
      move || ensure_startup_window_if_idle(&handle)
    });
  });
}

/// Finder 打开文件后，关掉 setup 留下的未使用空 `main`。
pub fn close_unused_startup_window(app: &AppHandle) {
  let Some(win) = app.get_webview_window("main") else {
    return;
  };
  let registry = app.state::<WindowRegistry>();
  let bound = crate::lock(&registry.0).values().any(|l| l == "main");
  let pending = app.state::<PendingOpens>();
  let has_pending = crate::lock(&pending.0).contains_key("main");
  if !is_unused_startup_window(bound, has_pending) {
    return;
  }
  log::info!("[win] 关闭未使用的启动空窗");
  let _ = win.close();
}

/// 首次启动的默认窗口尺寸：按主屏工作区算，不写死。
///
/// 原来写死 900×720：在 1080p 上只占中间一小块，2K/4K 上更明显（用户反馈过
/// 「默认窗口不满」）；而随便换一个更大的固定值，又会在 1366×768 这类屏上顶出屏幕。
/// 取宽七成、高七成八，两端都能落到「合适」。
///
/// 只影响**第一次**启动：之后由 window-state 插件恢复用户自己调过的尺寸与位置。
fn default_window_size(app: &AppHandle) -> (f64, f64) {
  let fallback = (1180.0, 820.0);
  let Ok(Some(monitor)) = app.primary_monitor() else {
    return fallback;
  };
  let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
  (
    (logical.width * 0.72).clamp(960.0, 1680.0),
    (logical.height * 0.78).clamp(680.0, 1120.0),
  )
}

/// 上次退出时这个窗口标签的几何（读 window-state 插件的存档）。
/// (x, y, 宽, 高, 是否最大化)。最大化时用 prev_x/prev_y 作还原矩形。
fn saved_window_geometry(app: &AppHandle, label: &str) -> Option<(f64, f64, f64, f64, bool)> {
  let dir = super::portable::resolve_config_dir(app).ok()?;
  let text = fs::read_to_string(dir.join(".window-state.json")).ok()?;
  let map: serde_json::Value = serde_json::from_str(&text).ok()?;
  let st = map.get(label)?;
  let num = |k: &str| st.get(k).and_then(|v| v.as_f64());
  let (w, h) = (num("width")?, num("height")?);
  let maximized = st.get("maximized").and_then(|v| v.as_bool()).unwrap_or(false);
  if maximized {
    // 最大化时 x/y 是显示器左上角，prev_* 才是还原矩形的位置
    let x = num("prev_x").unwrap_or_else(|| num("x").unwrap_or(0.0));
    let y = num("prev_y").unwrap_or_else(|| num("y").unwrap_or(0.0));
    Some((x, y, w, h, true))
  } else {
    Some((num("x")?, num("y")?, w, h, false))
  }
}

/// 存档位置是否还在某块屏的工作区内（换过显示器布局时把窗口拉回居中）。
fn position_on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
  app.monitor_from_point(x, y).ok().flatten().is_some()
}

fn build_doc_window(app: &AppHandle, label: &str, title: &str) -> tauri::Result<tauri::WebviewWindow> {
  let chrome = window_chrome();
  let (w, h) = default_window_size(app);
  // 预读 window-state 存档，让窗口「出生即在正确位置」。
  //
  // 为什么不能建出来再 restore_state：那时窗口已可见，用户会看到「先在默认位置
  // 出现 → 再跳回上次位置」。而先 visible(false) 再 show 更糟——隐藏窗口里的
  // WKWebView 会被 WebKit 挂起乃至终结内容进程，第二个窗口直接卡死（实测复现，
  // 创建即 content process terminated；可见窗口能自动 reload 恢复，隐藏窗口不会）。
  // 预应用几何是唯一两头都对的做法：插件的就绪时自动恢复仍会执行，同值幂等。
  let saved = saved_window_geometry(app, label).filter(|(x, y, _, _, _)| position_on_screen(app, *x, *y));
  // 主题早应用：把设置里的明暗模式在首帧前交给页面（index.html 的内联脚本消费）。
  // 前端 load_settings 要等模块加载完才到——深色用户会先看到一帧浅色再变深，
  // 系统浅色 + 应用深色时最刺眼。这里同步读一次设置文件，成本可忽略。
  let theme_mode = super::portable::resolve_config_dir(app)
    .ok()
    .and_then(|dir| fs::read_to_string(dir.join("lector-settings.json")).ok())
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(str::to_string))
    .unwrap_or_default();
  let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
    .title(title)
    // 把文档名交给页面：<head> 里的内联脚本在首帧之前就用它替换占位标题。
    // 只设窗口标题不够——页面加载后会按自己的逻辑写标题（见 resetTitle），
    // 那一下就会把 "Lector" 闪出来。
    .initialization_script(&format!(
      "window.__lectorTitle = {}; window.__lectorTheme = {};",
      // serde_json 的字符串序列化就是合法的 JS 字面量（JSON ⊂ JS），
      // 文档名里的引号、反斜杠天然安全——不要手写转义。
      serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".into()),
      serde_json::to_string(&theme_mode).unwrap_or_else(|_| "\"\"".into())
    ))
    .min_inner_size(480.0, 360.0)
    // 拖放通道归壳（原生 DragDropEvent）：md/txt 直接走 open_path（同文件聚焦
    // 已有窗口），图片带逻辑坐标 emit 给 web 层插入。分发逻辑在 lib.rs 的
    // RunEvent::WindowEvent。此前关掉原生处理器走 HTML5 通道，但 WebView 的
    // File 对象拿不到磁盘路径——md 拖入打开必须要路径，只能用原生通道；
    // HTML5 拖放仅浏览器 dev（无壳）还在用，见 imageTransfer.ts 的分支。
    // 壳内聚焦块拖选文本不受影响：wry 的原生 drop 处理只截文件拖放，
    // 非文件（文本）拖放仍转发给 WebView2 默认处理。
    // 无边框窗口在 Windows 上需要显式要投影，否则窗口和桌面糊在一起
    .shadow(true)
    .decorations(chrome.decorations);
  if let Some((x, y, sw, sh, maximized)) = saved {
    // 存档是物理像素（window-state 插件按 PhysicalPosition/PhysicalSize 存取），
    // 而 builder 的 position/inner_size 是逻辑像素（tauri 文档原文）。不换算的话
    // HiDPI 屏（125%/150% 缩放）上预应用的位置和尺寸都按缩放偏大，插件就绪时
    // 再按物理值恢复一次——窗口「出现在一个位置、随后挪到另一个位置」。
    // 按落点显示器的缩放折算成逻辑值，预应用与插件恢复重合，不再跳动。
    let scale = app
      .monitor_from_point(x, y)
      .ok()
      .flatten()
      .map(|m| m.scale_factor())
      .unwrap_or(1.0);
    builder = builder.position(x / scale, y / scale).inner_size(sw / scale, sh / scale);
    if maximized {
      builder = builder.maximized(true);
    }
  } else {
    // 所有新窗口先以同一规则居中；没有历史记录时避免空态窗口和
    // 文件关联启动窗口落在不同的默认位置。
    builder = builder.inner_size(w, h).center();
  }
  // transparent 在 macOS 上要 macos-private-api 私有特性，而我们只用原生边框，不需要它；
  // Windows 透明窗口是圆角的前提（DWM 材质方案，见 apply_platform_window_tweaks）。
  #[cfg(not(target_os = "macos"))]
  {
    builder = builder.transparent(chrome.transparent);
  }
  // Windows：窗口先藏起来，等页面加载完再显示。
  //
  // 透明窗口在 WebView2 读出首帧之前是**完全透明**的——这类窗口没有重定向位图，
  // 客户端区域整块交给 DWM 合成，桌面就直接透过来了。冷启动时 WebView2 要起进程、
  // 建渲染器，那几百毫秒里用户看到的就是一个"透明框"。
  //
  // 藏起来等加载完再显示就没有这一帧：index.html 的内联脚本在解析时就铺好了
  // 主题画布色（tokens 的 --background），所以窗口第一次出现时已经是正确底色。
  //
  // 只管 Windows：macOS 上隐藏窗口会让 WKWebView 挂起乃至终结内容进程（见上面
  // 预读几何那段注释），而且 macOS 用原生边框、窗口本来就不透明，没有这个问题。
  #[cfg(target_os = "windows")]
  {
    builder = builder
      .visible(false)
      .on_page_load(|win, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
          let _ = win.show();
        }
      });
  }
  #[cfg(target_os = "macos")]
  {
    builder = builder
      .hidden_title(true)
      .title_bar_style(tauri::TitleBarStyle::Overlay)
      .accept_first_mouse(true)
      // 红绿灯交给系统，不要事后 setFrame——wry/tao 每次 drawRect 都会按这个值
      // 复位，跟手改坐标就是缩放时灯组上下跳的根因。
      // tao 的 y 是「按钮之上的空隙」（容器高 = 按钮高 + y）。(14, 16) 钉在
      // 系统那条 ~28pt 顶带；Web 顶栏收成 36px 去就位，见 chrome.css。
      .traffic_light_position(tauri::LogicalPosition::new(14.0, 16.0));
  }
  // 便携模式：WebView 用户数据也落在程序目录旁。前端 localStorage（侧栏 / 阅读位置 /
  // 未保存草稿 / 代码折行…）全在这个目录里，不重定向就换台机器全丢。
  // WKWebView 没有 data_directory 这条路（macOS 也不是便携包的目标平台）。
  #[cfg(not(target_os = "macos"))]
  if let Some(dir) = super::portable::webview_dir() {
    builder = builder.data_directory(dir);
  }
  log::info!("[win] 准备建窗 {label}");
  let win = builder.build()?;
  log::info!("[win] 建窗完成 {label}");
  // Windows 的无边框窗口 DWM 不保证给圆角（截图里就是直角的），显式向 DWM 要。
  apply_platform_window_tweaks(&win);
  // 兜底：页面加载没能完成时（devUrl 挂了、前端在解析前就抛错）别把窗口永远藏着。
  // 2.5s 是「页面加载」的宽限量级——正常路径下 on_page_load 早就 show 过了。
  #[cfg(target_os = "windows")]
  {
    let guard = win.clone();
    std::thread::spawn(move || {
      std::thread::sleep(std::time::Duration::from_millis(2500));
      if matches!(guard.is_visible(), Ok(false)) {
        log::warn!("[win] page never finished loading, showing anyway");
        let _ = guard.show();
      }
    });
  }
  // 几何已在 builder 阶段预应用（见上方注释）。window-state 插件的自动恢复已关
  // （lib.rs with_dont_restore）：它恢复时窗口已可见，且它不做离屏过滤——
  // 换过显示器布局后会把窗口从居中位置拽回存档的屏外坐标，用户看到的就是
  // 「打开时位置跳一下」。恢复只走预应用这一条路，保存仍归插件。
  Ok(win)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 回归防线：tauri.conf.json 里的 window 配置会覆盖 builder，
  /// 一旦有人在 config 里写死 decorations:false，macOS 会连红绿灯一起丢掉，
  /// 而这个问题在 macOS 上跑 `cargo test` 也不会报错（配置合法），
  /// 所以必须显式读 config 断言。
  #[test]
  fn window_config_does_not_hardcode_decorations() {
    let raw = include_str!("../../tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(raw).expect("tauri.conf.json 应当是合法 JSON");
    let windows = conf["app"]["windows"].as_array().expect("应有 app.windows");
    // 窗口一律由 io::window::build_doc_window / ensure_main_window 创建。
    // 一旦有人把窗口写回 config，就会多出一条创建路径，平台差异必然跑偏
    // （macOS 红绿灯消失那次就是 config 与 builder 打架）。
    assert!(
      windows.is_empty(),
      "app.windows 必须为空：窗口由 Rust 创建，平台差异只写在 window_chrome()"
    );
    for (i, w) in windows.iter().enumerate() {
      if let Some(d) = w.get("decorations") {
        panic!("app.windows[{i}].decorations = {d}：config 会覆盖 builder，不要在这里固定");
      }
    }
    // macOS 必须有原生边框，否则没有红绿灯
    #[cfg(target_os = "macos")]
    assert!(window_chrome().decorations, "macOS 必须保留原生窗口边框（红绿灯）");
    // Windows / Linux 走无边框自绘
    #[cfg(not(target_os = "macos"))]
    assert!(!window_chrome().decorations, "非 macOS 走 decorations:false 自绘");
  }

  /// macOS 双击 md：Opened 可能已经建了文档窗，argv 却是空的。
  /// 再补一扇空主窗就是「打开文档的同时还开了一个新 Lector」。
  #[test]
  fn file_open_must_not_create_empty_window_if_doc_already_open() {
    assert!(!should_create_startup_window(false, true));
  }

  #[test]
  fn dock_launch_without_file_creates_empty_window() {
    assert!(should_create_startup_window(false, false));
  }

  #[test]
  fn argv_files_skip_empty_window() {
    assert!(!should_create_startup_window(true, false));
  }

  #[test]
  fn unused_main_can_be_closed_after_finder_open() {
    assert!(is_unused_startup_window(false, false));
    assert!(!is_unused_startup_window(true, false));
    assert!(!is_unused_startup_window(false, true));
  }
}
