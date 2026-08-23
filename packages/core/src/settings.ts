// EditorSettings 契约（无 DOM，可 bun test）。
// 借鉴 MarkEdit：可见设置保持极简；schema 严格，非法值回退默认（不静默接受错误类型）。
// Lector 定位「阅读优先」，设置中心围绕：主题 + 阅读排版 + 编辑保护。

export type ThemeMode = 'system' | 'light' | 'dark'
export type FontFamily = 'system' | 'serif'

export interface EditorSettings {
  /** 主题：跟随系统 / 浅色 / 深色。 */
  theme: ThemeMode
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

export const DEFAULT_SETTINGS: EditorSettings = {
  theme: 'system',
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.7,
  readingWidth: 736,
  autoCharacterPairs: true,
  closeAlwaysConfirmsChanges: true,
  showWhitespace: false,
}

const CLAMP = {
  fontSize: { min: 11, max: 32 },
  lineHeight: { min: 1.2, max: 2.6 },
  readingWidth: { min: 480, max: 1200 },
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
