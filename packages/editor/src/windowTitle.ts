// 窗口标题与脏指示的唯一出口。
//
// 三处展示曾经各自为政：顶栏文件名（editorChrome）、document.title、原生窗口标题
// （壳，建窗时设一次就再没人更新——另存为换路径后任务栏还显示旧文件名）。
// 这里收成一个模块：名字或脏状态一变，document.title 与原生标题一起更新。
//
// 脏指示的形态按平台给：
//   - document.title：加 "● " 前缀（Windows 任务栏 / Alt-Tab 也看它）；
//   - 原生标题 macOS：交给壳的 documentEdited（关闭按钮红点），标题本身保持干净；
//   - 原生标题 Windows / Linux：壳侧加同款 "● " 前缀。
//
// 建窗时的 __lectorTitle 防闪机制（io/window.rs）不受影响：那管的是首帧之前，
// 这里管的是首帧之后的每一次变化。
import { syncNativeWindowState } from '@lector/shell-web'

/** 空态 / 未绑定文档时的标题名。 */
const APP_NAME = 'Lector'

/**
 * document.title 的文本（导出 PDF 期间 pdf.ts 会临时覆盖再还原，与本模块无冲突）。
 * 纯函数，单独抽出是为了在没有 DOM 的测试里钉住格式。
 */
export function formatDocTitle(name: string | null, dirty: boolean): string {
  const title = name ? `${name} — ${APP_NAME}` : APP_NAME
  return dirty ? `● ${title}` : title
}

let currentName: string | null = null
let currentDirty = false

function apply(): void {
  document.title = formatDocTitle(currentName, currentDirty)
  // 原生标题只有名字本身（与建窗时 io/window.rs 的初始标题一致），脏指示由壳按平台画
  void syncNativeWindowState(currentName ?? APP_NAME, currentDirty)
}

/** 文档名变化（打开 / 另存为 / 新建 / 关回空态）。空态传 null。 */
export function setWindowDocName(name: string | null): void {
  if (name === currentName) return
  currentName = name
  apply()
}

/** 脏状态变化。markDirty 每键都会走这条链，值没变就直接返回——一次 IPC 也不发。 */
export function setWindowDirty(dirty: boolean): void {
  if (dirty === currentDirty) return
  currentDirty = dirty
  apply()
}
