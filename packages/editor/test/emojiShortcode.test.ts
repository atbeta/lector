import { describe, expect, test } from 'bun:test'
import {
  expandEmojiShortcodes,
  presentEmojiShortcodes,
  setEmojiShortcodes,
} from '../src/emojiShortcode.ts'

describe('expandEmojiShortcodes', () => {
  test('GitHub 常用名换成字符', () => {
    expect(expandEmojiShortcodes(':smile:')).toBe('😄')
    expect(expandEmojiShortcodes(':heart:')).toBe('❤️')
    expect(expandEmojiShortcodes(':rocket:')).toBe('🚀')
    expect(expandEmojiShortcodes(':white_check_mark:')).toBe('✅')
    expect(expandEmojiShortcodes(':x:')).toBe('❌')
    expect(expandEmojiShortcodes('a :coffee: b')).toBe('a ☕ b')
  })

  test('未知名称与半截冒号原样留下', () => {
    expect(expandEmojiShortcodes(':not_an_emoji_xyz:')).toBe(':not_an_emoji_xyz:')
    expect(expandEmojiShortcodes('12:30')).toBe('12:30')
    expect(expandEmojiShortcodes(':')).toBe(':')
  })

  test('别名 +1 也能换', () => {
    expect(expandEmojiShortcodes(':+1:')).toBe('👍')
  })
})

describe('presentEmojiShortcodes', () => {
  test('关掉后露出短代码', () => {
    setEmojiShortcodes(false)
    try {
      expect(presentEmojiShortcodes(':smile:')).toBe(':smile:')
    } finally {
      setEmojiShortcodes(true)
    }
  })
})
