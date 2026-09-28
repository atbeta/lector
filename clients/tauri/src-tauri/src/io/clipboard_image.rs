//! 把一张图片写入系统剪贴板。
//!
//! 正文里的图要么走 lector-file（和页面不同源，没有 CORS），要么是图床 https。
//! webview 画进 canvas 再读像素会被当成跨源污染，`toBlob` 直接抛。
//! 所以字节在壳里拿：本地文件只读已打开文档目录里的，远程只接受 http(s)。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::fs::{decode_base64, MAX_IMAGE_BYTES};
use crate::protocol::AllowedDirs;

const MAX_EDGE: u32 = 16_384;
const MAX_RGBA_BYTES: u64 = 256 * 1024 * 1024;

enum Classified {
  Path(PathBuf),
  Remote(url::Url),
  Inline(Vec<u8>),
}

pub async fn copy_image(app: &AppHandle, source: &str) -> Result<(), String> {
  let bytes = match classify(source)? {
    Classified::Path(path) => read_local(app, &path)?,
    Classified::Remote(url) => fetch_remote(url).await?,
    Classified::Inline(bytes) => bytes,
  };
  let (rgba, width, height) = decode_rgba(&bytes)?;
  let image = tauri::image::Image::new_owned(rgba, width, height);
  app.clipboard().write_image(&image).map_err(|e| e.to_string())
}

fn classify(source: &str) -> Result<Classified, String> {
  let source = source.trim();
  if source.is_empty() {
    return Err("empty image source".into());
  }
  if let Some(bytes) = decode_data_image(source)? {
    return Ok(Classified::Inline(bytes));
  }
  if source.contains(':') && !looks_like_windows_drive(source) {
    let url = url::Url::parse(source).map_err(|_| "unsupported image source".to_string())?;
    match url.scheme() {
      "http" | "https" => return Ok(Classified::Remote(url)),
      _ => return Err("unsupported image source".into()),
    }
  }
  let path = PathBuf::from(source);
  if !path.is_absolute() {
    return Err("image path must be absolute".into());
  }
  Ok(Classified::Path(path))
}

/// `C:\…` 含冒号，但不能当成 URL。
fn looks_like_windows_drive(source: &str) -> bool {
  let b = source.as_bytes();
  b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `data:image/png;base64,…`。svg 不收：剪贴板要的是位图，也不能让 svg 脚本进来。
fn decode_data_image(source: &str) -> Result<Option<Vec<u8>>, String> {
  let Some(rest) = source.strip_prefix("data:") else {
    return Ok(None);
  };
  let Some((meta, data)) = rest.split_once(',') else {
    return Err("bad data url".into());
  };
  let meta = meta.to_ascii_lowercase();
  if !meta.starts_with("image/") || meta.contains("svg") || !meta.contains("base64") {
    return Err("unsupported image source".into());
  }
  decode_base64(data).map(Some)
}

fn read_local(app: &AppHandle, path: &Path) -> Result<Vec<u8>, String> {
  let canon = path.canonicalize().map_err(|e| e.to_string())?;
  if !path_allowed(app, &canon) {
    return Err("image is outside the open document".into());
  }
  let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
  if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES as u64 {
    return Err("image too large".into());
  }
  let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
  if bytes.len() > MAX_IMAGE_BYTES {
    return Err("image too large".into());
  }
  Ok(bytes)
}

fn path_allowed(app: &AppHandle, canon: &Path) -> bool {
  let allowed = app.state::<AllowedDirs>();
  let set = crate::lock(&allowed.0);
  set.iter().any(|dir| canon.starts_with(dir))
}

async fn fetch_remote(url: url::Url) -> Result<Vec<u8>, String> {
  let client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::custom(|attempt| {
      if attempt.previous().len() >= 5 {
        return attempt.error("too many redirects");
      }
      match attempt.url().scheme() {
        "http" | "https" => attempt.follow(),
        _ => attempt.error("redirect left http(s)"),
      }
    }))
    .timeout(Duration::from_secs(20))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .get(url)
    .header(reqwest::header::USER_AGENT, "Lector")
    .send()
    .await
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?;
  if resp.content_length().is_some_and(|n| n > MAX_IMAGE_BYTES as u64) {
    return Err("image too large".into());
  }
  let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
  if bytes.len() > MAX_IMAGE_BYTES {
    return Err("image too large".into());
  }
  Ok(bytes.to_vec())
}

fn decode_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
  if bytes.len() > MAX_IMAGE_BYTES {
    return Err("image too large".into());
  }
  let reader = image::ImageReader::new(Cursor::new(bytes))
    .with_guessed_format()
    .map_err(|e| e.to_string())?;
  let mut limits = image::Limits::default();
  limits.max_image_width = Some(MAX_EDGE);
  limits.max_image_height = Some(MAX_EDGE);
  limits.max_alloc = Some(MAX_RGBA_BYTES);
  let mut reader = reader;
  reader.limits(limits);
  let rgba = reader.decode().map_err(|e| e.to_string())?.into_rgba8();
  let (width, height) = rgba.dimensions();
  Ok((rgba.into_raw(), width, height))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn classifies_remote_local_and_inline() {
    assert!(matches!(
      classify("https://cdn.example/a.png").unwrap(),
      Classified::Remote(_)
    ));
    assert!(classify("javascript:alert(1)").is_err());
    assert!(classify("file:///etc/passwd").is_err());
    assert!(classify("images/a.png").is_err());
    assert!(classify("").is_err());
    assert!(classify("data:image/svg+xml;base64,PHN2Zy8+").is_err());

    let abs = std::env::temp_dir().join("a.png");
    assert!(matches!(classify(abs.to_str().unwrap()).unwrap(), Classified::Path(_)));

    match classify("data:image/png;base64,aGVsbG8=").unwrap() {
      Classified::Inline(bytes) => assert_eq!(bytes, b"hello"),
      _ => panic!("data url should be inline bytes"),
    }
  }

  #[test]
  fn windows_drive_is_a_path_not_a_url() {
    let result = classify(r"C:\notes\images\a.png");
    if cfg!(windows) {
      assert!(matches!(result.unwrap(), Classified::Path(_)));
    } else {
      // 非 Windows 上这串不是绝对路径，也不能被当成带 scheme 的 URL。
      assert!(result.is_err());
    }
  }

  #[test]
  fn decodes_a_png() {
    use image::ImageEncoder;
    let mut encoded = Vec::new();
    let raw = [9u8, 8, 7, 255];
    image::codecs::png::PngEncoder::new(&mut encoded)
      .write_image(&raw, 1, 1, image::ExtendedColorType::Rgba8)
      .unwrap();
    let (rgba, w, h) = decode_rgba(&encoded).unwrap();
    assert_eq!((w, h), (1, 1));
    assert_eq!(&rgba, &raw);
  }
}
