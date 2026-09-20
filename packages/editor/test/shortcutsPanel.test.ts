import { describe, expect, test } from 'bun:test'
import { shortcutGroups } from '../src/shortcutsPanel.ts'
import { mod, modShift } from '../src/keys.ts'

describe('快捷键面板', () => {
  // 缩放/字号那 6 个键在壳里不可靠（macOS 菜单抢 ⇧⌘0、WebView2 抢缩放组合键），
  // 所以面板不再宣传它们；键本身仍由 shortcutDispatch 保留。这条钉住「没列出来」，
  // 同时确认没把整张表删空。
  test('界面缩放 / 字号不列进面板', () => {
    const keys = shortcutGroups().flatMap((g) => g.rows.map((r) => r.keys))
    for (const k of [mod('='), mod('-'), mod('0'), modShift('='), modShift('-'), modShift('0')]) {
      expect(keys).not.toContain(k)
    }
    expect(keys).toContain(mod('O'))
    expect(keys).toContain(mod('F'))
  })
})
