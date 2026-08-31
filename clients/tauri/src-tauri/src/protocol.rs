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

/// URL 形式：`lector-file:///<绝对文件路径>`（web 端按 baseDir+relative 拼接，
/// relative 已由 editor sanitizeRelative 过滤；壳端再独立校验一次）。
pub fn handle(allowed: &AllowedDirs, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
  let decoded = percent_decode(request.uri().path());

  if decoded.split('/').any(|seg| seg == "..") {
    return err(Response::builder().status(403), Cow::Borrowed(b"forbidden"));
  }
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
