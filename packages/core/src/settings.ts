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
/** 界面语言：跟随系统 / 中文 / English。 */
export type LanguageMode = 'system' | 'zh-CN' | 'en'

/**
 * 图片设置是两根互不相干的轴，而不是三档单选：
 *
 * - **本地副本**（imageCopy / imageCopyDir）：图片要不要在文档目录里留一份文件；
 * - **图床**（imageCommand / imageUploadAuto）：图片要不要交给用户配置的命令上传。
 *
 * 原来的 imageMode 把两件事焊在一起（选了哪个目录就不会上传、选了上传就不能手动传），
 * 于是「不自动上传」被当成了「不能上传」。分开之后组合由 imagePipeline() 裁决：
 * 只复制 / 复制+自动上传 / 复制+手动上传 / 只上传（临时文件中转）。
 */

/** 上传档位：off = 没配命令；manual = 只在图片菜单里手动上传；auto = 粘贴/拖入即上传。 */
export type ImageUploadMode = 'off' | 'manual' | 'auto'

/** 上传命令的 argv 约定：`command [args…] <图片绝对路径>` → stdout 首个 http(s) URL 即结果。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 30_000
const IMAGE_TIMEOUT_MIN = 1_000
const IMAGE_TIMEOUT_MAX = 300_000

export interface EditorSettings {
  /** 主题：跟随系统 / 浅色 / 深色。 */
  theme: ThemeMode
  /**
   * 界面语言：跟随系统（navigator/系统 locale）/ 中文 / English。
   * 壳建窗时把解析结果注入页面（__lectorLocale），原生菜单启动时读同一设置。
   */
  language: LanguageMode
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
   * ==高亮==（Pandoc mark 扩展）：预览里把 `==文字==` 渲染成高亮。
   * 不是 CommonMark / GFM，属 Obsidian / Typora 一路的扩展语法；关掉则原样显示
   * 两个等号（给不想让 `==` 被吃掉的人）。
   */
  markHighlight: boolean
  /**
   * GitHub 风格 emoji 短代码：预览里把 `:smile:` 渲成 😄。
   * 不是 CommonMark；关掉则原样显示冒号名。磁盘里的短代码一个字节都不改。
   */
  emojiShortcodes: boolean
  /**
   * 数学公式：`$…$`（行内）与 `$$…$$`（块级）。关掉则原样显示美元符号。
   * 与 markHighlight 同属「Markdown 扩展语法」——都不是 CommonMark，
   * 且 `$` 在价格/区间里天然有歧义，留给用户一个总开关。
   */
  math: boolean
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
  /** 粘贴/拖入的图片是否在文档目录里留一份本地副本（组合规则见 imagePipeline）。 */
  imageCopy: boolean
  /** 本地副本目录：相对文档目录的单段模板，`{filename}` 替换成文档基名（去扩展名）。
   *  默认 `images`（老行为）；上传失败时的兜底副本也落在这里。 */
  imageCopyDir: string
  /** 有上传命令时，粘贴/拖入是否**立刻**上传。
   *  false = 正文先写本地路径，需要时在图片菜单里手动上传（这只跟时机有关，
   *  与「有没有图床」无关——没配命令时上传项根本不存在）。 */
  imageUploadAuto: boolean
  /** 上传命令：可执行名（PATH 内）或绝对路径，可含前置参数
   *  （引号感知分词，如 `picgo upload`）。图片路径由壳追加在最后。
   *  留空 = 没有图床，图片只走本地副本。 */
  imageCommand: string
  /** 上传命令固定的参数列表（追加在 `<命令+前置参数>` 之后、图片路径之前）。 */
  imageCommandArgs: string[]
  /** 上传超时（毫秒），clamp 到 [1000, 300000]，默认 30s。 */
  imageCommandTimeoutMs: number

  /** 「用其他应用打开」里的那个应用（可执行文件）。留空则回退到系统默认应用。 */
  externalApp: string
  /** 传给外部应用的附加参数（文件路径由壳追加在最后，与图片命令同一约定）。 */
  externalAppArgs: string[]
  /** 最近用过的外部应用（最新在前，最多 KEEP 个）。让"常用应用"由用户自己的选择长出来，
   *  而不是硬编码一份猜出来的路径表——猜错的路径只会让人点了得到"打开失败"。 */
  externalAppRecent: string[]
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
  language: 'system',
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
  markHighlight: true,
  emojiShortcodes: true,
  math: true,
  closeAlwaysConfirmsChanges: true,
  showWhitespace: false,
  codeLineNumbers: true,
  imageCopy: true,
  imageCopyDir: 'images',
  imageUploadAuto: false,
  imageCommand: '',
  imageCommandArgs: [],
  imageCommandTimeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
  externalApp: '',
  externalAppArgs: [],
  externalAppRecent: [],
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

function isLanguage(v: unknown): v is LanguageMode {
  return v === 'system' || v === 'zh-CN' || v === 'en'
}

/** 老键：三档 imageMode。只用于把旧设置迁移到「复制 / 上传」两根轴上。 */
type LegacyImageMode = 'images' | 'assets' | 'command'

function legacyImageMode(v: unknown): LegacyImageMode | null {
  return v === 'images' || v === 'assets' || v === 'command' ? v : null
}

/** 老版本 assets/command 档的目录模板默认值（现在的默认副本目录是 `images`）。 */
const LEGACY_ASSETS_DIR = '{filename}.assets'

/** 副本目录模板只允许普通字符与 `{filename}` 占位符；不含路径分隔与穿越段。 */
function normalizeImageCopyDir(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim()
  if (s === '' || s.includes('..') || /[\\/]/.test(s)) return fallback
  return s.slice(0, 120)
}

/**
 * 副本目录：新键优先；老设置按档位换算——
 * images 档写的是固定的 `images/`，assets/command 档用的才是 `imageAssetsDir` 模板。
 */
function resolveImageCopyDir(src: Record<string, unknown>, base: EditorSettings): string {
  if (src.imageCopyDir !== undefined) return normalizeImageCopyDir(src.imageCopyDir, base.imageCopyDir)
  const mode = legacyImageMode(src.imageMode)
  if (mode === 'images') return 'images'
  if (mode !== null) return normalizeImageCopyDir(src.imageAssetsDir, LEGACY_ASSETS_DIR)
  if (src.imageAssetsDir !== undefined) return normalizeImageCopyDir(src.imageAssetsDir, base.imageCopyDir)
  return base.imageCopyDir
}

/** 要不要本地副本：老的三档都留副本（command 档留的是兜底副本）。 */
function resolveImageCopy(src: Record<string, unknown>, base: EditorSettings): boolean {
  if (typeof src.imageCopy === 'boolean') return src.imageCopy
  if (legacyImageMode(src.imageMode) !== null) return true
  return base.imageCopy
}

/** 上传时机：老的 command 档 = 落盘后立刻上传，另外两档没有上传。 */
function resolveImageUploadAuto(src: Record<string, unknown>, base: EditorSettings): boolean {
  if (typeof src.imageUploadAuto === 'boolean') return src.imageUploadAuto
  const mode = legacyImageMode(src.imageMode)
  if (mode !== null) return mode === 'command'
  return base.imageUploadAuto
}

/** 没有上传命令 = 没有图床。上下两处判据（UI 与插图链路）都从这里取，别各写一份。 */
export function hasImageCommand(s: EditorSettings): boolean {
  return s.imageCommand.trim() !== ''
}

export interface ImagePipeline {
  /** 要不要在文档目录里留一份本地副本。 */
  copy: boolean
  /** 副本目录模板（相对文档目录，单段）。 */
  copyDir: string
  /** 上传时机。 */
  upload: ImageUploadMode
}

/**
 * 两根轴合成的一条动作计划。插图链路与设置界面都只看这个结果，
 * 不再各自去拼 imageCopy / imageUploadAuto——两处各判一次必然会走偏。
 *
 * 两条规则把「图片无处可去」的组合挡在这里：
 *   1) 没有命令 = 没有上传，副本开关因此恒为开（图片只能留在本地）；
 *   2) 不复制 = 必须当场上传（手动上传时正文没有任何地址可写）。
 */
export function imagePipeline(s: EditorSettings): ImagePipeline {
  const copyDir = normalizeImageCopyDir(s.imageCopyDir, DEFAULT_SETTINGS.imageCopyDir)
  if (!hasImageCommand(s)) return { copy: true, copyDir, upload: 'off' }
  if (!s.imageCopy) return { copy: false, copyDir, upload: 'auto' }
  return { copy: true, copyDir, upload: s.imageUploadAuto ? 'auto' : 'manual' }
}

/**
 * 把任意来源（json / localStorage）规范化为 EditorSettings。
 * 字段缺失 → 默认；类型错误 → 默认；数值越界 → 夹取。
 */
export function normalizeSettings(raw: unknown, base: EditorSettings = DEFAULT_SETTINGS): EditorSettings {
  const src = (raw ?? {}) as Record<string, unknown>
  return {
    theme: isTheme(src.theme) ? src.theme : base.theme,
    language: isLanguage(src.language) ? src.language : base.language,
    readingTheme: isReadingThemeId(src.readingTheme) ? src.readingTheme : base.readingTheme,
    fontFamily: isFontFamily(src.fontFamily) ? src.fontFamily : base.fontFamily,
    fontSize: clampInt(src.fontSize, CLAMP.fontSize.min, CLAMP.fontSize.max, base.fontSize),
    lineHeight: clampFloat(src.lineHeight, CLAMP.lineHeight.min, CLAMP.lineHeight.max, base.lineHeight),
    readingWidth: clampInt(src.readingWidth, CLAMP.readingWidth.min, CLAMP.readingWidth.max, base.readingWidth),
    uiZoom: clampInt(src.uiZoom, CLAMP.uiZoom.min, CLAMP.uiZoom.max, base.uiZoom),
    autoCharacterPairs: typeof src.autoCharacterPairs === 'boolean' ? src.autoCharacterPairs : base.autoCharacterPairs,
    markHighlight: typeof src.markHighlight === 'boolean' ? src.markHighlight : base.markHighlight,
    emojiShortcodes: typeof src.emojiShortcodes === 'boolean' ? src.emojiShortcodes : base.emojiShortcodes,
    math: typeof src.math === 'boolean' ? src.math : base.math,
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
    imageCopy: resolveImageCopy(src, base),
    imageCopyDir: resolveImageCopyDir(src, base),
    imageUploadAuto: resolveImageUploadAuto(src, base),
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
    externalApp: String(src.externalApp ?? base.externalApp ?? '').trim().slice(0, 512),
    externalAppArgs: Array.isArray(src.externalAppArgs)
      ? src.externalAppArgs.filter((a): a is string => typeof a === 'string').slice(0, 32).map((a) => a.slice(0, 256))
      : base.externalAppArgs,
    // 最近用过：去重（最新在前）、丢空串、最多 5 个——它只服务一个下拉，没理由无限增长。
    externalAppRecent: Array.isArray(src.externalAppRecent)
      ? [
          ...new Set(
            src.externalAppRecent
              .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
              .map((a) => a.trim().slice(0, 512)),
          ),
        ].slice(0, 5)
      : base.externalAppRecent,
  }
}

export function isDefaultSettings(s: EditorSettings): boolean {
  return JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS)
}

/**
 * 把"刚用过的应用"放进最近列表：去重、最新的排最前、最多 5 个。
 * 放 core 而不是 UI 里，是因为它是个纯函数——能单测的东西就别塞进面板。
 */
export function pushRecentApp(list: readonly string[], app: string): string[] {
  const trimmed = app.trim()
  if (!trimmed) return [...list].slice(0, 5)
  return [trimmed, ...list.filter((a) => a !== trimmed)].slice(0, 5)
}

/**
 * 值看起来像一个"应用"时返回 true——用于失焦时决定要不要收进「最近用过」。
 *
 * 判据必须挡得住**半截输入**：用户打了 `C:\Program` 就点了别处，若"含分隔符就收"，
 * 列表很快被 `C:\Pro`、`C:\Program` 这类碎片塞满——而列表只有 5 个位置，碎片会把
 * 真正有用的挤出去。所以要求"看得出是个可执行体"：
 *   1) 带常见可执行扩展名（exe / app / cmd / bat / com / sh / AppImage）；或
 *   2) 路径至少三层（`/usr/bin/code`、`C:\Apps\Typora`）——两层正是半截输入的形状。
 * 光秃秃的名字（`code`）不收：它和"没打完"在形状上无法区分，想在 PATH 里用它的
 * 用户走「浏览…」更可靠。判据不是路径校验，真正的校验是"点了能不能打开"。
 */
export function isPlausibleAppPath(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/\.(exe|app|cmd|bat|com|sh|AppImage)$/i.test(v)) return true
  if (v.startsWith('/') && v.split('/').filter(Boolean).length >= 3) return true
  return /^[a-zA-Z]:[\\/]/.test(v) && v.split(/[\\/]/).filter(Boolean).length >= 3
}

/**
 * 外部应用的兜底展示名：取路径基名、剥掉可执行扩展名
 * （`C:\Apps\Typora\Typora.exe` → `Typora`，`/Applications/Typora.app` → `Typora`）。
 * 壳侧能拿到更准的名字（exe 的版本资源 / .app 的 bundle 名），这个是拿不到时的下限，
 * 也是菜单标签这种同步上下文里的唯一选择。
 */
export function appDisplayName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return base.replace(/\.(exe|app|cmd|bat|com|sh|AppImage)$/i, '') || base
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

/** 当前阅读主题的排版「家」：滑块刻度、双击复位、⇧⌘0 都指这里，不是全局 17px。 */
export function typographyHome(s: Pick<EditorSettings, 'readingTheme'>) {
  return readingTheme(s.readingTheme).preset
}

/** 当前设置是否与所选主题的标定值逐项一致（用于画廊里标「已微调」）。 */
export function matchesReadingThemePreset(s: EditorSettings): boolean {
  const preset = typographyHome(s)
  return (
    s.fontFamily === preset.fontFamily &&
    s.fontSize === preset.fontSize &&
    s.lineHeight === preset.lineHeight &&
    s.readingWidth === preset.readingWidth
  )
}
