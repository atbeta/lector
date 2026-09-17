// 文案规范（界面上的字是产品的一部分，值得有判据）。
//
// 起因：界面上出现过「不改变今天的行为：图片始终写到 md 同目录的 images/」——
// 那是写给评审者的说明，不是写给用户的文案。用户不需要知道"昨天是什么样"，
// 只需要知道"现在会怎样"。这类话漏进界面，读起来就是莫名其妙的。
//
// 这条测试挡三类问题：
//   1. 口语词与元叙述（今天、其实、我们……）——界面不该自我叙述
//   2. 对"变化"的解释（不变……）——只描述当前行为
//   3. 啰嗦：提示类文案超过 80 字，通常是没想清楚要说什么
//   4. 死 key：加了文案却没人用（452 条里攒出十几条没人用的，界面不会报错，
//      只会在改动时让人以为「挪一下应该没事」——结果是删了才发现别处在用，
//      或者留着永远不显示）
import { describe, expect, test } from 'bun:test'
import { zh } from '../src/i18n.ts'
import { SOURCE_EXTS, ext, readText, walkRepo } from './repoFiles.ts'

/** 口语词 / 元叙述：出现在界面上就是没打磨过。 */
const BANNED = ['今天', '其实', '我们', '一下', '不变', '目前', '有点', '感觉', '大概', '差不多']
const entries = Object.entries(zh)

describe('文案规范', () => {
  test('不含口语词与元叙述', () => {
    const bad: string[] = []
    for (const [key, text] of entries) {
      for (const word of BANNED) {
        if (text.includes(word)) bad.push(`${key}: 「${word}」 → ${text}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('提示类文案不超过 80 字', () => {
    const long = entries.filter(([k, v]) => k.endsWith('Hint') && v.length > 80).map(([k, v]) => `${k}（${v.length} 字）`)
    expect(long).toEqual([])
  })

  test('每个 key 都在代码里被用到', () => {
    // 全部调用都是字面量（没有拼 key 的地方），所以「源码里出现过这个名字」
    // 就等价于「会被用到」——扫描比人工核对可靠。
    const code = walkRepo()
      .filter((f) => SOURCE_EXTS.includes(ext(f)) && !f.endsWith('i18n.ts'))
      .map(readText)
      .join('\n')
    const unused = Object.keys(zh).filter((k) => !code.includes(`'${k}'`) && !code.includes(`"${k}"`))
    expect(unused).toEqual([])
  })
})
