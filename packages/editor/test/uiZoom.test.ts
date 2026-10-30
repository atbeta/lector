import { describe, expect, test } from 'bun:test'
import { normalizeSettings } from '@lector/core'
import { UI_ZOOM_STEPS, uiZoomStep } from '../src/settings.ts'
import { sliderStopAt, sliderStopPos } from '../src/ui.ts'

const stops = UI_ZOOM_STEPS

describe('界面缩放档位', () => {
  test('滑杆与快捷键是同一组档，右端是 150', () => {
    expect([...stops]).toEqual([70, 80, 90, 100, 110, 125, 150])
  })

  test('最高档与设置里的 clamp 上限是同一个数（两处真值不能漂）', () => {
    // 两边都收成 number：stops 是 as const 元组，直接比会让 toBe 只认那几个字面量
    const top: number = stops.at(-1)!
    const clampMax: number = normalizeSettings({ uiZoom: 999 }).uiZoom
    expect(top).toBe(clampMax)
  })

  test('轨道等分：点中间是 100，点右端是 150，125 有自己的一格', () => {
    expect(sliderStopAt(stops, 0)).toBe(70)
    expect(sliderStopAt(stops, 0.5)).toBe(100)
    expect(sliderStopAt(stops, 1)).toBe(150)
    expect(sliderStopAt(stops, 5 / 6)).toBe(125)
    // 125 与 150 的分界在两格正中，再往右才是 150
    expect(sliderStopAt(stops, 5.5 / 6 - 0.001)).toBe(125)
    expect(sliderStopAt(stops, 5.5 / 6)).toBe(150)
  })

  test('100% 的家刻度在轨道正中，不按 70–150 的线性位置偏左', () => {
    expect(sliderStopPos(stops, 100)).toBeCloseTo(0.5)
    expect(sliderStopPos(stops, 70)).toBe(0)
    expect(sliderStopPos(stops, 150)).toBe(1)
    expect(sliderStopPos(stops, 125)).toBeCloseTo(5 / 6)
  })

  test('落在两档之间的旧值插在相邻两档中间，贴边则收到端点', () => {
    expect(sliderStopPos(stops, 120)).toBeCloseTo((4 + (120 - 110) / (125 - 110)) / 6)
    expect(sliderStopPos(stops, 160)).toBe(1)
    expect(sliderStopPos(stops, 40)).toBe(0)
  })

  test('快捷键按相邻档走，不跳过 125，也不停在 120', () => {
    expect(uiZoomStep(100, 1)).toBe(110)
    expect(uiZoomStep(100, -1)).toBe(90)
    expect(uiZoomStep(110, 1)).toBe(125)
    expect(uiZoomStep(125, 1)).toBe(150)
    expect(uiZoomStep(150, 1)).toBe(150)
    expect(uiZoomStep(70, -1)).toBe(70)
    expect(uiZoomStep(120, 1)).toBe(125)
    expect(uiZoomStep(120, -1)).toBe(110)
    expect(uiZoomStep(160, 1)).toBe(150)
    expect(uiZoomStep(160, -1)).toBe(150)
  })
})
