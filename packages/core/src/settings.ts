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

/**
 * 贴图/拖图时的写入策略：
 * - 'images'  ：写 md 同目录固定 `images/`（今天的行为，DEFAULT 保持不惊吓老用户）；
 * - 'assets'  ：写常 md、等当前文档同名的 `{filename}.assets`（目录模板可配）；
 * - 'command' ：先写 assets 本地副本，再跑用户配置的命令上传图床，正文写返回的 URL；
 *               失败时静默降级为本地相对路径（本地副本永远在，绝不丢图）。
 */
export type ImageInsertMode = 'images' | 'assets' | 'command'

/** 命令模式下 argv 的约定：`command [args…] <图片绝对路径>` → stdout 首行 http(s) URL。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MIN = 1_000
const IMAGE_TIMEOUT_MAX = 300_000

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
  /**
   * 界面缩放（%）：整页等比放大，给投屏 / 会议演示用。
   * 与 fontSize 正交——那个只改正文，这个连顶栏、状态行、大纲一起放大。
   * 分成两个旋钮而不是一个，是因为两件事的诉求不同：读得舒服 vs 隔着三米能看清。
   */
  uiZoom: number
  /** 自动成对符号（选中即包裹 **、[] 等）。 */
  /**
   * 未保存内容恢复：编辑过的内容留一份草稿在本地，重开这份文件时提示恢复。
   * 做成开关是因为它**会留副本**——有人不接受应用里多存一份内容。
   */
  recoverUnsaved: boolean
  /** 用户自定义 CSS：原样注到样式表末尾，可覆盖任何内置规则 */
  customCss: string
  /**
   * mermaid 的额外配置（JSON），整份合进 `mermaid.initialize()`。
   *
   * 为什么是一段 JSON 而不是一排控件：mermaid 的配置面又宽又长（既有 themeVariables
   * 那几十个色，也有 flowchart.curve / sequence.showSequenceNumbers / gantt.leftPadding
   * 这类非颜色选项），做成 UI 必然是残缺的；而 mermaid 自己的文档写的就是这个 JSON 对象，
   * 用户可以从文档里原样粘过来。危险的那几个键（securityLevel / startOnLoad /
   * maxTextSize / suppressErrorRendering）在 mermaid 里是 secure keys，谁传都会被丢掉
   * ——包括文档里的 `%%{init}%%` 指令——所以这里可以放行整份对象。
   */
  mermaidConfig: string
  autoCharacterPairs: boolean
  /** 关闭脏文档前确认（防数据丢失）。 */
  closeAlwaysConfirmsChanges: boolean
  /** 编辑态显示空白字符。 */
  showWhitespace: boolean
  /** 代码块显示行号（阅读态 gutter + 编辑态 CodeMirror 同一开关）。 */
  codeLineNumbers: boolean
  /** 贴图/拖图的写入策略（images | assets | command，见 ImageInsertMode）。 */
  imageMode: ImageInsertMode
  /** assets/command 模式下的目标目录模板，`{filename}` 会被替换成文档基名（去扩展名）。
   *  默认 `{filename}.assets`，即 md 同目录下「文档名.assets」。 */
  imageAssetsDir: string
  /** command 模式的上传命令：可执行名（PATH 内）或绝对路径，可含前置参数
   *  （引号感知分词，如 `picgo upload`）。图片路径由 App 追加在最后。 */
  imageCommand: string
  /** command 固定的参数列表（追加在 `<命令+前置参数>` 之后、图片路径之前）。 */
  imageCommandArgs: string[]
  /** command 超时（毫秒），clamp 到 [1000, 300000]，默认 30s。 */
  imageCommandTimeoutMs: number
}

/**
 * 默认阅读排版。这三个值与 packages/editor 的 --reading-* 标定一致：
 * 800px / 17px / 1.75 ≈ 中文每行 47 字、Latin ~95 字符。
 *
 * 宽度是这一版上调过的：原来的 640px 是按「一行 37 字」的保守栏宽定的，
 * 但今天的屏幕至少 1080p、常见 2K，640px 在 1600px 的正文区里只占 40%，
 * 读起来像一张贴在墙上的窄纸条。放宽到 47 字/行——仍在上限内（>48 字眼睛会丢行），
 * 与 Typora 的 860px 同档，但更贴合现在的屏幕。
 * 改这里等于改默认阅读体验，必须同时跑 tools/ui-verify.mjs 复核版心。
 */
export const DEFAULT_SETTINGS: EditorSettings = {
  theme: 'system',
  readingTheme: DEFAULT_READING_THEME,
  fontFamily: 'system',
  fontSize: 17,
  lineHeight: 1.75,
  readingWidth: 800,
  uiZoom: 100,
  recoverUnsaved: true,
  customCss: '',
  mermaidConfig: '',
  autoCharacterPairs: true,
  closeAlwaysConfirmsChanges: true,
  showWhitespace: false,
  codeLineNumbers: true,
  imageMode: 'images',
  imageAssetsDir: '{filename}.assets',
  imageCommand: '',
  imageCommandArgs: [],
  imageCommandTimeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
}

const CLAMP = {
  fontSize: { min: 11, max: 32 },
  lineHeight: { min: 1.2, max: 2.6 },
  // 上限 1600：2K 屏（2560）扣掉侧栏还有 2200px，1200 的天花板会在最需要它的屏幕上先撞到
  readingWidth: { min: 480, max: 1600 },
  // 上限 160：再大在 1080p 上会被顶栏裁掉内容；下限 70 是为了小屏同时看别的窗口
  uiZoom: { min: 70, max: 160 },
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

function isImageMode(v: unknown): v is ImageInsertMode {
  return v === 'images' || v === 'assets' || v === 'command'
}

/** 图片目录模板只允许普通字符与 `{filename}` 占位符；不含路径分隔与穿越段。 */
function normalizeImageAssetsDir(v: unknown): string {
  const s = String(v ?? '').trim()
  if (s === '') return DEFAULT_SETTINGS.imageAssetsDir
  if (s.includes('..') || /[\\/]/.test(s)) return DEFAULT_SETTINGS.imageAssetsDir
  return s.slice(0, 120)
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
    uiZoom: clampInt(src.uiZoom, CLAMP.uiZoom.min, CLAMP.uiZoom.max, base.uiZoom),
    autoCharacterPairs: typeof src.autoCharacterPairs === 'boolean' ? src.autoCharacterPairs : base.autoCharacterPairs,
    closeAlwaysConfirmsChanges:
      typeof src.closeAlwaysConfirmsChanges === 'boolean'
        ? src.closeAlwaysConfirmsChanges
        : base.closeAlwaysConfirmsChanges,
    showWhitespace: typeof src.showWhitespace === 'boolean' ? src.showWhitespace : base.showWhitespace,
    codeLineNumbers: typeof src.codeLineNumbers === 'boolean' ? src.codeLineNumbers : base.codeLineNumbers,
    recoverUnsaved: typeof src.recoverUnsaved === 'boolean' ? src.recoverUnsaved : base.recoverUnsaved,
    // 限长：设置文件是被反复读写的小 JSON，不该成为存放整套主题的仓库
    customCss: String(src.customCss ?? base.customCss ?? '').slice(0, 20000),
    // 同样限长：mermaid 配置能写很长（themeCSS 动辄上百行），但设置文件不该变成仓库
    mermaidConfig: String(src.mermaidConfig ?? base.mermaidConfig ?? '').slice(0, 20000),
    imageMode: isImageMode(src.imageMode) ? src.imageMode : base.imageMode,
    imageAssetsDir: normalizeImageAssetsDir(src.imageAssetsDir),
    imageCommand: String(src.imageCommand ?? base.imageCommand ?? '').trim().slice(0, 512),
    imageCommandArgs: Array.isArray(src.imageCommandArgs)
      ? src.imageCommandArgs.filter((a): a is string => typeof a === 'string').slice(0, 32).map((a) => a.slice(0, 256))
      : base.imageCommandArgs,
    imageCommandTimeoutMs: clampInt(
      src.imageCommandTimeoutMs,
      IMAGE_TIMEOUT_MIN,
      IMAGE_TIMEOUT_MAX,
      base.imageCommandTimeoutMs,
    ),
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
