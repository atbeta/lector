# 自定义样式与 Mermaid

[English](customizing.en.md)

两处都在设置里，贴进去就生效。

- **自定义 CSS**：设置 → 外观 → 高级。注入到页面末尾的 `#lector-custom-css`，排在全部内置样式之后，同名规则能盖住默认。
- **Mermaid 配置**：设置 → Markdown → Mermaid 配置。一段 JSON，合并进每一张图。

字号、行距、栏宽用设置里的控件。它们写在元素自己的样式上，自定义 CSS 改 `--reading-font-size`、`--reading-line-height`、`--reading-max-w` 盖不住。

下面两张表是正文和壳上稳定的名字。设置弹窗内部的控件不在这里：那些 class 会随界面改版变掉。

## CSS 变量

颜色是三个数（`26 25 22`），用 `rgb(var(--foreground))` 或 `rgb(var(--foreground) / 0.4)`。字体、字号、圆角、间距是完整的 CSS 值。暗色写在 `html[data-theme='dark']` 里，否则一切回浅色就丢了。

| 变量 | 管什么 |
| --- | --- |
| `--background` | 正文以外的画布 |
| `--paper` | 正文纸面 |
| `--card` `--card-foreground` | 卡片表面和卡片上的字 |
| `--popover` `--popover-foreground` | 菜单、浮层 |
| `--shell` | 顶栏 |
| `--foreground` | 正文墨色 |
| `--muted` | 行内代码和代码块的底 |
| `--muted-foreground` | 次级文字（表头、元数据） |
| `--subtle-foreground` | 更淡的说明（行号、图注） |
| `--quote-foreground` | 引用块正文 |
| `--accent` `--accent-foreground` | 悬停底 |
| `--secondary` `--secondary-foreground` | 按下时的底 |
| `--primary` `--primary-foreground` `--primary-hover` | 链接、勾选框。阅读主题会改它 |
| `--primary-soft` `--primary-softer` `--selection` | 浅洗和选中底。一般跟着 `--primary` 走，不必单独改 |
| `--content-accent` | 图表描边，也是少数界面上的强调色 |
| `--mark-bg` | `==高亮==` 的底 |
| `--ink` `--ink-foreground` | 实心按钮（打开文件等），不跟阅读主题走 |
| `--success` `--warning` `--destructive` 及对应的 `-soft` / `-foreground` | 成功、警告、危险 |
| `--border` `--border-strong` `--border-subtle` | 发丝边、结构线（引用条、分隔线）、表格行线 |
| `--input` `--ring` | 输入框边、焦点环 |
| `--block-focus-bg` `--block-hover-bg` `--block-rail` | 聚焦块衬底、悬停衬底、左侧竖线 |
| `--code-keyword` `--code-string` `--code-comment` `--code-number` | 代码高亮四色 |
| `--font-sans` `--font-serif` `--font-mono` | 界面、衬线正文、等宽 |
| `--text-2xs` `--text-xs` `--text-sm` `--text-base` `--text-md` `--text-xl` | 界面字号 |
| `--text-h1` … `--text-h6` | 标题字号 |
| `--radius` `--radius-card` `--radius-media` `--radius-btn` `--radius-xl` | 圆角。图、表、代码块用 `--radius-media` |
| `--space-block` `--space-tight` `--space-section` | 块间距、标题下的紧间距、分隔线两侧 |
| `--shadow-color` `--shadow-card` `--shadow-floating` `--shadow-header` `--shadow-btn-primary` | 投影 |
| `--overlay` `--overlay-alpha` `--overlay-foreground` | 遮罩和遮罩上的字 |

`--reading-font` 由阅读主题写成字体族。字号、行距、栏宽对应的 `--reading-font-size`、`--reading-line-height`、`--reading-max-w` 由设置控件写成内联样式，自定义 CSS 盖不住。

## 节点

正文包在 `.reading-prose` 里。每个块是 `#content > .block`，`data-kind` 为 `paragraph`、`heading`、`list`、`blockquote`、`code`、`table`、`thematicBreak`、`html`、`yaml`、`math`。标题另有 `data-depth="1"` … `"6"`。页面状态在 `<html>` 上：`data-theme="light|dark"`、`data-mode="read|edit|source"`、`data-reading-theme`（当前阅读主题）。

| 选择器 | 是什么 |
| --- | --- |
| `#titlebar` `#content` `#statusbar` `.sidebar` | 顶栏、正文滚动区、状态行、大纲侧栏 |
| `.mode-opt` | 阅读 / 编辑 / 源码切换 |
| `.block` `.block.focused` `.block-rail` `.block-handle` | 块、正在编辑的块、阅读档竖线、编辑档把手 |
| `.source-view` `.cm-host` | 源码档的块、聚焦后的编辑器 |
| `.reading-prose h1` … `h6` | 标题 |
| `.reading-prose p` `a` `hr` `ul` `ol` `li` | 段落、链接、分隔线、列表 |
| `.reading-prose blockquote` | 引用 |
| `.reading-prose code` `pre` `pre.has-ln` `.ln-gutter` | 行内代码、代码块、带行号的块、行号 |
| `.reading-prose .token.comment` `.token.string` `.token.number` `.token.keyword` | 代码高亮。同类还有 `.prolog` `.string` `.char` `.attr-value` `.regex` `.url` `.inserted` `.boolean` `.constant` `.symbol` `.builtin` `.important` `.atrule` `.tag` `.selector` `.class-name` `.function` `.property` `.variable` |
| `.table-wrap` `table` `th` `td` | 表格。对齐在 `data-align="left\|center\|right"` |
| `.table-wrap.is-scroll` | 比栏宽还宽、在栏内横滑的表 |
| `mark.html-mark` | `==高亮==` |
| `li.task` `.task-label` | 任务列表 |
| `.frontmatter` `.fm-key` `.fm-value` `.fm-tag` `.fm-empty` `.fm-list` | 文首属性 |
| `.html-details` | `<details>` |
| `.img-pending` | 图片还在上传 |
| `.math.math-inline` `.math.math-block` `.math-error` `.math-error-inline` | 公式和公式错误 |
| `.footnote-ref` `.footnote-definition` `.footnote-definition-anchor` `.footnote-definition-body` `.footnote-backref` | 脚注 |
| `.preform` `.preform.yaml` `.preform.unknown` | 没渲染成预览的原文（YAML、未知块） |
| `.code-card` `.code-bar` `.code-copy` `.mermaid-export` | 代码块和图表上的工具条 |
| `.mermaid-diagram` `.mermaid-svg` `.mermaid-live` `.mermaid-error` | 图、图的 SVG、编辑时的实时预览、渲染失败 |
| `.find-hit` | 查找命中 |

## Mermaid 能盖的键

写在 `themeVariables` 里的键会盖住同名的内置值，没写的保持现状。这些是已经接上的：

`background` `fontFamily` `primaryColor` `primaryBorderColor` `primaryTextColor` `lineColor` `textColor` `nodeBorder` `mainBkg` `secondaryColor` `tertiaryColor` `clusterBkg` `clusterBorder` `edgeLabelBackground` `titleColor` `actorBkg` `actorBorder` `actorTextColor` `signalColor` `signalTextColor` `labelBoxBkgColor` `labelBoxBorderColor` `labelTextColor` `loopTextColor` `noteBkgColor` `noteBorderColor` `noteTextColor` `activationBkgColor` `activationBorderColor` `classText`

暗色下箭头建议同时写 `arrowheadColor`。图种选项不在这张表里，直接写在 JSON 顶层，例如 `flowchart`、`sequence`、`gantt`。

## 自定义 CSS

颜色变量要写成三个数，不要写 `#hex`。内置写法是 `rgb(var(--foreground))`，写成 `#1a1916` 会失效。

纸面改成暖米，正文墨色稍微淡一点：

```css
:root {
  --paper: 250 246 236;
  --foreground: 42 36 28;
  --quote-foreground: 90 72 52;
  --mark-bg: 240 214 140;
}
html[data-theme='dark'] {
  --paper: 32 29 26;
  --foreground: 236 228 214;
  --mark-bg: 92 72 36;
}
```

链接和图表描边换成同一支砖红。`--content-accent` 同时管 Mermaid 节点边框：

```css
:root { --content-accent: 150 62 45; }
html[data-theme='dark'] { --content-accent: 232 156 128; }
.reading-prose a { color: rgb(var(--content-accent)); }
```

标题紧一点，段落松一点：

```css
.reading-prose h1,
.reading-prose h2,
.reading-prose h3 { margin-bottom: 0.35em; }
.reading-prose p + p { margin-top: 1em; }
```

引用条换色，代码块改成一条左边线：

```css
.reading-prose blockquote { border-left-color: rgb(var(--content-accent)); }
.reading-prose pre {
  background: transparent;
  border: 0;
  border-left: 2px solid rgb(var(--border-strong));
  border-radius: 0;
}
```

阅读档里鼠标移到块上会出一条竖线。不想要就关掉：

```css
html[data-mode='read'] .block-rail { display: none; }
```

表格格子收紧：

```css
.reading-prose th,
.reading-prose td { padding: 6px 10px; }
```

常用选择器：`.reading-prose`（正文）、`blockquote`、`pre` / `code`、`table`、`mark.html-mark`（`==高亮==`）、`.table-wrap`、`.mermaid-diagram`。

写错时没有单独的报错。浏览器丢掉无法解析的那一条，同一段里写对的规则仍然生效。整段都坏了，页面就保持内置样式，输入框下方不会变红。

## Mermaid 配置

只写要改的键。其余颜色仍跟当前纸面走。暗色下箭头有时不跟 `lineColor`，要一起写 `arrowheadColor`。

线和节点描边改成墨绿：

```json
{
  "themeVariables": {
    "lineColor": "#5f6f64",
    "arrowheadColor": "#5f6f64",
    "primaryBorderColor": "#2f6f4e",
    "nodeBorder": "#2f6f4e",
    "primaryColor": "#f4f7f4",
    "mainBkg": "#f4f7f4",
    "primaryTextColor": "#1c1917"
  }
}
```

流程图用圆角曲线，时序图显示序号：

```json
{
  "flowchart": { "curve": "basis" },
  "sequence": { "showSequenceNumbers": true }
}
```

整份换成 Mermaid 自己的主题。这样写时不要再带 `themeVariables`，否则还是我们的调色板、只是主题名换了。字体仍跟界面。

```json
{ "theme": "neutral" }
```

可用的名字还有 `default`、`dark`、`forest`。

只要一张图不一样，写在这个代码块第一行，不要写进设置：

```markdown
%%{init: {"themeVariables": {"lineColor": "#b45309", "arrowheadColor": "#b45309"}}}%%
flowchart LR
  A --> B
```

颜色画进 SVG，不会像正文那样跟着样式表变。配置改完后，已经在屏幕上的图要重新加载这份文档才换新颜色：`Ctrl+R`（macOS 是 `⌘R`）。有未保存的修改时会先问要不要丢弃。文件还没保存到磁盘时，重新加载没有目标，这条快捷键不会重画图。

### 配置写错时

输入框下面的说明会变成红字，例如「不是合法 JSON：…」。还没写完（少一个括号）也算错，这是边打边看时的常态。

图不会被打回默认色。解析失败时沿用上一份合法配置；输入框清空后才回到内置配色。`securityLevel`、`startOnLoad`、`maxTextSize`、`maxEdges` 会被丢掉，不报错，写了也不生效。
