// 阅读主题：一份可枚举的样式表（无 DOM，可 bun test）。
//
// 主题是什么：**一套标定好的阅读排版 + 一套纸墨**。
//   - 排版（字号 / 行距 / 栏宽 / 字体）写在这里，选主题时一次性套用；
//     之后用户在设置里逐项微调仍然有效——微调不会回写主题本身。
//   - 纸墨与「排版性格」（首行缩进、两端对齐、标题处理、装饰强弱）在
//     packages/editor/src/styles/reading-themes.css 里，按 data-reading-theme 生效。
//
// 为什么分两处：颜色与装饰是 CSS 的职责（跟随深色模式、参与层叠）；
// 数值是设置的职责（要能落在设置 schema 里、要能被测试穷举）。
// 两边用同一批 id，改一个必须改另一个——settings.test 会穷举 id 是否有遗漏。
import type { FontFamily } from './settings.ts'

export type ReadingThemeId = 'default' | 'paper' | 'book' | 'manual' | 'focus' | 'sepia'

export interface ReadingTheme {
  id: ReadingThemeId
  /** 主题名。中文是主名，英文是同一件事的另一半。 */
  name: { zh: string; en: string }
  /** 一句话画面：读者看到这个主题时脑子里应该出现的场景。 */
  tagline: { zh: string; en: string }
  /** 规格行：把「为什么是它」写成可量化的数字，别写形容词。 */
  spec: { zh: string; en: string }
  /** 标定排版。选主题 = 套用这四个值。 */
  preset: {
    fontFamily: FontFamily
    fontSize: number
    lineHeight: number
    readingWidth: number
  }
}

/**
 * 主题清单。顺序即设置面板里的顺序：默认最先，其余按「深读 → 工具 → 安静」排。
 *
 * 命名取自读者熟悉的东西，不取自参数（「窄栏」不是主题名，「纸」才是）。
 * 规格行的数字必须与实际 preset 一致——它们会被渲染在产品里给用户看。
 *
 * 栏宽按 1080p / 2K 屏标定过（原值 560–760；正文现 680–800、手册 1000）：
 * 正文每款守住「一行 38–48 字」这个可读区间，数字跟着字号走；
 * 手册更宽是有意的——文档里的表格、代码、参数表要一行放得下。
 */
export const READING_THEMES: readonly ReadingTheme[] = [
  {
    id: 'default',
    name: { zh: '默认', en: 'Default' },
    tagline: { zh: '无衬线，中性纸面', en: 'Sans, neutral paper' },
    spec: { zh: '中性纸面 · 17px · 1.75 行距 · 800px 栏宽', en: 'Neutral · 17px · 1.75 leading · 800px' },
    preset: { fontFamily: 'system', fontSize: 17, lineHeight: 1.75, readingWidth: 800 },
  },
  {
    id: 'paper',
    name: { zh: '纸', en: 'Paper' },
    tagline: { zh: '像读《纽约客》', en: 'Like reading The New Yorker' },
    spec: { zh: '衬线报刊 · 18px · 1.9 行距 · 720px 栏宽', en: 'Serif · 18px · 1.9 leading · 720px' },
    preset: { fontFamily: 'serif', fontSize: 18, lineHeight: 1.9, readingWidth: 720 },
  },
  {
    id: 'book',
    name: { zh: '书', en: 'Book' },
    tagline: { zh: '像读一本排好的中文书', en: 'Like a typeset Chinese book' },
    spec: { zh: '首行缩进 2 字 · 18px · 1.95 行距 · 780px 栏宽', en: '2em indent · 18px · 1.95 leading · 780px' },
    preset: { fontFamily: 'serif', fontSize: 18, lineHeight: 1.95, readingWidth: 780 },
  },
  {
    id: 'manual',
    name: { zh: '手册', en: 'Manual' },
    tagline: { zh: '像读官方文档', en: 'Like reading the docs' },
    spec: { zh: '标题带下沿 · 16px · 1.68 行距 · 1000px 栏宽', en: 'Ruled headings · 16px · 1.68 leading · 1000px' },
    // 文档场景本来就该更宽：表格、代码、参数表都要一行放得下
    preset: { fontFamily: 'system', fontSize: 16, lineHeight: 1.68, readingWidth: 1000 },
  },
  {
    id: 'focus',
    name: { zh: '专注', en: 'Focus' },
    tagline: { zh: '像在安静的房间里读一页素纸', en: 'Like one clean sheet, nothing else' },
    spec: { zh: '零描边 · 18px · 2.05 行距 · 680px 栏宽', en: 'No rules · 18px · 2.05 leading · 680px' },
    // 这一款故意最窄：它的价值就是「一眼只装得下一段话」，但仍比原来的 560 宽
    preset: { fontFamily: 'system', fontSize: 18, lineHeight: 2.05, readingWidth: 680 },
  },
  {
    id: 'sepia',
    name: { zh: '米黄', en: 'Sepia' },
    tagline: { zh: '像读一份旧剪报', en: 'Like an old clipping' },
    spec: { zh: '暖纸护眼 · 17px · 1.85 行距 · 780px 栏宽', en: 'Warm paper · 17px · 1.85 leading · 780px' },
    preset: { fontFamily: 'system', fontSize: 17, lineHeight: 1.85, readingWidth: 780 },
  },
] as const

export const DEFAULT_READING_THEME: ReadingThemeId = 'default'

const BY_ID = new Map(READING_THEMES.map((t) => [t.id, t] as const))

export function readingTheme(id: ReadingThemeId): ReadingTheme {
  // BY_ID 一定命中：id 类型就是清单的键。命中不到说明清单被改坏了，
  // 退回默认比抛错好——阅读器不该因为一个主题 id 打不开。
  return BY_ID.get(id) ?? READING_THEMES[0]!
}

export function isReadingThemeId(v: unknown): v is ReadingThemeId {
  return typeof v === 'string' && BY_ID.has(v as ReadingThemeId)
}
