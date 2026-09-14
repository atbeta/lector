# @lector/editor

IR 视图：未聚焦块自绘预览 DOM，聚焦块挂裸 CodeMirror 6 编该块源码。可用 Vite 单独打开验证手感（`input type=file` 打开本地 md + 下载保存），不依赖壳。

## 视图模式（三档，名字已锁定）

顶栏右侧的分段控件，三档常驻、当前档常亮：**阅读 / 编辑 / 源码**（`html[data-mode]`）。

| 档 | id | 行为 |
|---|---|---|
| 阅读 | `read` | 纯预览，点块不进编辑。默认档 |
| 编辑 | `edit` | 预览 + 点块就地改源码 |
| 源码 | `source` | 整篇等宽源码，点块进该块的源码编辑 |

三条约束：

1. **不要叫「分屏」**。它从来没有第二条栏——旧版的「分屏」档就是「预览 + 点块编辑」，
   名字在承诺一件不存在的事。真正的并排分栏与本产品「一个文档一个窗口」的模型冲突，
   要做也是另一个功能，不要借这个名字塞进视图档位。
2. **状态只有一个真相**：`html[data-mode]`。样式、点击、快捷键都读它，
   分段控件的选中态由 JS 跟着它走，不允许第二处状态。
3. **热键冲突**：块内的裸 CM 会接管它认识的键（`Mod-e` 行内代码、`Mod-b` 粗体…）
   并 `preventDefault`，而全局快捷键挂在 window 冒泡阶段。全局 handler 第一行必须
   `if (e.defaultPrevented) return`，否则 Windows 上 `Ctrl+E` 会既加行内代码又切档。

## 阅读主题（纸墨 + 排版性格）

一款主题 = **一套纸墨**（`src/styles/reading-themes.css`，按 `data-reading-theme` 生效）
+ **一套标定排版**（`packages/core/src/readingThemes.ts` 的 `preset`）。

- 与 `theme`（明暗）正交：`theme` 管白天/晚上，`readingTheme` 管「读起来像什么」。
  不要造「米黄夜间」这类组合项——那会立刻变成排列组合地狱。
- **数值在 core，纸墨在 CSS**。标定的字号/行距/栏宽/字体写进设置（用户可逐项微调，
  微调后卡片打「已微调」）；CSS 只写颜色与排版性格（缩进、对齐、标题处理、装饰强弱），
  不写那四项数值——写了会和设置里的滑块打架。
- 新增一款主题要同时改两处，且两侧 id 必须一致（`tools/design-audit.mjs` 会核对）。
  少一边的后果是静默的：用户选了它，页面什么都不变。
- 规格行（卡片上那行数字）格式固定四段「特征 · 字号 · 行距 · 栏宽」，
  `packages/core/test/readingThemes.test.ts` 会卡格式与数值一致。
- 主题预览卡自己带 `data-reading-theme`，所以卡上显示的纸墨就是选中后的样子；
  不要为卡片另画一套示意图，那一定会和真实效果漂移。
- 纸墨是手写的，改任何色值都要重跑 `node tools/design-audit.mjs`
  （6 款 × 明暗的正文/次级/链接对纸面必须全过 AA）。

## 红线

- 禁止整页 CM 装饰；CM 实例只编焦点块，禁 `Decoration.replace` widget
- 预览不执行 md 内 HTML/script；HTML 块显示为源码
- 用户文案 i18n（zh-CN + en）从第一天做
- 快捷键提示走 `keys.ts` 的 `mod()` / `modShift()`（mac 出 ⌘，Windows 出 Ctrl+），
  不要在文案里硬写 ⌘ 符号
