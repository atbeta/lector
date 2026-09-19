fn main() {
  // generate_context! 把 Dock 图标编进二进制；默认 build.rs 不盯这些文件，
  // 只换 icns/png 再跑 `tauri:dev` 会复用旧二进制，Dock 看起来「没换」。
  println!("cargo:rerun-if-changed=icons/icon.icns");
  println!("cargo:rerun-if-changed=icons/icon.png");
  println!("cargo:rerun-if-changed=icons/icon.ico");
  tauri_build::build()
}
