//! PDF 导出：WebView2 PrintToPdf 的薄封装。
//!
//! 渲染引擎与应用相同——中文、mermaid、KaTeX 原样进 PDF，零额外依赖。
//! COM 互操作要求主线程（STA）：`with_webview` 的闭包在主线程执行，
//! PrintToPdf 是异步 COM 调用（结果经完成回调送达），所以闭包里只发起
//! 调用、绝不阻塞；结果用 channel 送回命令线程，命令线程带超时等待。

#[cfg(windows)]
mod imp {
  use std::sync::mpsc::Sender;
  use std::time::Duration;

  pub async fn print_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
  ) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    window
      .with_webview(move |webview| {
        print_on_main_thread(&webview, &path, tx);
      })
      .map_err(|e| e.to_string())?;

    // PrintToPdf 的完成回调在主线程消息循环里触发，这里只等结果。
    // spawn_blocking：recv_timeout 会阻塞，不能占着 async 执行线程。
    tauri::async_runtime::spawn_blocking(move || {
      rx.recv_timeout(Duration::from_secs(60))
        .unwrap_or_else(|_| Err("PDF 导出超时".into()))
    })
    .await
    .map_err(|e| e.to_string())?
  }

  fn print_on_main_thread(
    webview: &tauri::webview::PlatformWebview,
    path: &str,
    tx: Sender<Result<(), String>>,
  ) {
    use webview2_com::PrintToPdfCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_16;
    use windows_core::Interface;

    let send_err = |tx: &Sender<Result<(), String>>, e: String| {
      let _ = tx.send(Err(e));
    };

    let core = match unsafe { webview.controller().CoreWebView2() } {
      Ok(c) => c,
      Err(e) => return send_err(&tx, e.to_string()),
    };
    // PrintToPdf 在 ICoreWebView2_16（WebView2 1.3.157+，2021 年起全量覆盖）
    let core16: ICoreWebView2_16 = match core.cast() {
      Ok(c) => c,
      Err(e) => return send_err(&tx, format!("WebView2 too old for PrintToPdf: {e}")),
    };

    // 打印设置传 None = WebView2 默认（A4、默认边距）；页面级打印样式
    // （app.css 的 @media print）负责版式，这里不重复配置。
    // Param 由 Option<&T> 实现：None 里装引用。

    // HSTRING 保活到调用返回（COM 封送在调用瞬间完成，局部变量即可）。
    let path_h = windows_core::HSTRING::from(path);
    // 回调持有一个 tx；PrintToPdf 同步失败（回调不会来）走另一个 clone 报错。
    let tx_sync = tx.clone();
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |error_code, _succeeded| {
      let _ = tx.send(if error_code.is_ok() {
        Ok(())
      } else {
        Err(format!("PrintToPdf failed: {error_code:?}"))
      });
      Ok(())
    }));

    if let Err(e) = unsafe { core16.PrintToPdf(&path_h, None::<&_>, &handler) } {
      let _ = tx_sync.send(Err(e.to_string()));
    }
  }
}

#[cfg(not(windows))]
mod imp {
  pub async fn print_to_pdf(
    _window: tauri::WebviewWindow,
    _path: String,
  ) -> Result<(), String> {
    Err("PDF 导出目前仅支持 Windows".into())
  }
}

/// 导出当前窗口内容为 PDF。`path` 来自 Web 层的存盘对话框。
#[tauri::command]
pub async fn print_to_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
  imp::print_to_pdf(window, path).await
}
