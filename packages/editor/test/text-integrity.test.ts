// 文本完整性：代码与文案里不许出现 U+FFFD（�）。
//
// 起因：仓库里 19 个文件的中文注释被某个非 UTF-8 感知的读写工具啃过，行末的
// 汉字常被换成替换字符。注释腐化只影响可读性，但同一件事落在字符串里就是用户
// 可见的乱码——i18n 的 settingsNoResult、recoverUnsavedHint 和预览样例都中过
// 招（已修）。这条测试挡住的是这一类：**功能性的文本必须完整**。
//
// 只扫「代码 + 字符串」：先把注释剥掉再找。注释里残存的腐化是另一笔要单独清
// 的历史账，不该牵着这条守卫一起变红。
import { describe, expect, test } from 'bun:test'
import { SOURCE_EXTS, ext, readText, relPath, stripComments, walkRepo } from './repoFiles.ts'

describe('文本完整性', () => {
  test('代码与文案里没有 U+FFFD', () => {
    const bad: string[] = []
    for (const file of walkRepo()) {
      const e = ext(file)
      if (!SOURCE_EXTS.includes(e)) continue
      const code = stripComments(readText(file), e)
      code.split('\n').forEach((line, i) => {
        if (line.includes('\uFFFD')) {
          bad.push(`${relPath(file)}:${i + 1}  ${line.trim().slice(0, 80)}`)
        }
      })
    }
    expect(bad).toEqual([])
  })
})
