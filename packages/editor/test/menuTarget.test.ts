// 右键分派的判定表。这块逻辑的难点全在**优先级**，而优先级错了界面不会报错
// ——只会弹出一份"看着挺合理"的菜单，或者什么都不弹。所以逐条钉住。
//
// 不需要浏览器：这里测的是纯函数，DOM 探测在 documentMenus.ts 的薄适配层里。
import { describe, expect, test } from 'bun:test'
import { resolveMenuDecision, type MenuHints } from '../src/menuTarget.ts'

/** 默认「点在正文段落上、有文件、无选区」——各用例只改自己关心的那几项。 */
function hints(over: Partial<MenuHints> = {}): MenuHints {
  return {
    inTitlebarTitle: false,
    inEditor: false,
    inField: false,
    inContent: true,
    hasSource: true,
    inProse: true,
    isImage: false,
    linkHref: null,
    inTask: false,
    inBlock: true,
    hasSelection: false,
    ...over,
  }
}

const kind = (h: Partial<MenuHints>) => resolveMenuDecision(hints(h)).kind

describe('右键分派', () => {
  test('顶栏文件名压过一切', () => {
    expect(kind({ inTitlebarTitle: true, inEditor: true, inField: true })).toBe('titlebar')
  })

  test('块内编辑器压过输入控件与正文', () => {
    expect(kind({ inEditor: true, inField: true })).toBe('editor')
  })

  test('输入控件压过正文内容', () => {
    // 设置面板整块都在 DOM 里：把输入框当正文，右键就变成"在下方插入段落"，
    // 粘贴/复制全没了（这一轮修的就是这个）。
    expect(kind({ inField: true })).toBe('field')
  })

  test('没有打开文件时，正文里不给文档菜单', () => {
    // 空态/加载态也在 #content 里，但它们不是文档内容
    expect(kind({ hasSource: false })).toBe('none')
    expect(kind({ hasSource: false, inBlock: false })).toBe('none')
  })

  test('正文里默认给块菜单（点在块上）', () => {
    expect(kind({})).toBe('block')
  })

  test('没落在块上给留白菜单', () => {
    expect(kind({ inBlock: false, inProse: false })).toBe('blankArea')
  })

  test('图片压过链接（图常常包在链接里）', () => {
    expect(kind({ isImage: true, linkHref: 'https://a.com' })).toBe('image')
  })

  test('图片必须在正文里才算', () => {
    // 顶栏图标之类的 <img> 不该给"另存图片"
    expect(kind({ isImage: true, inProse: false, inBlock: false })).toBe('blankArea')
  })

  test('链接带上 href，且必须在正文里', () => {
    expect(resolveMenuDecision(hints({ linkHref: 'https://a.com' }))).toEqual({
      kind: 'link',
      href: 'https://a.com',
    })
    expect(kind({ linkHref: 'https://a.com', inProse: false })).toBe('block')
  })

  test('任务压过块', () => {
    expect(kind({ inTask: true })).toBe('task')
  })

  test('定位不到块的任务当作没命中（交给块/留白）', () => {
    // inTask 由适配层算：li.task 在、但块 id 对不上时为 false
    expect(kind({ inTask: false })).toBe('block')
  })

  test('正文之外：有选区给「复制」', () => {
    expect(kind({ inContent: false, inProse: false, inBlock: false, hasSelection: true })).toBe('copySelection')
  })

  test('正文之外：没选区就什么都不弹（默认菜单已吞）', () => {
    expect(kind({ inContent: false, inProse: false, inBlock: false })).toBe('none')
  })

  test('正文里也有选区时，仍然给内容菜单（选区复制由菜单项补，不顶掉整份菜单）', () => {
    expect(kind({ hasSelection: true })).toBe('block')
  })

  test('侧栏/状态行有选区 → 复制；侧栏没选区 → 不弹', () => {
    const base = { inContent: false, inProse: false, inBlock: false }
    expect(kind({ ...base, hasSelection: true })).toBe('copySelection')
    expect(kind(base)).toBe('none')
  })
})
