//! Windows 11 Snap Layouts：悬停最大化按钮时弹出系统的布局浮窗。
//!
//! 为什么需要它：无边框窗口 + 自绘最大化按钮，系统不知道鼠标在「最大化按钮」上。
//! Windows 只给「对 WM_NCHITTEST 回答 HTMAXBUTTON」的窗口过程弹 Snap 浮窗，
//! 而 tao/wry 不让我们改主窗口的 hit-test 结果（winit#3884，Tauri#4531 upstream），
//! 页面又活在 WebView2 子窗口里——光标下的窗口是 WebView2，主窗口过程根本没机会回答。
//! 社区收敛到同一个做法：在自绘按钮的位置上盖一个**不绘制**的子窗口，由它的窗口过程
//! 回答 HTMAXBUTTON。这里自己实现，不引重型标题栏插件。
//!
//! 三个真机上踩过的坑（0945970 只过 cargo check，第一次真机验证全中）：
//! 1. **不要用 WS_EX_LAYERED + LWA_ALPHA(0)**。系统对分层窗口的命中判定按 alpha：
//!    全透明区域直接放行鼠标消息，覆盖层收不到 WM_NCHITTEST，Snap 浮窗自然不弹。
//!    正确做法是窗口类背景刷设成 NULL_BRUSH（从不擦除、从不绘制），窗口在视觉上
//!    完全隐形，却仍在命中链上。
//! 2. **SetWindowPos 必须带 HWND_TOP**。子窗口创建后默认在 z 序底部，而 WebView2 的
//!    子窗口比覆盖层先建、盖满整个客户区——不给 HWND_TOP，覆盖层就永远在它下面。
//! 3. **回了 HTMAXBUTTON，点击就是非客户区点击**：来的是 WM_NCLBUTTONDOWN/UP，
//!    不是 WM_LBUTTONUP。只监听后者等于点击最大化毫无反应。
//!
//! 覆盖层拥有那 46×32 像素的鼠标（这是机制的一部分，绕不开）：
//! - 悬停 → 系统弹 Snap 布局浮窗；同时 on_hover(true) 让 web 层给按钮补 :hover 样式；
//! - 点击 → on_toggle() 直接 toggle_maximize（web 层按钮收不到这次点击，
//!   图标状态照常由 resize 事件驱动，两条路殊途同归）。
//!
//! 几何与 chrome.ts 的自绘控件严格一致：右上 3 个 46×32 按钮（最小化/最大化/关闭），
//! 最大化 = 中间那颗 = 客户区右起第 2 颗。改 .win-btn 的宽度要同步这里。

#![cfg(target_os = "windows")]

use std::sync::Once;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
  TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, GetClientRect, GetWindowLongPtrW, RegisterClassExW,
  SetWindowLongPtrW, SetWindowPos, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HTMAXBUTTON, HWND_TOP,
  SWP_ASYNCWINDOWPOS, SWP_SHOWWINDOW, WM_DPICHANGED, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN,
  WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
  WS_VISIBLE,
};

/// 与 .win-btn / .window-controls 的 CSS 像素尺寸一致（DPI 缩放在 position_overlay 里做）
const BTN_W: i32 = 46;
const BAR_H: i32 = 32;
/// 最大化按钮是右起第 2 颗（最小化/最大化/关闭）
const MAX_BTN_FROM_RIGHT: i32 = 2;

const SUBCLASS_ID: usize = 0x4C45; // "LE"

const OVERLAY_CLASS: &[u16] = &[
  b'L' as u16, b'e' as u16, b'c' as u16, b't' as u16, b'o' as u16, b'r' as u16, b'S' as u16,
  b'n' as u16, b'a' as u16, b'p' as u16, b'O' as u16, b'v' as u16, b'e' as u16, b'r' as u16,
  b'l' as u16, b'a' as u16, b'y' as u16, 0,
];

struct SnapState {
  on_toggle: Box<dyn Fn() + Send>,
  on_hover: Box<dyn Fn(bool) + Send>,
  hovering: bool,
}

/// 把覆盖层贴到「最大化按钮」的位置（客户区坐标，物理像素）。
unsafe fn position_overlay(parent: HWND, child: HWND) {
  let mut rc: RECT = std::mem::zeroed();
  if GetClientRect(parent, &mut rc) == 0 {
    return;
  }
  // CSS 像素 → 物理像素：WebView2 按 DIP 布局，客户区坐标是物理像素
  let scale = GetDpiForWindow(parent) as f64 / 96.0;
  let w = (BTN_W as f64 * scale).round() as i32;
  let h = (BAR_H as f64 * scale).round() as i32;
  SetWindowPos(
    child,
    // HWND_TOP 不是可选项：WebView2 子窗口先建且盖满客户区，不给 TOP 覆盖层就在它下面
    HWND_TOP,
    rc.right - w * MAX_BTN_FROM_RIGHT,
    0,
    w,
    h,
    SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW,
  );
}

unsafe extern "system" fn overlay_wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  match msg {
    // 整句机制的题眼：回答「你在最大化按钮上」，系统就会弹 Snap 浮窗
    WM_NCHITTEST => HTMAXBUTTON as LRESULT,
    // 回了 HTMAXBUTTON，鼠标在这块区域里从此走非客户区消息：悬停 / 离开 / 按下 / 抬起
    WM_NCMOUSEMOVE => {
      let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SnapState;
      if !state.is_null() && !(*state).hovering {
        (*state).hovering = true;
        ((*state).on_hover)(true);
        // 只有进入时登记一次；TME_LEAVE 会在移出时回 WM_NCMOUSELEAVE
        let mut track = TRACKMOUSEEVENT {
          cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
          dwFlags: TME_LEAVE | TME_NONCLIENT,
          hwndTrack: hwnd,
          dwHoverTime: 0,
        };
        TrackMouseEvent(&mut track);
      }
      0
    }
    WM_NCMOUSELEAVE => {
      let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SnapState;
      if !state.is_null() && (*state).hovering {
        (*state).hovering = false;
        ((*state).on_hover)(false);
      }
      0
    }
    // 吞掉按下，抬起才切换——否则拖动经过按钮也会触发
    WM_NCLBUTTONDOWN => 0,
    WM_NCLBUTTONUP => {
      let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SnapState;
      if !state.is_null() {
        ((*state).on_toggle)();
      }
      0
    }
    WM_NCDESTROY => {
      let state = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut SnapState;
      if !state.is_null() {
        drop(Box::from_raw(state));
      }
      DefWindowProcW(hwnd, msg, wparam, lparam)
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

/// 父窗口子类：尺寸/DPI 变化时把覆盖层贴回最大化按钮。
unsafe extern "system" fn parent_subclass_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
  _id: usize,
  refdata: usize,
) -> LRESULT {
  if msg == WM_SIZE || msg == WM_DPICHANGED {
    let child = refdata as HWND;
    if !child.is_null() {
      position_overlay(hwnd, child);
    }
  } else if msg == WM_NCDESTROY {
    RemoveWindowSubclass(hwnd, Some(parent_subclass_proc), SUBCLASS_ID);
  }
  DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn register_overlay_class() {
  static REGISTER: Once = Once::new();
  REGISTER.call_once(|| unsafe {
    let hinstance = GetModuleHandleW(std::ptr::null());
    let mut wc: WNDCLASSEXW = std::mem::zeroed();
    wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = Some(overlay_wnd_proc);
    wc.hInstance = hinstance;
    // NULL_BRUSH = 从不擦除、从不绘制 → 窗口全隐形，但不在命中链上放行鼠标。
    // 不要换成 WS_EX_LAYERED + alpha 0：那才是鼠标穿透（见文件头第 1 条）。
    wc.hbrBackground = GetStockObject(NULL_BRUSH) as HBRUSH;
    wc.lpszClassName = OVERLAY_CLASS.as_ptr();
    RegisterClassExW(&wc);
  });
}

/// 在窗口的最大化按钮上盖一个不绘制、但可被命中的子窗口。
///
/// 参数刻意不碰 tauri 类型：父窗口是原生 HWND 的整数值，回调由调用方给——
/// 这个文件因此可以脱离 tauri 独立编译检查。
pub fn install(
  parent_isize: isize,
  on_toggle: impl Fn() + Send + 'static,
  on_hover: impl Fn(bool) + Send + 'static,
) {
  register_overlay_class();
  // HWND 是指针大小的透明包装（指针或 isize，随 windows-sys 版本变），按位转换最稳
  let parent: HWND = unsafe { std::mem::transmute_copy(&parent_isize) };
  let state = Box::into_raw(Box::new(SnapState {
    on_toggle: Box::new(on_toggle),
    on_hover: Box::new(on_hover),
    hovering: false,
  }));
  let child = unsafe {
    CreateWindowExW(
      // 扩展样式刻意留 0：WS_EX_LAYERED 会带来穿透，WS_EX_NOACTIVATE 会让
      // 「点非活动窗口的最大化」不激活窗口。社区验证过的写法就是 0。
      0,
      OVERLAY_CLASS.as_ptr(),
      std::ptr::null(),
      WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
      0,
      0,
      BTN_W,
      BAR_H,
      parent,
      std::ptr::null_mut(),
      GetModuleHandleW(std::ptr::null()),
      std::ptr::null(),
    )
  };
  if child.is_null() {
    unsafe { drop(Box::from_raw(state)) };
    return;
  }
  unsafe {
    SetWindowLongPtrW(child, GWLP_USERDATA, state as isize);
    position_overlay(parent, child);
    SetWindowSubclass(parent, Some(parent_subclass_proc), SUBCLASS_ID, child as usize);
  }
}
