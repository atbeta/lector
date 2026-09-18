//! 「用其他应用打开」的展示信息：应用显示名 + 图标 PNG 字节。
//!
//! 这是纯装饰性查询——设置面板与菜单拿它把 `C:\…\Typora.exe` 渲染成
//! 「图标 + Typora」。拿不到（exe 无内嵌图标、.cmd/.bat 包装器、权限不足）
//! 都是正常情况，退回「路径基名 + 无图标」，命令本身不为装饰失败而报错。

use serde::Serialize;

#[derive(Serialize)]
pub struct AppInfo {
  /// 显示名：Windows 取 exe 版本资源的 FileDescription，macOS 取 bundle 的
  /// DisplayName/BundleName，都拿不到退回路径基名（去扩展名）。
  pub name: String,
  /// PNG 编码的图标字节，前端直接喂 <img>。拿不到为 None，前端画占位图标。
  pub icon_png: Option<Vec<u8>>,
}

pub fn app_info(path: &str) -> AppInfo {
  let (name, icon_png) = platform::query(path);
  AppInfo {
    name: name.filter(|n| !n.is_empty()).unwrap_or_else(|| stem(path)),
    icon_png,
  }
}

/// 路径基名去扩展名（与前端 core 的 appDisplayName 同一约定）。
fn stem(path: &str) -> String {
  std::path::Path::new(path)
    .file_stem()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_else(|| path.to_string())
}

#[cfg(windows)]
mod platform {
  use std::ffi::c_void;
  use std::ptr;

  use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
  };
  use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
  };
  use windows_sys::Win32::UI::Shell::ExtractIconExW;
  use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON};

  const ICON_SIZE: i32 = 32;

  pub fn query(path: &str) -> (Option<String>, Option<Vec<u8>>) {
    // SAFETY: 两个子查询各自管理自己的 Win32 句柄/缓冲，见函数内注释。
    unsafe { (file_description(path), icon_png(path)) }
  }

  fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
  }

  // ── 显示名：exe 版本资源里的 FileDescription ──
  // 「Visual Studio Code」「Typora」这种真名只存在于版本资源里；
  // 注册表/App Paths 那条路覆盖率低得多，不值得为装饰信息去翻。

  unsafe fn file_description(path: &str) -> Option<String> {
    let wide = to_wide(path);
    let mut handle = 0u32;
    let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
    if size == 0 {
      return None;
    }
    let mut buf = vec![0u8; size as usize];
    if GetFileVersionInfoW(wide.as_ptr(), 0, size, buf.as_mut_ptr() as *mut c_void) == 0 {
      return None;
    }
    // 先查翻译表（语言 + 代码页），再按它取 FileDescription；
    // 查不到就试两个最常见的固定组合（en-US Unicode / en-US 多字节）。
    let mut keys: Vec<String> = translation_keys(&buf);
    keys.push("040904b0".into());
    keys.push("040904e4".into());
    keys.iter().find_map(|k| query_string(&buf, k))
  }

  unsafe fn translation_keys(buf: &[u8]) -> Vec<String> {
    let sub = to_wide("\\VarFileInfo\\Translation");
    let mut ptr: *mut c_void = ptr::null_mut();
    let mut len = 0u32;
    if VerQueryValueW(buf.as_ptr() as *const c_void, sub.as_ptr(), &mut ptr, &mut len) == 0 || ptr.is_null() {
      return Vec::new();
    }
    // 每个条目一个 DWORD：低字语言、高字代码页。len 是字节数。
    let dwords =
      std::slice::from_raw_parts(ptr as *const u32, (len as usize) / std::mem::size_of::<u32>());
    dwords
      .iter()
      .map(|d| format!("{:04x}{:04x}", d & 0xffff, d >> 16))
      .collect()
  }

  unsafe fn query_string(buf: &[u8], lang_cp: &str) -> Option<String> {
    let sub = to_wide(&format!("\\StringFileInfo\\{lang_cp}\\FileDescription"));
    let mut ptr: *mut c_void = ptr::null_mut();
    let mut len = 0u32;
    if VerQueryValueW(buf.as_ptr() as *const c_void, sub.as_ptr(), &mut ptr, &mut len) == 0 || ptr.is_null() || len == 0
    {
      return None;
    }
    let s = std::slice::from_raw_parts(ptr as *const u16, len as usize);
    let text = String::from_utf16_lossy(s).trim_matches('\0').trim().to_string();
    if text.is_empty() { None } else { Some(text) }
  }

  // ── 图标：ExtractIconExW 拿 HICON，画进 32bpp DIB 读出像素，编码 PNG ──
  // 不用 SHGetFileInfoW：它建议先 CoInitialize，而命令跑在哪条线程不受我们控制；
  // ExtractIconExW 没有 COM 前提，代价是只认内嵌图标的可执行体（.cmd/.bat 会落空，
  // 那种本来也没有"自己的"图标）。

  unsafe fn icon_png(path: &str) -> Option<Vec<u8>> {
    let wide = to_wide(path);
    let mut hicon: HICON = ptr::null_mut();
    let n = ExtractIconExW(wide.as_ptr(), 0, &mut hicon, ptr::null_mut(), 1);
    if n == 0 || hicon.is_null() {
      return None;
    }
    let png = icon_to_png(hicon);
    DestroyIcon(hicon);
    png
  }

  unsafe fn icon_to_png(hicon: HICON) -> Option<Vec<u8>> {
    let hdc = CreateCompatibleDC(ptr::null_mut());
    if hdc.is_null() {
      return None;
    }
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: ICON_SIZE,
      biHeight: -ICON_SIZE, // 负值 = 自上而下，按行序读像素不用翻转
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      ..std::mem::zeroed()
    };
    let mut bits: *mut c_void = ptr::null_mut();
    let hbmp = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, ptr::null_mut(), 0);
    if hbmp.is_null() || bits.is_null() {
      DeleteDC(hdc);
      return None;
    }
    let old = SelectObject(hdc, hbmp);
    let ok = DrawIconEx(hdc, 0, 0, hicon, ICON_SIZE, ICON_SIZE, 0, ptr::null_mut(), DI_NORMAL);
    SelectObject(hdc, old);
    if ok == 0 {
      DeleteObject(hbmp);
      DeleteDC(hdc);
      return None;
    }
    let px = std::slice::from_raw_parts(bits as *const u8, (ICON_SIZE * ICON_SIZE * 4) as usize);
    let rgba = bgra_premul_to_rgba(px);
    DeleteObject(hbmp);
    DeleteDC(hdc);
    encode_png(&rgba, ICON_SIZE as u32, ICON_SIZE as u32)
  }

  /// GDI 画出来的 32bpp 位图是 **预乘 alpha** 的 BGRA；PNG 要的是直 Alpha RGBA。
  fn bgra_premul_to_rgba(px: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(px.len());
    for c in px.chunks_exact(4) {
      let (b, g, r, a) = (c[0] as u32, c[1] as u32, c[2] as u32, c[3] as u32);
      let (r, g, b) = if a > 0 && a < 255 {
        ((r * 255 + a / 2) / a, (g * 255 + a / 2) / a, (b * 255 + a / 2) / a)
      } else {
        (r, g, b)
      };
      out.extend_from_slice(&[r as u8, g as u8, b as u8, a as u8]);
    }
    out
  }

  fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
      let mut enc = png::Encoder::new(&mut out, w, h);
      enc.set_color(png::ColorType::Rgba);
      enc.set_depth(png::BitDepth::Eight);
      let mut writer = enc.write_header().ok()?;
      writer.write_image_data(rgba).ok()?;
    }
    Some(out)
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn unpremultiply_recovers_straight_alpha() {
      // 预乘 BGRA (b=64, g=64, r=128, a=128) → 直 alpha RGBA：r 回到 255，g/b 回到 128
      let out = bgra_premul_to_rgba(&[64, 64, 128, 128]);
      assert_eq!(out, vec![255, 128, 128, 128]);
    }

    #[test]
    fn opaque_and_transparent_pass_through() {
      let out = bgra_premul_to_rgba(&[10, 20, 30, 255, 0, 0, 0, 0]);
      assert_eq!(out, vec![30, 20, 10, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn notepad_has_icon_and_description() {
      // 真实 exe 端到端：notepad.exe 每台 Windows 都有，必带内嵌图标与版本资源。
      let info = crate::io::appinfo::app_info("C:\\Windows\\System32\\notepad.exe");
      assert!(!info.name.is_empty());
      let png = info.icon_png.expect("notepad.exe 应该能提取出图标");
      assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "图标应是 PNG 编码");
    }
  }
}

#[cfg(target_os = "macos")]
mod platform {
  use std::path::{Path, PathBuf};

  pub fn query(path: &str) -> (Option<String>, Option<Vec<u8>>) {
    let p = Path::new(path);
    if !path.ends_with(".app") {
      return (None, None);
    }
    // 不拉 objc2/cocoa：图标文件就在 bundle 里，sips 是系统自带的转换工具。
    // Info.plist 是 XML；这里只取两个键，宽容扫描比牵一个 plist 解析依赖划算。
    let plist = std::fs::read_to_string(p.join("Contents/Info.plist")).unwrap_or_default();
    let name = plist_value(&plist, "CFBundleDisplayName").or_else(|| plist_value(&plist, "CFBundleName"));
    let icon = plist_value(&plist, "CFBundleIconFile").and_then(|icon| {
      let file = if icon.ends_with(".icns") { icon } else { format!("{icon}.icns") };
      icns_to_png(&p.join("Contents/Resources").join(file))
    });
    (name, icon)
  }

  /// 取 `<key>K</key>` 后面第一个 `<string>…</string>`。解析失败就 None，由上层兜底。
  fn plist_value(plist: &str, key: &str) -> Option<String> {
    let pat = format!("<key>{key}</key>");
    let rest = &plist[plist.find(&pat)? + pat.len()..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")? + start;
    let v = rest[start..end].trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
  }

  fn icns_to_png(icns: &Path) -> Option<Vec<u8>> {
    if !icns.exists() {
      return None;
    }
    let tmp: PathBuf = std::env::temp_dir().join(format!("lector-icon-{}.png", std::process::id()));
    let out = std::process::Command::new("sips")
      .args(["-s", "format", "png", "-z", "64", "64"])
      .arg(icns)
      .arg("--out")
      .arg(&tmp)
      .output()
      .ok()?;
    if !out.status.success() {
      return None;
    }
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    bytes
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn plist_value_reads_first_string_after_key() {
      let plist = "<dict><key>CFBundleName</key><string>Typora</string></dict>";
      assert_eq!(plist_value(plist, "CFBundleName").as_deref(), Some("Typora"));
      assert_eq!(plist_value(plist, "CFBundleIconFile"), None);
    }
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
  pub fn query(_path: &str) -> (Option<String>, Option<Vec<u8>>) {
    (None, None)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn name_falls_back_to_stem() {
    // 不存在的路径：平台查询必然落空，名字应退回基名而不是空串。
    let info = app_info(if cfg!(windows) { "C:\\nope\\Typora.exe" } else { "/nope/Typora.app" });
    assert_eq!(info.name, "Typora");
    assert!(info.icon_png.is_none());
  }
}
