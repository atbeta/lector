// 导出 PDF：WebView2 原生 PrintToPdf——渲染引擎与应用相同，
// 中文 / mermaid / KaTeX / 表格原样进 PDF，零额外排版依赖。
// 路径由 Web 层用 dialog 插件先选好（见 platform.ts exportPdf），这里只负责打印。
// 立项包 01-brief 的口径：只做「所见即所得」级导出，印刷级管线（Pandoc/LaTeX）明确不做。

use tauri::WebviewWindow;

#[cfg(not(windows))]
#[tauri::command]
pub fn print_to_pdf(_window: WebviewWindow, _path: String) -> Result<(), String> {
  Err("PDF export is only implemented on Windows".into())
}

#[cfg(windows)]
#[tauri::command]
pub fn print_to_pdf(window: WebviewWindow, path: String) -> Result<(), String> {
  use std::sync::mpsc;
  use std::time::Duration;

  use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2PrintSettings, ICoreWebView2_16,
    ICoreWebView2PrintToPdfCompletedHandler, ICoreWebView2PrintToPdfCompletedHandler_Impl,
  };
  use windows_core::{BOOL, Interface, PCWSTR};

  // PrintToPdf 的完成回调：结果经 channel 送回命令线程。
  // 回调在主线程触发，绝不能在主线程里等它——会死锁。
  #[webview2_com::implement(ICoreWebView2PrintToPdfCompletedHandler)]
  struct PrintCompleted {
    tx: mpsc::Sender<bool>,
  }

  impl ICoreWebView2PrintToPdfCompletedHandler_Impl for PrintCompleted_Impl {
    fn Invoke(
      &self,
      _error_code: windows_core::HRESULT,
      succeeded: BOOL,
    ) -> windows_core::Result<()> {
      let _ = self.tx.send(succeeded.as_bool());
      Ok(())
    }
  }

  let (tx, rx) = mpsc::channel::<bool>();
  let tx_main = tx.clone();
  // PrintToPdf 必须在 UI 线程（COM STA）调用：with_webview 把闭包派发到主线程后
  // 立即返回，闭包里只发起打印、不等待；命令线程在下面阻塞收结果。
  window
    .with_webview(move |webview| {
      let send = |ok: bool| {
        let _ = tx_main.send(ok);
      };
      unsafe {
        let core = match webview.controller.CoreWebView2() {
          Ok(c) => c,
          Err(e) => {
            log::error!("export_pdf: CoreWebView2 unavailable: {e}");
            send(false);
            return;
          }
        };
        // ICoreWebView2_16 = PrintToPdf 所在的接口版本（WebView2 88+ 自带）
        let Ok(core16) = core.cast::<ICoreWebView2_16>() else {
          send(false);
          return;
        };
        let handler: ICoreWebView2PrintToPdfCompletedHandler =
          PrintCompleted { tx: tx_main.clone() }.into();
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let target = PCWSTR::from_raw(wide.as_ptr());
        if let Err(e) = core16.PrintToPdf(target, None::<&ICoreWebView2PrintSettings>, &handler) {
          log::error!("export_pdf: PrintToPdf failed: {e}");
          send(false);
        }
      }
    })
    .map_err(|e| format!("webview unavailable: {e}"))?;

  // 命令线程等结果。必须有界：Web 层在 await 这个命令，回调若丢失就永远挂起。
  match rx.recv_timeout(Duration::from_secs(60)) {
    Ok(true) => Ok(()),
    Ok(false) => Err("PDF export failed".into()),
    Err(_) => Err("PDF export timed out".into()),
  }
}
