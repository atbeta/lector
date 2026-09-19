// GitHub 风格 emoji 短代码。只在预览里展开，不进解析、不改磁盘。
// 数据用 gemoji 的 nameToEmoji（:smile: → 😄）；认不出的原样留下。

import { nameToEmoji } from 'gemoji'

const SHORTCODE = /:([a-z0-9_+-]+):/gi

/** 是否把 `:name:` 渲成 emoji。关掉时预览露出短代码源文。 */
let emojiShortcodes = true

export function setEmojiShortcodes(on: boolean): void {
  emojiShortcodes = on
}

export function emojiShortcodesEnabled(): boolean {
  return emojiShortcodes
}

/** 把已转义文本里的已知短代码换成 Unicode。未知名称不改。 */
export function expandEmojiShortcodes(text: string): string {
  if (!text.includes(':')) return text
  return text.replace(SHORTCODE, (whole, name: string) => nameToEmoji[name.toLowerCase()] ?? whole)
}

/** 按当前开关展开；关掉等于原样返回。 */
export function presentEmojiShortcodes(text: string): string {
  return emojiShortcodes ? expandEmojiShortcodes(text) : text
}
