# 自定义样式与 Mermaid

[English](customizing.en.md)

两处都在设置里，贴进去就生效。

- **自定义 CSS**：设置 → 外观 → 高级。注入到页面末尾的 `#lector-custom-css`，排在全部内置样式之后，同名规则能盖住默认。
- **Mermaid 配置**：设置 → Markdown → Mermaid 配置。一段 JSON，合并进每一张图。

字号、行距、栏宽用设置里的控件。它们写在元素自己的样式上，自定义 CSS 改 `--reading-font-size`、`--reading-line-height`、`--reading-max-w` 盖不住。

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
