use std::{
  borrow::Cow,
  collections::HashSet,
  path::{Path, PathBuf},
  sync::Mutex,
};

use tauri::http::{response::Builder, Request, Response};

/// 已打开文档的 baseDir，协议只放行这些目录内的文件（防穿越铁律）。
#[derive(Default)]
pub struct AllowedDirs(pub Mutex<HashSet<PathBuf>>);

/// 关窗后按仍打开的文档重建白名单。
pub fn reset_dirs(allowed: &AllowedDirs) {
  allowed.0.lock().unwrap().clear();
}

/// 幂等放行一个 baseDir（打开文档时调用）。
pub fn allow_dir(allowed: &AllowedDirs, file_path: &str) {
  let parent = PathBuf::from(file_path)
    .parent()
    .map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
  if let Some(dir) = parent {
    allowed.0.lock().unwrap().insert(dir);
  }
}

/// URL 形式：Windows 是 `http://lector-file.localhost/<encodeURIComponent(绝对路径)>`
/// （WebView2 只拦截 `http://<scheme>.localhost`），其余平台是
/// `lector-file://localhost/<encodeURIComponent(绝对路径)>`。web 端用
/// `convertFileSrc` 拼，relative 已由 editor sanitizeRelative 过滤；壳端再独立校验一次。
pub fn handle(allowed: &AllowedDirs, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
  let decoded = percent_decode(request.uri().path());

  if decoded.split('/').any(|seg| seg == "..") {
    return err(Response::builder().status(403), Cow::Borrowed(b"forbidden"));
  }
  let decoded = normalize_windows_path(decoded);
  let path = Path::new(&decoded);
  if !path.is_absolute() {
    return err(Response::builder().status(403), Cow::Borrowed(b"relative denied"));
  }
  let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
  let ok = {
    let set = allowed.0.lock().unwrap();
    set.iter().any(|dir| canon.starts_with(dir))
  };
  if !ok {
    return err(Response::builder().status(403), Cow::Borrowed(b"outside base dir"));
  }
  if canon
    .extension()
    .and_then(|e| e.to_str())
    .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
  {
    return err(Response::builder().status(403), Cow::Borrowed(b"svg denied"));
  }

  match std::fs::read(&canon) {
    Ok(bytes) => Response::builder()
      .status(200)
      .header("Content-Type", mime_for(canon.extension()))
      .body(Cow::Owned(bytes))
      .unwrap_or_else(|_| err(Response::builder().status(500), Cow::Borrowed(b"bad response"))),
    Err(_) => err(Response::builder().status(404), Cow::Borrowed(b"not found")),
  }
}

fn err(builder: Builder, body: Cow<'static, [u8]>) -> Response<Cow<'static, [u8]>> {
  builder
    .body(body)
    .unwrap_or_else(|_| {
      Response::builder()
        .status(500)
        .body(Cow::<[u8]>::Borrowed(b"error"))
        .unwrap()
    })
}

fn mime_for(ext: Option<&std::ffi::OsStr>) -> &'static str {
  match ext.and_then(|e| e.to_str()) {
    Some("png") => "image/png",
    Some("jpg") | Some("jpeg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    Some("avif") => "image/avif",
    _ => "application/octet-stream",
  }
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      if let Some(b) = hex_byte(bytes.get(i + 1).copied(), bytes.get(i + 2).copied()) {
        out.push(b);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn hex_byte(hi: Option<u8>, lo: Option<u8>) -> Option<u8> {
  let h = hi?;
  let l = lo?;
  let hv = (h as char).to_digit(16)?;
  let lv = (l as char).to_digit(16)?;
  Some(((hv << 4) | lv) as u8)
}

/// Windows：`http://lector-file.localhost/D%3A%5Cdir%5Cimg.png` 的 path 解码后是
/// `/D:\dir\img.png`，前导斜杠会让 `Path::is_absolute()`（Windows 要求盘符前缀）为 false，
/// 于是被当成相对路径拒掉、图片全 403。这里剥掉盘符路径前的那个斜杠。
/// Unix 的绝对路径本就以 `/` 开头，不能动。
#[cfg(windows)]
fn normalize_windows_path(p: String) -> String {
  let b = p.as_bytes();
  if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
    p[1..].to_string()
  } else {
    p
  }
}

#[cfg(not(windows))]
fn normalize_windows_path(p: String) -> String {
  p
}

#[cfg(test)]
mod tests {
  use super::{handle, normalize_windows_path, AllowedDirs};
  use tauri::http::Request;

  #[cfg(windows)]
  #[test]
  fn windows_drive_path_drops_leading_slash() {
    assert_eq!(normalize_windows_path("/D:\\a\\b.png".into()), "D:\\a\\b.png");
    assert_eq!(normalize_windows_path("/C:/x.png".to_string()), "C:/x.png");
    // 非盘符开头原样保留（Windows 协议 URL 不会出现这种）
    assert_eq!(normalize_windows_path("/foo/bar".into()), "/foo/bar");
  }

  #[cfg(not(windows))]
  #[test]
  fn unix_paths_are_untouched() {
    assert_eq!(normalize_windows_path("/Users/x/a.png".into()), "/Users/x/a.png");
  }

  /// 模拟 convertFileSrc 在 Windows 上产出的 URL（`http://lector-file.localhost/<encoded>`），
  /// 端到端验证：白名单目录内的文件能取到，目录外的被拒。
  #[test]
  fn serves_file_in_allowed_dir_and_rejects_outside() {
    let base = std::env::temp_dir().join(format!("lector-proto-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("images")).unwrap();
    let inside = base.join("images").join("a.png");
    std::fs::write(&inside, b"PNGDATA").unwrap();

    let allowed = AllowedDirs::default();
    allowed
      .0
      .lock()
      .unwrap()
      .insert(base.canonicalize().unwrap());

    let ok_uri = format!(
      "http://lector-file.localhost/{}",
      encode_uri_component(&inside.to_string_lossy())
    );
    let req = Request::builder().uri(ok_uri).body(Vec::new()).unwrap();
    assert_eq!(handle(&allowed, req).status(), 200);

    let outside = std::env::temp_dir().join(format!("lector-proto-out-{}.png", std::process::id()));
    std::fs::write(&outside, b"X").unwrap();
    let bad_uri = format!(
      "http://lector-file.localhost/{}",
      encode_uri_component(&outside.to_string_lossy())
    );
    let req2 = Request::builder().uri(bad_uri).body(Vec::new()).unwrap();
    assert_eq!(handle(&allowed, req2).status(), 403);

    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_file(&outside);
  }

  /// 与 JS 的 encodeURIComponent 同语义，够本测试用。
  fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
      let c = b as char;
      if c.is_ascii_alphanumeric()
        || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
      {
        out.push(c);
      } else {
        out.push_str(&format!("%{b:02X}"));
      }
    }
    out
  }
}
