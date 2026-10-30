// 预览用的媒体样例：图片放大与代码块复制都要能在这里验
export const mediaSample = `# 媒体预览

下面这张图点击应当放大查看（Esc / 点背景 / 点右上角关闭）：

![示例图片](./images/sample.png)

## 图片状态

上传中占位（粘贴/拖入后、管线完成前的临时形态）：

![](lector-upload://pending-demo)

加载失败的图片（不存在的相对路径 → 弱化虚线框，悬浮可见原始地址）：

![不存在的图片](./images/no-such-file.png)

## 代码块

代码块右上角悬停出现语言标签与复制按钮：

\`\`\`ts
export function countText(text: string): DocStats {
  const cjk = (text.match(CJK) ?? []).length
  return { words: cjk + latinWords(text), chars: text.length, lines: 1 }
}
\`\`\`

普通段落用于对比高度。
`

// 预览用的 frontmatter 样例：属性卡 + 标签列表两种形状都要能看到
export const frontmatterSample = `---
title: 开源文档工具最佳选择
author: Beta
date: 2026-09-12
tags:
  - markdown
  - 阅读器
  - 设计
draft: false
---

# 属性卡预览

上面这段 frontmatter 在预览里渲染成属性表；点击它即可回到原始 YAML 编辑。
`

// 预览用的 mermaid 样例：图要撑满栏宽，点击放大后要按屏幕尺寸铺开（不是一两百 px）
export const mermaidSample = `# 图表预览

流程图默认应当撑满正文栏宽，点击后放大到屏幕尺寸：

\`\`\`mermaid
flowchart LR
  A[读文件] --> B{切片}
  B -->|内容| C[预览块]
  B -->|缝隙| D[unknown 块]
  C --> E[写回原路径]
\`\`\`

只有两个节点的图也不该缩成一小团：

\`\`\`mermaid
graph TD
  X[输入] --> Y[输出]
\`\`\`
`

/** 没有空格、连字符、斜杠，UAX 断行点为空。用来把「放不进栏宽」变成可见的样例。 */
const unbroken = 'Abcdefghij'.repeat(32)

export const boundarySample = `---
title: 栏宽边界
author: Lector
unbrokenfield${unbroken}: 短值
homepage: https://example.com/${unbroken}
---

# 栏宽边界

这段对照用来确认正常阅读没有被拆开。configuration 与 readable 都应完整留在同一行里，中文句子按字换行，不该为了防溢出把每个词都切开。短公式 $E=mc^2$ 仍嵌在句子里。

## 超长 token

段落里的一整段没有断点：${unbroken}

行内代码 \`const token = "${unbroken}"\` 也要留在栏内。

链接文字本身就是这一段：[${unbroken}](https://example.com/${unbroken})

- 列表项末尾同样是 ${unbroken}

> 引用里也不例外：${unbroken}

<details>
<summary>摘要里有一条放不下的 ${unbroken}</summary>

折叠正文仍是正常的一句话，不该被上面的长 token 带出栏宽。
</details>

## 表格

| 名称 | 说明 | 备注 |
| --- | --- | --- |
| 短标签 | ${unbroken} | 普通说明文字 |
| 中文 | 这是一段正常的中文说明，换行应当发生在放不下的时候，而不是每个字单独成行。 | 12 |

| 名称 | 图 | 备注 |
| --- | --- | --- |
| 宽图 | ![2400 像素宽](boundary-wide.svg) | 旁注 |
| 小图 | ![示例](images/sample.png) | 不放大 |

| 名称 | 公式 |
| --- | --- |
| 求和 | $a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n$ |

| 引擎 | 语言 | 体积 | 定位 |
| --- | --- | ---: | --- |
| CodeMirror 6 | TS | ~4MB | 焦点块源码编辑 |
| ProseMirror | TS | 重 | 被排除（保真原罪） |

列多但不宽：十一个短列应当借两侧留白，不能把整表顶成横向滚动；纸上则必须收回页内。

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 |
| 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 |

## 公式

行内长公式：$a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n$

$$
a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+a+b+c+d+e+f+g+h+i+j+k+l+m+n
$$

## 脚注

正文提到一条放不进栏宽的说明[^long]。

[^long]: 脚注正文里的 token 是 ${unbroken}

## 代码块

长行应在代码卡内部横向滚动，而不是把阅读栏撑开。

\`\`\`
${unbroken}
\`\`\`
`

export const sample = `# 阅读体验展示

> Lector —— 阅读优先的 Markdown 编辑器。未聚焦块以预览显示，点击任意块进入源码编辑。

## 中西文混排与行内

在 AI 时代，**读** 远大于 **写**。Markdown 是 AI 内容的事实格式，\`inline code\` 里可以放 \`const a = 1\`，链接请看 [CommonMark](https://commonmark.org)，编号 2026 与指标 1.618 也要排得顺眼。中文段落里混排 Latin 与数字，应当平滑而不突兀。

## 任务列表

- [ ] 未完成任务，后面还有一段未勾选
- [x] 已完成的任务，会显示为勾选态
- [x] 支持多行任务项，当文本足够长而换行时，续行应当对齐在复选框之后而不是回到 bullet 起点缩进。

## 一个表格

| 引擎 | 语言 | 体积 | 定位 |
| --- | --- | --- | --- |
| CodeMirror 6 | TS | ~4MB | 焦点块源码编辑 |
| ProseMirror | TS | 重 | 被排除（保真原罪） |
| Vditor | JS | 重 | 被排除（内核绑定） |

下面这张图点击可放大查看：

![示例图片](./images/sample.png)

## 代码块

\`\`\`ts
export function parseBlocks(text: string): BlockView[] {
  const tree = fromMarkdown(text, { extensions, mdastExtensions })
  return sliceSeamless(tree, text)
}
\`\`\`

---
第二段，用于测试「只改这一块」的切片保真。
`
