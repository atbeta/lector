import { describe, expect, test } from 'bun:test'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { decodeEntities, htmlToMarkdown } from '../src/htmlToMarkdown.ts'
// 用产品同款的共享扩展清单读回（gfm 捆绑包已移除，见 parse.ts）
import { extensions, mdastExtensions } from '../src/parse.ts'

/** 用真实的解析器把结果读回来——转出来的 Markdown 必须自己站得住。 */
function mdast(md: string): any {
  return fromMarkdown(md, { extensions, mdastExtensions })
}

/** 只要节点结构，不要位置信息。 */
function shape(node: any): unknown {
  const out: Record<string, unknown> = { type: node.type }
  if (node.depth != null) out.depth = node.depth
  if (node.ordered != null) out.ordered = node.ordered
  if (node.checked != null) out.checked = node.checked
  if (node.value != null) out.value = node.value
  if (node.url != null) out.url = node.url
  if (node.alt != null) out.alt = node.alt
  if (node.lang != null) out.lang = node.lang
  if (node.children) out.children = node.children.map(shape)
  return out
}

describe('decodeEntities', () => {
  test('命名实体与十进制、十六进制实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x4e2d;')).toBe('a & b <c> A 中')
  })

  test('认不出的实体原样保留', () => {
    expect(decodeEntities('&unknownthing; &amp')).toBe('&unknownthing; &amp')
  })

  test('非法码点不造坏字符', () => {
    expect(decodeEntities('&#0; &#xD800;')).toBe('&#0; &#xD800;')
  })

  test('nbsp 解成不换行空格', () => {
    expect(decodeEntities('a&nbsp;b')).toBe('a\u00a0b')
  })
})

describe('行内', () => {
  test('粗体、斜体、删除线', () => {
    expect(htmlToMarkdown('<p>a <strong>b</strong> <em>c</em> <del>d</del></p>')).toBe('a **b** *c* ~~d~~')
  })

  test('标记内侧贴空白时把空白挪到外面', () => {
    // `** a **` 根本不是加粗，转出这种文本等于把格式丢了
    const md = htmlToMarkdown('<p>x <b> bold </b> y</p>')
    expect(md).toBe('x  **bold**  y')
    expect((shape(mdast(md).children[0]) as any).children?.[1]?.type).toBe('strong')
  })

  test('正文里的 Markdown 记号被转义，不会变成语法', () => {
    const md = htmlToMarkdown('<p>2 * 3 * 4 和 [方括号] 与 a_b_c</p>')
    expect(md).toBe('2 \\* 3 \\* 4 和 \\[方括号\\] 与 a\\_b\\_c')
    const para = mdast(md).children[0]
    expect(para.children.every((c: any) => c.type === 'text')).toBe(true)
  })

  test('行内代码不转义内容，并按内容加长反引号', () => {
    expect(htmlToMarkdown('<p>用 <code>a*b</code> 表示</p>')).toBe('用 `a*b` 表示')
    expect(htmlToMarkdown('<p><code>a ` b</code></p>')).toBe('``a ` b``')
  })

  test('链接带标题，危险协议不转', () => {
    expect(htmlToMarkdown('<p><a href="https://a.com/x" title="T">站</a></p>')).toBe('[站](https://a.com/x "T")')
    // javascript: 只留文字，不给可点的链接
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">点我</a></p>')).toBe('点我')
    expect(htmlToMarkdown('<p><a href="https://a.com/a b">x</a></p>')).toBe('[x](<https://a.com/a b>)')
  })

  test('图片走图片语法，data: 只放行图片类型', () => {
    expect(htmlToMarkdown('<p><img src="img/a.png" alt="图"></p>')).toBe('![图](img/a.png)')
    expect(htmlToMarkdown('<p><img src="data:text/html;base64,xx"></p>')).toBe('')
  })

  test('br 变硬换行，且解析回来仍在同一段里', () => {
    const md = htmlToMarkdown('<p>上<br>下</p>')
    expect(md).toBe('上\\\n下')
    const para = mdast(md).children[0]
    expect(para.type).toBe('paragraph')
    expect(para.children.some((c: any) => c.type === 'break')).toBe(true)
  })

  test('富文本复选框变任务记号', () => {
    expect(htmlToMarkdown('<ul><li><input type="checkbox" checked> 已完成</li></ul>')).toBe('- [x] 已完成')
    expect(htmlToMarkdown('<ul><li><input type="checkbox"> 待办</li></ul>')).toBe('- [ ] 待办')
  })

  test('候选词之间不会粘成一个词', () => {
    const md = htmlToMarkdown('<p>你好 <b>世界</b></p>')
    expect(md).toBe('你好 **世界**')
  })
})

describe('块级', () => {
  test('标题深度与内联格式', () => {
    expect(htmlToMarkdown('<h2>标题 <em>斜</em></h2>')).toBe('## 标题 *斜*')
  })

  test('段落之间空一行，div 只是脱壳', () => {
    expect(htmlToMarkdown('<div><p>一</p><p>二</p></div>')).toBe('一\n\n二')
    expect(mdast(htmlToMarkdown('<div><p>一</p><p>二</p></div>')).children.length).toBe(2)
  })

  test('空段落与纯空白不产出内容', () => {
    expect(htmlToMarkdown('<p>   </p><p>\n</p>')).toBe('')
  })

  test('hr 变分隔线', () => {
    expect(htmlToMarkdown('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb')
    expect(mdast('a\n\n---\n\nb').children[1].type).toBe('thematicBreak')
  })

  test('正文行首的记号被转义，不会变成清单/引用/标题', () => {
    expect(htmlToMarkdown('<p>- 不是清单</p>')).toBe('\\- 不是清单')
    expect(htmlToMarkdown('<p>1. 不是有序清单</p>')).toBe('1\\. 不是有序清单')
    expect(htmlToMarkdown('<p># 不是标题</p>')).toBe('\\# 不是标题')
    expect(htmlToMarkdown('<p>&gt; 不是引用</p>')).toBe('\\> 不是引用')
    const doc = mdast(
      ['- 不是清单', '1. 不是有序清单', '# 不是标题', '> 不是引用'].map((s) => htmlToMarkdown(`<p>${s}</p>`)).join('\n\n'),
    )
    expect(doc.children.every((c: any) => c.type === 'paragraph')).toBe(true)
  })

  test('引用块整段加前缀，多段之间留空引用行', () => {
    const md = htmlToMarkdown('<blockquote><p>一</p><p>二</p></blockquote>')
    expect(md).toBe('> 一\n>\n> 二')
    expect(shape(mdast(md).children[0])).toEqual({
      type: 'blockquote',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: '一' }] },
        { type: 'paragraph', children: [{ type: 'text', value: '二' }] },
      ],
    })
  })
})

describe('列表', () => {
  test('无序列表', () => {
    const md = htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>')
    expect(md).toBe('- 甲\n- 乙')
    expect(shape(mdast(md).children[0])).toEqual({
      type: 'list',
      ordered: false,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: '甲' }] }] },
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: '乙' }] }] },
      ],
    })
  })

  test('有序列表尊重 start', () => {
    expect(htmlToMarkdown('<ol start="3"><li>三</li><li>四</li></ol>')).toBe('3. 三\n4. 四')
    expect(mdast('3. 三\n4. 四').children[0].start).toBe(3)
  })

  test('嵌套列表缩进到正确层级', () => {
    const md = htmlToMarkdown('<ul><li>父<ul><li>子</li></ul></li><li>次</li></ul>')
    expect(md).toBe('- 父\n  - 子\n- 次')
    const list = mdast(md).children[0]
    expect(list.children.length).toBe(2)
    expect(list.children[0].children[1].type).toBe('list')
    expect(list.children[0].children[1].children[0].children[0].children[0].value).toBe('子')
  })

  test('项里第一件事就是子列表时不写出 `- - 子`', () => {
    const md = htmlToMarkdown('<ul><li><ul><li>子</li></ul></li></ul>')
    expect(md).toBe('-\n  - 子')
    const outer = mdast(md).children[0]
    expect(outer.children[0].children[0].type).toBe('list')
  })

  test('项里多段时用空行分开，且不把下一项吞进去', () => {
    const md = htmlToMarkdown('<ul><li><p>一</p><p>二</p></li><li>三</li></ul>')
    const list = mdast(md).children[0]
    expect(list.children.length).toBe(2)
    expect(list.children[0].children.length).toBe(2)
  })

  test('空列表项只留标记', () => {
    expect(htmlToMarkdown('<ul><li></li></ul>')).toBe('-')
  })

  test('li 自动闭合（没有 </li> 的 HTML 也认）', () => {
    const md = htmlToMarkdown('<ul><li>甲<li>乙</ul>')
    expect(md).toBe('- 甲\n- 乙')
  })

  test('项里的正文行首记号同样转义', () => {
    expect(htmlToMarkdown('<ul><li>- 嵌套假象</li></ul>')).toBe('- \\- 嵌套假象')
    const list = mdast('- \\- 嵌套假象').children[0]
    expect(list.children.length).toBe(1)
  })
})

describe('代码块', () => {
  test('pre+code 带语言', () => {
    const md = htmlToMarkdown('<pre><code class="language-js">const a = 1\nconst b = 2</code></pre>')
    expect(md).toBe('```js\nconst a = 1\nconst b = 2\n```')
    const code = mdast(md).children[0]
    expect(code.type).toBe('code')
    expect(code.lang).toBe('js')
    expect(code.value).toBe('const a = 1\nconst b = 2')
  })

  test('高亮代码里的 span 不影响内容', () => {
    const html = '<pre><code><span class="k">const</span> <span>a</span> = 1</code></pre>'
    expect(htmlToMarkdown(html)).toBe('```\nconst a = 1\n```')
  })

  test('内容含 ``` 时加长围栏', () => {
    const md = htmlToMarkdown('<pre><code>```\nx\n```</code></pre>')
    expect(md.startsWith('````')).toBe(true)
    expect(mdast(md).children[0].value).toBe('```\nx\n```')
  })

  test('代码内容不做 Markdown 转义、实体解回字符', () => {
    const md = htmlToMarkdown('<pre><code>a * b &amp;&amp; c</code></pre>')
    expect(md).toBe('```\na * b && c\n```')
  })

  test('空代码块不产出', () => {
    expect(htmlToMarkdown('<pre><code>\n</code></pre>')).toBe('')
  })
})

describe('表格', () => {
  test('表头 + 数据行', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
    )
    expect(md).toBe('| 名 | 值 |\n| --- | --- |\n| a | 1 |')
    const table = mdast(md).children[0]
    expect(table.type).toBe('table')
    expect(table.children.length).toBe(2)
  })

  test('没有表头时补一行空表头，不吃掉第一条数据', () => {
    const md = htmlToMarkdown('<table><tr><td>a</td><td>1</td></tr></table>')
    const table = mdast(md).children[0]
    expect(table.children.length).toBe(2)
    expect(table.children[1].children[0].children[0].value).toBe('a')
  })

  test('单元格里的竖线被转义，列数不足补空', () => {
    const md = htmlToMarkdown('<table><tr><th>a</th><th>b</th></tr><tr><td>x|y</td></tr></table>')
    expect(md).toBe('| a | b |\n| --- | --- |\n| x\\|y |  |')
    expect(mdast(md).children[0].children[1].children.length).toBe(2)
  })

  test('caption 保留成表前的文字', () => {
    const md = htmlToMarkdown('<table><caption>表一</caption><tr><td>a</td></tr></table>')
    expect(md.startsWith('表一\n\n')).toBe(true)
  })
})

describe('脏输入与边界', () => {
  test('不是 HTML 就返回空串（让调用方走原生粘贴）', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown('纯文本，无标签')).toBe('')
  })

  test('script/style 的正文与注释、doctype 都不进结果', () => {
    const html = '<!doctype html><!-- 注释 --><style>p{color:red}</style><script>if (a<b) x()</script><p>正文</p>'
    expect(htmlToMarkdown(html)).toBe('正文')
  })

  test('多余或错配的结束标签被忽略', () => {
    expect(htmlToMarkdown('<p>a</div></p></span>')).toBe('a')
  })

  test('没闭合的标签不吞掉后面的文字', () => {
    expect(htmlToMarkdown('<p>a <b>粗')).toBe('a **粗**')
  })

  test('裸 `<` 当文本保留', () => {
    expect(htmlToMarkdown('<p>a < b</p>')).toBe('a \\< b')
  })

  test('属性里的 `>` 不会把标签切错', () => {
    expect(htmlToMarkdown('<p><a href="https://a.com" title="a > b">x</a></p>')).toBe(
      '[x](https://a.com "a > b")',
    )
  })

  test('浏览器包一层的 html/body/StartFragment 注释照常处理', () => {
    const html =
      '<html><head><meta charset="utf-8"></head><body><!--StartFragment--><p>你好</p><!--EndFragment--></body></html>'
    expect(htmlToMarkdown(html)).toBe('你好')
  })

  test('中文与 CRLF 不丢字', () => {
    expect(htmlToMarkdown('<p>第一段</p>\r\n<p>第二段</p>')).toBe('第一段\n\n第二段')
  })
})
