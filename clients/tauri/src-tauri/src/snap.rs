//! Windows 11 Snap Layouts：悬停最大化按钮时弹出系统的布局浮窗。
//!
//! 为什么需要它：无边框窗口 + 自绘最大化按钮，系统不知道鼠标在「最大化按钮」上。
//! Windows 只给「对 WM_NCHITTEST 回答 HTMAXBUTTON」的窗口过程弹 Snap 浮窗，
//! 而 tao/wry 不让我们改主窗口的 hit-test 结果（winit#3884，Tauri#4531 upstream）。
//! 社区五个插件收敛到同一个做法：在自绘按钮的位置上盖一个透明子窗口，
//! 由它的窗口过程回答 HTMAXBUTTON。这里自己实现，不引重型标题栏插件。
//!
//! 子窗口拥有那 46×32 像素的鼠标（这是机制的一部分，绕不开）：
//! - 悬停 → 系统弹 Snap 布局浮窗，这本身就是悬停反馈；
//! - 点击 → Rust 直接 toggle_maximize（web 层按钮收不到这次点击，
//!   图标状态照常由 resize 事件驱动，两条路殊途同归）。
//!
//! 几何与 chrome.ts 的自绘控件严格一致：右上 3 个 46×32 按钮（最小化/最大化/关闭），
//! 最大化 = 中间那颗 = 客户区右起第 2 颗。改 .win-btn 的宽度要同步这里。

#![cfg(target_os = "windows")]

use std::sync::Once;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, GetClientRect, GetWindowLongPtrW, RegisterClassExW,
  SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, CS_HREDRAW, CS_VREDRAW,
  GWLP_USERDATA, HTMAXBUTTON, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOZORDER, WM_DPICHANGED,
  WM_LBUTTONUP, WM_NCDESTROY, WM_NCHITTEST, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
  WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
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
    std::ptr::null_mut(),
    rc.right - w * MAX_BTN_FROM_RIGHT,
    0,
    w,
    h,
    SWP_NOZORDER | SWP_NOACTIVATE,
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
    WM_LBUTTONUP => {
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
    wc.lpszClassName = OVERLAY_CLASS.as_ptr();
    RegisterClassExW(&wc);
  });
}

/// 在窗口的最大化按钮上盖一个透明、不可激活、但可被命中的子窗口。
///
/// 参数刻意不碰 tauri 类型：父窗口是原生 HWND 的整数值，点击回调由调用方给——
/// 这个文件因此可以脱离 tauri 独立编译检查（本机没有 Windows 资源链）。
pub fn install(parent_isize: isize, on_toggle: impl Fn() + Send + 'static) {
  register_overlay_class();
  // HWND 是指针大小的透明包装（指针或 isize，随 windows-sys 版本变），按位转换最稳
  let parent: HWND = unsafe { std::mem::transmute_copy(&parent_isize) };
  let state = Box::into_raw(Box::new(SnapState {
    on_toggle: Box::new(on_toggle),
  }));
  let child = unsafe {
    CreateWindowExW(
      WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_NOPARENTNOTIFY,
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
    // 整体透明（alpha 0）但仍在命中链上——这就是「透明但拥有鼠标」的写法；
    // 不要用 WS_EX_TRANSPARENT，那等于把命中还回去，Snap 浮窗就不弹了。
    SetLayeredWindowAttributes(child, 0, 0, LWA_ALPHA);
    position_overlay(parent, child);
    SetWindowSubclass(parent, Some(parent_subclass_proc), SUBCLASS_ID, child as usize);
  }
}
