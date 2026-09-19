import { describe, expect, test } from 'bun:test'
import { shortcutGroups } from '../src/shortcutsPanel.ts'
import { mod, modShift } from '../src/keys.ts'

describe('快捷键面板', () => {
  test('缩放两层都写进表，和判定表同一套键', () => {
    const zoom = shortcutGroups().find((g) => g.rows.some((r) => r.keys === mod('0')))
    expect(zoom).toBeTruthy()
    const keys = zoom!.rows.map((r) => r.keys)
    expect(keys).toEqual([mod('='), mod('-'), mod('0'), modShift('='), modShift('-'), modShift('0')])
  })
})
