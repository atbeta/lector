// EditorSettings 契约（无 DOM，可 bun test）。
// 借鉴 MarkEdit：可见设置保持极简；schema 严格，非法值回退默认（不静默接受错误类型）。
// Lector 定位「阅读优先」，设置中心围绕：主题 + 阅读排版 + 编辑保护。

import {
  DEFAULT_READING_THEME,
  isReadingThemeId,
  readingTheme,
  type ReadingThemeId,
} from './readingThemes.ts'

export type ThemeMode = 'system' | 'light' | 'dark'
export type FontFamily = 'system' | 'serif'

export interface EditorSettings {
  /** 主题：跟随系统 / 浅色 / 深色。 */
  theme: ThemeMode
  /**
   * 阅读主题：纸墨 + 排版性格 + 标定排版参数（见 readingThemes.ts）。
   * 与 theme 正交——theme 决定明暗，readingTheme 决定「读起来像什么」。
   */
  readingTheme: ReadingThemeId
  /** 阅读字体：系统（Inter+苹方/雅黑）/ 衬线。 */
  fontFamily: FontFamily
  /** 阅读正文字号（px）。 */
  fontSize: number
  /** 阅读正文行高。 */
  lineHeight: number
  /** 阅读列宽（px）。 */
  readingWidth: number
  /** 自动成对符号（选中即包裹 **、[] 等）。 */
  autoCharacterPairs: boolean
  /** 关闭脏文档前确认（防数据丢失）。 */
  closeAlwaysConfirmsChanges: boolean
  /** 编辑态显示空白字符。 */
  showWhitespace: boolean
}

/**
 * 默认阅读排版。这三个值与 packages/editor 的 --reading-* 标定一致：
 * 760px / 17px / 1.75 ≈ 中文每行 45 字、Latin ~95 字符。
 *
 * 宽度是这一版上调过的：原来的 640px 是按「一行 37 字」的保守栏宽定的，
 * 但今天的屏幕至少 1080p、常见 2K，640px 在 1600px 的正文区里只占 40%，
 * 读起来像一张贴在墙上的窄纸条。放宽到 45 字/行——仍在上限内（>48 字眼睛会丢行），
 * 但更贴合现在的屏幕。
 * 改这里等于改默认阅读体验，必须同时跑 tools/ui-verify.mjs 复核版心。
 */
export const DEFAULT_SETTINGS: EditorSettings = {
  theme: 'system',
  readingTheme: DEFAULT_READING_THEME,
  fontFamily: 'system',
  fontSize: 17,
  lineHeight: 1.75,
  readingWidth: 760,
  autoCharacterPairs: true,
  closeAlwaysConfirmsChanges: true,
  showWhitespace: false,
}

const CLAMP = {
  fontSize: { min: 11, max: 32 },
  lineHeight: { min: 1.2, max: 2.6 },
  // 上限 1600：2K 屏（2560）扣掉侧栏还有 2200px，1200 的天花板会在最需要它的屏幕上先撞到
  readingWidth: { min: 480, max: 1600 },
} as const

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v * 100) / 100))
    : fallback
}

function isTheme(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark'
}

function isFontFamily(v: unknown): v is FontFamily {
  return v === 'system' || v === 'serif'
}

/**
 * 把任意来源（json / localStorage）规范化为 EditorSettings。
 * 字段缺失 → 默认；类型错误 → 默认；数值越界 → 夹取。
 */
export function normalizeSettings(raw: unknown, base: EditorSettings = DEFAULT_SETTINGS): EditorSettings {
  const src = (raw ?? {}) as Record<string, unknown>
  return {
    theme: isTheme(src.theme) ? src.theme : base.theme,
    readingTheme: isReadingThemeId(src.readingTheme) ? src.readingTheme : base.readingTheme,
    fontFamily: isFontFamily(src.fontFamily) ? src.fontFamily : base.fontFamily,
    fontSize: clampInt(src.fontSize, CLAMP.fontSize.min, CLAMP.fontSize.max, base.fontSize),
    lineHeight: clampFloat(src.lineHeight, CLAMP.lineHeight.min, CLAMP.lineHeight.max, base.lineHeight),
    readingWidth: clampInt(src.readingWidth, CLAMP.readingWidth.min, CLAMP.readingWidth.max, base.readingWidth),
    autoCharacterPairs: typeof src.autoCharacterPairs === 'boolean' ? src.autoCharacterPairs : base.autoCharacterPairs,
    closeAlwaysConfirmsChanges:
      typeof src.closeAlwaysConfirmsChanges === 'boolean'
        ? src.closeAlwaysConfirmsChanges
        : base.closeAlwaysConfirmsChanges,
    showWhitespace: typeof src.showWhitespace === 'boolean' ? src.showWhitespace : base.showWhitespace,
  }
}

export function isDefaultSettings(s: EditorSettings): boolean {
  return JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS)
}

/**
 * 套用某款阅读主题的标定排版：返回一份新设置。
 *
 * 只覆盖主题标定的四项（字体 / 字号 / 行距 / 栏宽），其余设置不动。
 * 用户之后逐项微调仍然有效——微调只改设置值，不改主题 id，
 * 所以画廊里那张卡仍然亮着，只是旁边多了被调过的数值。
 */
export function withReadingTheme(s: EditorSettings, id: ReadingThemeId): EditorSettings {
  const { preset } = readingTheme(id)
  return {
    ...s,
    readingTheme: id,
    fontFamily: preset.fontFamily,
    fontSize: preset.fontSize,
    lineHeight: preset.lineHeight,
    readingWidth: preset.readingWidth,
  }
}

/** 当前设置是否与所选主题的标定值逐项一致（用于画廊里标「已微调」）。 */
export function matchesReadingThemePreset(s: EditorSettings): boolean {
  const { preset } = readingTheme(s.readingTheme)
  return (
    s.fontFamily === preset.fontFamily &&
    s.fontSize === preset.fontSize &&
    s.lineHeight === preset.lineHeight &&
    s.readingWidth === preset.readingWidth
  )
}
