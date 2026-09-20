//! 临时诊断（Windows）：定位"多个文档窗口在系统层面串了"。
//!
//! 症状：任务栏缩略图里点不同窗口，激活出来的总是同一个。**激活是操作系统按 HWND 做的，
//! 不经过我们的代码**，所以只能把系统层面的身份与实际发生的事打出来：
//!   - 每个窗口建出来时的 label / HWND / 窗口样式 / 扩展样式；
//!   - 每个文档窗口收到的 WM_ACTIVATE / WM_NCACTIVATE / WM_SETFOCUS / WM_MOUSEACTIVATE
//!     （点缩略图时系统到底激活了哪个 HWND）。
//! 定位完即删：它只写日志、不改行为。
#![cfg(target_os = "windows")]

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
  GetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE, WM_ACTIVATE, WM_MOUSEACTIVATE, WM_NCACTIVATE,
  WM_SETFOCUS,
};

const DIAG_SUBCLASS_ID: usize = 0x4C43_4449; // "LCDI"

unsafe extern "system" fn diag_subclass_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
  _id: usize,
  _data: usize,
) -> LRESULT {
  match msg {
    WM_ACTIVATE => log::info!("[diag] WM_ACTIVATE hwnd={:?} wparam={}", hwnd, wparam),
    WM_NCACTIVATE => log::info!("[diag] WM_NCACTIVATE hwnd={:?} wparam={}", hwnd, wparam),
    WM_SETFOCUS => log::info!("[diag] WM_SETFOCUS hwnd={:?}", hwnd),
    WM_MOUSEACTIVATE => log::info!("[diag] WM_MOUSEACTIVATE hwnd={:?}", hwnd),
    _ => {}
  }
  unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 记录窗口身份与样式，并挂上激活消息记录。
pub fn watch(win: &WebviewWindow) {
  let Ok(raw) = win.hwnd() else {
    log::warn!("[diag] 取不到 hwnd，label={}", win.label());
    return;
  };
  // HWND 在 windows-sys 里是指针大小的透明包装，按位转换最稳（见 snap.rs 的注释）。
  let bits = raw.0 as isize;
  let h: HWND = unsafe { std::mem::transmute_copy(&bits) };
  let (style, ex) = unsafe {
    (
      GetWindowLongPtrW(h, GWL_STYLE),
      GetWindowLongPtrW(h, GWL_EXSTYLE),
    )
  };
  log::info!(
    "[diag] 窗口 label={} hwnd={:?} style=0x{:x} exstyle=0x{:x}",
    win.label(),
    raw.0,
    style,
    ex
  );
  unsafe {
    SetWindowSubclass(h, Some(diag_subclass_proc), DIAG_SUBCLASS_ID, 0);
  }
}
