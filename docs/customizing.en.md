# Custom CSS and Mermaid

[中文](customizing.md)

Both live in Settings. Paste them in and they take effect.

- **Custom CSS**: Settings → Appearance → Advanced. Injected at the end of the page as `#lector-custom-css`, after every built-in stylesheet, so a matching rule wins.
- **Mermaid config**: Settings → Markdown → Mermaid config. One JSON object, merged into every diagram.

Font size, line height, and column width belong to the settings controls. Those values are written as inline styles, so custom CSS cannot override `--reading-font-size`, `--reading-line-height`, or `--reading-max-w`.

## Custom CSS

Color variables are three numbers, not `#hex`. Built-in rules use `rgb(var(--foreground))`. A value like `#1a1916` does nothing.

Warm paper, slightly softer ink:

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

One brick red for links and diagram strokes. `--content-accent` is also the Mermaid node border:

```css
:root { --content-accent: 150 62 45; }
html[data-theme='dark'] { --content-accent: 232 156 128; }
.reading-prose a { color: rgb(var(--content-accent)); }
```

Tighter headings, looser paragraphs:

```css
.reading-prose h1,
.reading-prose h2,
.reading-prose h3 { margin-bottom: 0.35em; }
.reading-prose p + p { margin-top: 1em; }
```

Recolor the quote bar, and turn code blocks into a left rule:

```css
.reading-prose blockquote { border-left-color: rgb(var(--content-accent)); }
.reading-prose pre {
  background: transparent;
  border: 0;
  border-left: 2px solid rgb(var(--border-strong));
  border-radius: 0;
}
```

Read mode draws a vertical rule when the pointer is over a block. Hide it:

```css
html[data-mode='read'] .block-rail { display: none; }
```

Tighter table cells:

```css
.reading-prose th,
.reading-prose td { padding: 6px 10px; }
```

Stable selectors: `.reading-prose` (body), `blockquote`, `pre` / `code`, `table`, `mark.html-mark` (`==highlight==`), `.table-wrap`, `.mermaid-diagram`.

A bad rule is not reported. The browser drops the declaration it cannot parse; valid rules in the same sheet still apply. If the whole sheet is broken, the built-in styles stay, and the hint under the box does not turn red.

## Mermaid config

Write only the keys you want to change. Every other color still follows the current paper. In dark mode the arrowhead sometimes ignores `lineColor`; set `arrowheadColor` as well.

Moss lines and node strokes:

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

Rounded flowchart edges, and sequence numbers:

```json
{
  "flowchart": { "curve": "basis" },
  "sequence": { "showSequenceNumbers": true }
}
```

Switch to a Mermaid built-in theme. Do not also send `themeVariables`, or you keep Lector's palette and only the theme name changes. The font still follows the app.

```json
{ "theme": "neutral" }
```

Other names: `default`, `dark`, `forest`.

One diagram only — put this on the first line of that fence, not in Settings:

```markdown
%%{init: {"themeVariables": {"lineColor": "#b45309", "arrowheadColor": "#b45309"}}}%%
flowchart LR
  A --> B
```

Colors are baked into the SVG. They do not follow the stylesheet the way body text does. After editing the config, reload the document before the diagrams already on screen pick it up: `Ctrl+R` (`⌘R` on macOS). If the file has unsaved edits, Lector asks before discarding them. A document that has never been saved has nothing to reload, so the shortcut does not repaint the diagrams.

### When the config is invalid

The hint under the box turns red, for example "Not valid JSON: …". An unfinished edit (a missing brace) counts as invalid. That is normal while typing.

Diagrams are not reset to the built-in palette. A parse failure keeps the last config that parsed. Clearing the box is what returns to the built-in colors. `securityLevel`, `startOnLoad`, `maxTextSize`, and `maxEdges` are dropped without an error. Writing them has no effect.
