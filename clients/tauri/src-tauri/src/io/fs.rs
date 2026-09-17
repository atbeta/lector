use std::{
  fs, io,
  path::PathBuf,
  time::UNIX_EPOCH,
};

pub fn file_mtime_ms(path: &std::path::Path) -> io::Result<u64> {
  let md = fs::metadata(path)?;
  let t = md.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
  Ok(t.as_millis() as u64)
}

pub(crate) fn canonical(path: &str) -> Option<PathBuf> {
  fs::canonicalize(path).ok()
}

/// 本应用能打开的文档扩展名表（open_if_markdown 与 open_link 共用一份）。
pub fn is_text_doc(path: &std::path::Path) -> bool {
  matches!(
    path.extension()
      .and_then(|e| e.to_str())
      .map(str::to_lowercase)
      .as_deref(),
    Some("md") | Some("markdown") | Some("txt")
  )
}

/// 拖放分发用：是否图片扩展名。与编辑器 imageInsert.ts 的 IMAGE_EXT 保持一致。
pub fn is_image_ext(path: &std::path::Path) -> bool {
  matches!(
    path.extension()
      .and_then(|e| e.to_str())
      .map(str::to_lowercase)
      .as_deref(),
    Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("avif")
  )
}

/// 把文档里的链接解析成一个待打开的本地路径。只解析，不碰文件系统。
///
/// **尺度比相对图片宽，这是有意的**：相对图片必须锁在文档目录树内（防路径穿越），
/// 因为图片是渲染时**自动加载**的，没有用户手势——一份文档就能静默去读机器上的文件。
/// 链接则是**手势门控**的：用户真的点了才走，结果也只是开一个只读窗口显示那个文件，
/// 没有外发通道、不执行脚本、不写目标。所以相对路径（含 `../`）、绝对路径、`file://`
/// 都认，跟 Typora 对齐。剩下的门槛都是零成本的那几道：扩展名、存在性、scheme。
pub(crate) fn resolve_link_target(doc_path: &str, href: &str) -> Result<PathBuf, String> {
  let raw = href.trim();
  if raw.is_empty() {
    return Err("bad_href".into());
  }
  // 锚点与查询串不是路径的一部分（文内锚点本轮不做）
  let cut = raw.find(['#', '?']).unwrap_or(raw.len());
  let path_part = &raw[..cut];
  if path_part.is_empty() {
    return Err("bad_href".into());
  }

  if path_part.to_ascii_lowercase().starts_with("file://") {
    // 交给 url：百分号转义、Windows 盘符、UNC 它都比手写稳
    let u = url::Url::parse(path_part).map_err(|_| "bad_href".to_string())?;
    return u.to_file_path().map_err(|_| "bad_href".to_string());
  }

  // Windows 盘符（`C:\` / `C:/`）看着像 scheme，先认出来，别被下面的判断误杀
  let b = path_part.as_bytes();
  let is_drive = b.len() >= 2
    && b[0].is_ascii_alphabetic()
    && b[1] == b':'
    && (b.len() == 2 || matches!(b[2], b'/' | b'\\'));
  if !is_drive {
    if let Some(i) = path_part.find(':') {
      let scheme = &path_part[..i];
      let looks_like_scheme = !scheme.is_empty()
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
      // http / mailto / obsidian 这些 web 层已经分过流；走到这里说明不是预期的输入，
      // 明确拒掉而不是拿去拼路径
      if looks_like_scheme {
        return Err("scheme".into());
      }
    }
  }

  let p = PathBuf::from(path_part);
  if p.is_absolute() {
    return Ok(p);
  }
  // 相对路径按当前文档所在目录解析。文档路径必须是绝对路径：壳里它来自对话框/argv，
  // 一定绝对；不是绝对就说明前端传错了东西，宁可拒掉也不要按进程 CWD 拼出一个
  // "碰巧存在"的路径
  let doc = PathBuf::from(doc_path.trim());
  if doc_path.trim().is_empty() || !doc.is_absolute() {
    return Err("bad_href".into());
  }
  let dir = doc.parent().ok_or_else(|| "bad_href".to_string())?;
  Ok(dir.join(p))
}

/// 原子写：同目录 temp + rename。Windows 先删目标再 rename。
pub fn atomic_write(path: &std::path::Path, content: &[u8]) -> io::Result<()> {
  let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
  let tmp = dir.join(format!(
    ".lector-tmp-{}-{}",
    std::process::id(),
    std::time::SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0)
  ));
  fs::write(&tmp, content)?;
  let rename = fs::rename(&tmp, path);
  if rename.is_err() && path.exists() {
    let _ = fs::remove_file(path);
    if let Err(e) = fs::rename(&tmp, path) {
      let _ = fs::remove_file(&tmp);
      return Err(e);
    }
    return Ok(());
  }
  if let Err(e) = rename {
    let _ = fs::remove_file(&tmp);
    return Err(e);
  }
  Ok(())
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif"];
pub(crate) const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

pub(crate) fn sanitize_image_name(name: &str) -> Option<String> {
  let base = name.replace('\\', "/");
  let base = base.rsplit('/').next().unwrap_or("");
  if base.is_empty() || base == "." || base == ".." {
    return None;
  }
  let (stem, ext) = base.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if !IMAGE_EXTS.contains(&ext.as_str()) {
    return None;
  }
  let mut out = String::new();
  for c in stem.chars() {
    // 用 Unicode 的 is_alphanumeric（而非 ascii）：要和前端 safeDropName 的
    // `\p{L}\p{N}` 保持一致，否则「截图_2026.png」拖进来会被落成「--_2026.png」。
    if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
      out.push(c);
    } else {
      out.push('-');
    }
  }
  let stem = out.trim_matches('-');
  if stem.is_empty() {
    return None;
  }
  Some(format!("{stem}.{ext}"))
}

pub(crate) fn unique_path(dir: &std::path::Path, filename: &str) -> PathBuf {
  let dest = dir.join(filename);
  if !dest.exists() {
    return dest;
  }
  let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, "png"));
  for i in 2..1000 {
    let cand = dir.join(format!("{stem}-{i}.{ext}"));
    if !cand.exists() {
      return cand;
    }
  }
  dir.join(format!("{stem}-{}.{}", std::process::id(), ext))
}

pub(crate) fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
  fn val(c: u8) -> Option<u8> {
    match c {
      b'A'..=b'Z' => Some(c - b'A'),
      b'a'..=b'z' => Some(c - b'a' + 26),
      b'0'..=b'9' => Some(c - b'0' + 52),
      b'+' => Some(62),
      b'/' => Some(63),
      _ => None,
    }
  }
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
  let mut buf = 0u32;
  let mut n = 0;
  for &c in bytes {
    if c == b'=' || c.is_ascii_whitespace() {
      continue;
    }
    let v = val(c).ok_or_else(|| "invalid base64".to_string())?;
    buf = (buf << 6) | u32::from(v);
    n += 6;
    if n >= 8 {
      n -= 8;
      out.push((buf >> n) as u8);
    }
  }
  Ok(out)
}

/// 图片子目录只允许单段（无 `/` `\`）、非空、非 `..`、非绝对路径。
/// 与 editor 的 expandImageDir 是同一判据；壳侧再验一次，双保险。
pub(crate) fn sanitize_image_subdir(s: &str) -> Option<String> {
  let t = s.trim();
  if t.is_empty() || t.contains('/') || t.contains('\\') || t.contains("..") {
    return None;
  }
  if t.contains(':') {
    return None; // 拒绝盘符 / 兜底
  }
  if t.len() > 120 {
    return None;
  }
  Some(t.to_string())
}

/// 每个用例独占一个刚建出来的空目录，并且只在开始时清一次。
///
/// 不要在系统临时目录里用 `lector-xxx-<pid>.md` 这种固定名字：上一次被杀掉的
/// 进程会留下同名文件，下一次跑（pid 往往复用）就带着脏状态开始——「目标不存在」
/// 与「mtime 冲突」两条断言都会莫名其妙地翻。测试必须自备干净环境。
#[cfg(test)]
pub(crate) fn tdir(tag: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("lector-test-{tag}-{}", std::process::id()));
  let _ = fs::remove_dir_all(&dir);
  fs::create_dir_all(&dir).unwrap();
  dir
}

#[cfg(test)]
pub(crate) fn tmp_leftovers(dir: &std::path::Path) -> Vec<String> {
  fs::read_dir(dir)
    .unwrap()
    .filter_map(|e| e.ok())
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .filter(|n| n.starts_with(".lector-tmp-"))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn atomic_write_roundtrip() {
    let dir = tdir("atomic");
    let path = dir.join("a.md");
    atomic_write(&path, b"hello").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    atomic_write(&path, b"world").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"world");
    // 覆盖写不能留下临时文件——那是写进用户文档目录里的垃圾。
    assert!(tmp_leftovers(&dir).is_empty(), "leftover: {:?}", tmp_leftovers(&dir));
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn sanitize_image_name_strips_paths() {
    assert_eq!(sanitize_image_name("photo.png").as_deref(), Some("photo.png"));
    assert_eq!(sanitize_image_name("a/../x.PNG").as_deref(), Some("x.png"));
    assert_eq!(sanitize_image_name("weird name.webp").as_deref(), Some("weird-name.webp"));
    // 中文名要留住（与前端 safeDropName 的 \p{L} 对齐），不能被整段换成 '-'
    assert_eq!(sanitize_image_name("截图_2026.png").as_deref(), Some("截图_2026.png"));
    assert!(sanitize_image_name("../x.png").is_none() || sanitize_image_name("../x.png").as_deref() == Some("x.png"));
    assert!(sanitize_image_name("x.txt").is_none());
    assert!(sanitize_image_name("..").is_none());
  }

  #[test]
  fn decode_base64_hello() {
    assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
  }

  #[test]
  fn unique_path_adds_suffix() {
    let dir = tdir("uniq");
    atomic_write(&dir.join("shot.png"), b"1").unwrap();
    let next = unique_path(&dir, "shot.png");
    assert_eq!(next.file_name().unwrap().to_string_lossy(), "shot-2.png");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn sanitize_image_subdir_rejects_evil_input() {
    // 合法
    assert_eq!(sanitize_image_subdir("images"), Some("images".into()));
    assert_eq!(sanitize_image_subdir("读书笔记.assets"), Some("读书笔记.assets".into()));
    // 拒：穿越
    assert_eq!(sanitize_image_subdir(".."), None);
    assert_eq!(sanitize_image_subdir("../evil"), None);
    assert_eq!(sanitize_image_subdir("a/../b"), None);
    // 拒：路径分隔
    assert_eq!(sanitize_image_subdir("a/b"), None);
    assert_eq!(sanitize_image_subdir("a\\b"), None);
    // 拒：盘符
    assert_eq!(sanitize_image_subdir("C:evil"), None);
    // 拒：空
    assert_eq!(sanitize_image_subdir(""), None);
    assert_eq!(sanitize_image_subdir("   "), None);
  }

  // ── 文档里的本地链接：路径解析（open_link） ──
  //
  // 这一段是**不可信内容**进来的地方，规则要么对要么全错，所以逐条钉住。

  /// 平台无关的测试用绝对路径。
  ///
  /// **不能写死 `/docs/book/ch1.md`**：Windows 上 `/…` 不是绝对路径（缺盘符前缀），
  /// `Path::is_absolute()` 为 false，于是会被 resolve_link_target 里那条
  /// 「文档路径必须是绝对路径」的守卫拒掉——上一版就是这么在 Windows runner 上
  /// 挂了三条（本机 macOS 全绿，只有 CI 的 Windows 作业才看得见）。
  fn abs_path(rel: &str) -> PathBuf {
    let base = if cfg!(windows) { "C:\\docs" } else { "/docs" };
    let sep = if cfg!(windows) { "\\" } else { "/" };
    PathBuf::from(format!("{base}{sep}{}", rel.replace('/', sep)))
  }

  /// 按**路径段**比较，不按字符串比。
  ///
  /// `Path::join` 会把链接原文里的分隔符原样留着（Windows 上 `./sub/ch2.md` 拼出来是
  /// `…\book\./sub/ch2.md`），所以逐字节比较会在 Windows 上假红。段比较既是平台无关的，
  /// 也更接近这几条断言真正说的意思——「这段相对路径解析到了哪儿」。
  /// （`Components` 会吃掉中间的 `.`，`..` 保留。）
  fn segs(p: &std::path::Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect()
  }

  #[test]
  fn link_test_fixtures_are_absolute_on_this_platform() {
    // 给下一个人留的路标：fixture 不是绝对路径时，上面那些用例会以 panic 的形式挂掉，
    // 而不是以「断言失败」的形式说清原因。这条先把话说在前面。
    assert!(abs_path("a.md").is_absolute());
  }

  #[test]
  fn link_relative_resolves_against_document_dir() {
    let doc = abs_path("book/ch1.md");
    let doc = doc.to_str().unwrap();

    // 链接原文一律写成带 `/` 的样子：那是作者在 md 里实际会写的形态
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md").unwrap()), segs(&abs_path("book/ch2.md")));
    assert_eq!(
      segs(&resolve_link_target(doc, "./sub/ch2.md").unwrap()),
      segs(&abs_path("book/sub/ch2.md"))
    );

    // 允许 ../ 出去：尺度对齐 Typora（手势门控，见函数上的说明）
    assert_eq!(
      segs(&resolve_link_target(doc, "../other/ch2.md").unwrap()),
      segs(&abs_path("book/../other/ch2.md"))
    );
  }

  #[test]
  fn link_strips_fragment_and_query() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md#小节").unwrap()), segs(&abs_path("ch2.md")));
    assert_eq!(segs(&resolve_link_target(doc, "ch2.md?x=1#y").unwrap()), segs(&abs_path("ch2.md")));
    // 纯锚点没有路径可开
    assert_eq!(resolve_link_target(doc, "#小节"), Err("bad_href".into()));
  }

  #[test]
  fn link_absolute_and_file_url() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();

    // 绝对路径的**形状按平台来**：Windows 上得带盘符才算绝对
    let abs_href = abs_path("elsewhere/b.md");
    assert_eq!(
      resolve_link_target(doc, abs_href.to_str().unwrap()).unwrap(),
      abs_href
    );

    // file:// 同样按平台取形状，解析交给 url
    let (url, expect) = if cfg!(windows) {
      ("file:///C:/tmp/it%20has%20spaces.md", "C:\\tmp\\it has spaces.md")
    } else {
      ("file:///tmp/it%20has%20spaces.md", "/tmp/it has spaces.md")
    };
    assert_eq!(resolve_link_target(doc, url).unwrap(), PathBuf::from(expect));
  }

  #[test]
  fn link_rejects_other_schemes_but_not_windows_drive() {
    let doc = abs_path("a.md");
    let doc = doc.to_str().unwrap();
    assert_eq!(resolve_link_target(doc, "http://x/y.md"), Err("scheme".into()));
    assert_eq!(resolve_link_target(doc, "obsidian://open?vault=x"), Err("scheme".into()));
    // 盘符不是 scheme：C:/ 开头的绝对路径要认（Windows 上全靠这条）
    #[cfg(windows)]
    assert_eq!(
      resolve_link_target("C:\\docs\\a.md", "D:/other/b.md").unwrap(),
      PathBuf::from("D:/other/b.md")
    );
    // 非 Windows 上盘符路径当普通绝对路径处理即可，至少不能被当成 scheme 拒掉
    #[cfg(not(windows))]
    assert!(resolve_link_target(doc, "D:/other/b.md").is_ok());
  }

  #[test]
  fn link_requires_absolute_document_path() {
    // 文档路径不是绝对路径 → 拒。否则会按进程 CWD 拼出一个"碰巧存在"的路径
    assert_eq!(resolve_link_target("a.md", "b.md"), Err("bad_href".into()));
    assert_eq!(resolve_link_target("", "b.md"), Err("bad_href".into()));
    // 空链接先于文档路径被拒，所以这里的文档路径用哪种形状都行——但仍然按平台给
    let doc = abs_path("a.md");
    assert_eq!(resolve_link_target(doc.to_str().unwrap(), "   "), Err("bad_href".into()));
  }

  #[test]
  fn text_doc_extension_table() {
    for ok in ["a.md", "a.MD", "a.markdown", "a.txt"] {
      assert!(is_text_doc(std::path::Path::new(ok)), "{ok} 应当可打开");
    }
    for no in ["a.pdf", "a.png", "a", "a.md.bak"] {
      assert!(!is_text_doc(std::path::Path::new(no)), "{no} 不该可打开");
    }
  }
}
