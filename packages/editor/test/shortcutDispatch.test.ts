// 全局快捷键的判定表。难点全在**优先级与让位关系**，而错了界面不报错——
// 只是某个键没反应，或者两个动作同时发生（Windows 上 Ctrl+E 既加粗又切档）。
// 所以逐条钉住。
//
// 不需要浏览器：这里测的是纯函数，事件/状态探测在 appBindings.ts 的薄适配层里。
import { describe, expect, test } from 'bun:test'
import { resolveShortcut, type ShortcutHints } from '../src/shortcutDispatch.ts'

/** 默认「无修饰键、无编辑器、无文件、未被消费」——各用例只改自己关心的那几项。 */
function hints(over: Partial<ShortcutHints> = {}): ShortcutHints {
  return {
    mod: false,
    shift: false,
    key: 'x',
    defaultPrevented: false,
    focusedBlock: false,
    editorMounted: false,
    hasSource: false,
    ...over,
  }
}

const kind = (h: Partial<ShortcutHints>) => resolveShortcut(hints(h))?.kind ?? null

describe('快捷键分派', () => {
  test('无修饰键不触发任何全局动作', () => {
    for (const key of ['o', 's', 'z', 'e', '1', 'Enter', 'Escape']) {
      expect(kind({ key })).toBe(null)
    }
  })

  test('块级撤销：编辑器未聚焦时才接管 ⌘Z', () => {
    expect(kind({ mod: true, key: 'z' })).toBe('undo-block')
    // 聚焦块里的 ⌘Z 是 CM 的文字撤销，必须让位
    expect(kind({ mod: true, key: 'z', focusedBlock: true })).toBe(null)
    // 编辑器存在但尚未聚焦（可能的状态）同样让位
    expect(kind({ mod: true, key: 'z', editorMounted: true })).toBe(null)
  })

  test('Esc 只在有聚焦块时退出编辑', () => {
    expect(kind({ key: 'Escape', focusedBlock: true })).toBe('leave-edit')
    expect(kind({ key: 'Escape' })).toBe(null)
  })

  test('⇧⌘S 另存压过 ⌘S 保存（Shift 下 key 是大写 S）', () => {
    expect(kind({ mod: true, key: 'S', shift: true })).toBe('save-as')
    expect(kind({ mod: true, key: 's' })).toBe('save')
  })

  test('⌘O 打开 / ⇧⌘O 大纲（大写 O）', () => {
    expect(kind({ mod: true, key: 'o' })).toBe('open')
    expect(kind({ mod: true, key: 'O', shift: true })).toBe('toggle-outline')
  })

  test('⌘N 新建（与 ⌘O 同组，检查 defaultPrevented）', () => {
    expect(kind({ mod: true, key: 'n' })).toBe('new-document')
    expect(kind({ mod: true, key: 'n', defaultPrevented: true })).toBe(null)
    expect(kind({ key: 'n' })).toBe(null)
  })

  test('⌘R 重载 / ⌘, 设置', () => {
    expect(kind({ mod: true, key: 'r' })).toBe('reload')
    expect(kind({ mod: true, key: ',' })).toBe('open-settings')
  })

  test('⌘W 有文档关文件、无文档关窗（比较不区分大小写）', () => {
    expect(kind({ mod: true, key: 'w', hasSource: true })).toBe('close-file')
    expect(kind({ mod: true, key: 'w', hasSource: false })).toBe('close-window')
    expect(kind({ mod: true, key: 'W', hasSource: true })).toBe('close-file')
  })

  test('界面缩放：⌘= / ⌘- / ⌘0（含部分键盘上 ⌘) 与 ⌘0 同位）', () => {
    expect(resolveShortcut(hints({ mod: true, key: '=' }))).toEqual({ kind: 'ui-zoom', dir: 1 })
    expect(resolveShortcut(hints({ mod: true, key: '+' }))).toEqual({ kind: 'ui-zoom', dir: 1 })
    expect(resolveShortcut(hints({ mod: true, key: '-' }))).toEqual({ kind: 'ui-zoom', dir: -1 })
    expect(resolveShortcut(hints({ mod: true, key: '0' }))).toEqual({ kind: 'ui-zoom', dir: 0 })
    expect(resolveShortcut(hints({ mod: true, key: ')' }))).toEqual({ kind: 'ui-zoom', dir: 0 })
  })

  test('⇧ 变体改正文字号，不碰界面缩放', () => {
    expect(resolveShortcut(hints({ mod: true, shift: true, key: '+' }))).toEqual({ kind: 'font-size', dir: 1 })
    expect(resolveShortcut(hints({ mod: true, shift: true, key: '=' }))).toEqual({ kind: 'font-size', dir: 1 })
    expect(resolveShortcut(hints({ mod: true, shift: true, key: '_' }))).toEqual({ kind: 'font-size', dir: -1 })
    expect(resolveShortcut(hints({ mod: true, shift: true, key: '-' }))).toEqual({ kind: 'font-size', dir: -1 })
    expect(resolveShortcut(hints({ mod: true, shift: true, key: ')' }))).toEqual({ kind: 'font-size', dir: 0 })
    expect(resolveShortcut(hints({ mod: true, shift: true, key: '0' }))).toEqual({ kind: 'font-size', dir: 0 })
  })

  test('⌘F 查找 / ⌘E 循环档位 / ⌘1-3 直选', () => {
    expect(kind({ mod: true, key: 'f' })).toBe('find')
    expect(kind({ mod: true, key: 'e' })).toBe('cycle-mode')
    expect(resolveShortcut(hints({ mod: true, key: '1' }))).toEqual({ kind: 'set-mode', index: 0 })
    expect(resolveShortcut(hints({ mod: true, key: '2' }))).toEqual({ kind: 'set-mode', index: 1 })
    expect(resolveShortcut(hints({ mod: true, key: '3' }))).toEqual({ kind: 'set-mode', index: 2 })
    // ⇧⌘E 不是循环（Shift 下 key 也不是 'e'）
    expect(kind({ mod: true, shift: true, key: 'E' })).toBe(null)
  })

  test('键位表：⌘/ 与 ? 呼出；? 在聚焦编辑块时让位给输入', () => {
    expect(kind({ mod: true, key: '/' })).toBe('shortcuts')
    expect(kind({ key: '?', shift: true })).toBe('shortcuts')
    expect(kind({ key: 'F1' })).toBe('shortcuts')
    // 块里打字：? 必须留给 CodeMirror（同 ⌘Z 的守卫）
    expect(kind({ key: '?', shift: true, focusedBlock: true })).toBe(null)
    // ⌘⇧/ 不是它
    expect(kind({ mod: true, shift: true, key: '?' })).toBe(null)
  })

  test('defaultPrevented 只挡文档/视图那组，不挡撤销与保存', () => {
    // 聚焦块里的裸 CM 已接管的键（Ctrl+E 行内代码…）冒泡上来必须放行
    expect(kind({ mod: true, key: 'e', defaultPrevented: true })).toBe(null)
    expect(kind({ mod: true, key: 'f', defaultPrevented: true })).toBe(null)
    expect(kind({ mod: true, key: 'o', defaultPrevented: true })).toBe(null)
    // Esc / ⌘S / ⌘Z 不是 CM 的键位，仍应生效
    expect(kind({ key: 'Escape', focusedBlock: true, defaultPrevented: true })).toBe('leave-edit')
    expect(kind({ mod: true, key: 's', defaultPrevented: true })).toBe('save')
    expect(kind({ mod: true, key: 'z', defaultPrevented: true })).toBe('undo-block')
  })
})
