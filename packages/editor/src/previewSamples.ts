// 预览用的媒体样例：图片放大与代码块复制都要能在这里验
export const mediaSample = `# 媒体预览

下面这张图点击应当放大查看（Esc / 点背景 / 点右上角关闭）：

![示例图片](./images/sample.png)

## 代码块

代码块右上角悬停出现语言标签与复制按钮：

\`\`\`ts
export function countText(text: string): DocStats {
  const cjk = (text.match(CJK) ?? []).length
  return { words: cjk + latinWords(text), chars: text.length, lines: 1 }
}
\`\`\`

普��段落用于对比高度。
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

export const sample = `# 阅读体验展示

> Lector —— 阅读优先的纯 Markdown 编辑器。未聚焦块以预览显示，点击任意块进入源码编辑。

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
