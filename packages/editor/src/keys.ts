// 快捷键文案：mac 用 ⌘ 符号，Windows / Linux 用 Ctrl+。
//
// 为什么单独一个模块：用户看到的每一个快捷键提示都要走这里。
// v0.5.0 之前这些符号是硬编码在 i18n 表里的（'进入编辑模式 (⌘E)'），
// 于是 Windows 用户看到的全是 Mac 键盘上的符号——一个「不像给 Windows 做的」的
// 应用，往往就是从这一处开始的。
//
// 平台判定只看 UA：壳里 macOS 的 WebView UA 带 Mac，Windows 带 Windows NT，
// 两边都准。浏览器预览（Linux）会走 Ctrl，符合预览机的实际键盘。

export function isMacLike(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /Mac|iPhone|iPad/i.test(ua)
}

/** 主修饰键 + 键名：⌘S / Ctrl+S。 */
export function mod(key: string): string {
  return isMacLike() ? `⌘${key}` : `Ctrl+${key}`
}

/** 主修饰键 + Shift + 键名：⌘⇧O / Ctrl+Shift+O。 */
export function modShift(key: string): string {
  return isMacLike() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`
}
