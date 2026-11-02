# Custom CSS and Mermaid

[中文](customizing.md)

Both live in Settings. Paste them in and they take effect.

- **Custom CSS**: Settings → Appearance → Advanced. Injected at the end of the page as `#lector-custom-css`, after every built-in stylesheet, so a matching rule wins.
- **Mermaid config**: Settings → Markdown → Mermaid config. One JSON object, merged into every diagram.

Font size, line height, and column width belong to the settings controls. Those values are written as inline styles, so custom CSS cannot override `--reading-font-size`, `--reading-line-height`, or `--reading-max-w`.

The two tables below are the stable names on the reading surface and the shell. Classes inside the settings dialog are omitted; those move when the UI does.

## CSS variables

Colors are three numbers (`26 25 22`), used as `rgb(var(--foreground))` or `rgb(var(--foreground) / 0.4)`. Fonts, sizes, radii, and spacing are full CSS values. Dark overrides go under `html[data-theme='dark']`, or they disappear when the theme switches back to light.

| Variable | What it paints |
| --- | --- |
| `--background` | Canvas around the page |
| `--paper` | Page surface |
| `--card` `--card-foreground` | Card surface and its text |
| `--popover` `--popover-foreground` | Menus and popovers |
| `--shell` | Title bar |
| `--foreground` | Body ink |
| `--muted` | Inline-code and code-block background |
| `--muted-foreground` | Secondary text (table headers, metadata) |
| `--subtle-foreground` | Quieter captions (line numbers, figure notes) |
| `--quote-foreground` | Blockquote text |
| `--accent` `--accent-foreground` | Hover fill |
| `--secondary` `--secondary-foreground` | Pressed fill |
| `--primary` `--primary-foreground` `--primary-hover` | Links and checkboxes. Reading themes change this |
| `--primary-soft` `--primary-softer` `--selection` | Soft washes and the selection. They follow `--primary`; override them only if that wash is wrong |
| `--content-accent` | Diagram strokes, and a few UI accents |
| `--mark-bg` | `==highlight==` background |
| `--ink` `--ink-foreground` | Solid buttons (Open, and the like). Not tied to the reading theme |
| `--success` `--warning` `--destructive` and the matching `-soft` / `-foreground` | Success, warning, danger |
| `--border` `--border-strong` `--border-subtle` | Hairline, structural rules (quotes, rules), table row rules |
| `--input` `--ring` | Field border, focus ring |
| `--block-focus-bg` `--block-hover-bg` `--block-rail` | Focused-block wash, hover wash, the left-edge rule |
| `--code-keyword` `--code-string` `--code-comment` `--code-number` | The four code colors |
| `--font-sans` `--font-serif` `--font-mono` | UI, serif body, monospace |
| `--text-2xs` `--text-xs` `--text-sm` `--text-base` `--text-md` `--text-xl` | UI sizes |
| `--text-h1` … `--text-h6` | Heading sizes |
| `--radius` `--radius-card` `--radius-media` `--radius-btn` `--radius-xl` | Radii. Figures, tables, and code use `--radius-media` |
| `--space-block` `--space-tight` `--space-section` | Block gap, tight gap under headings, gap around a rule |
| `--shadow-color` `--shadow-card` `--shadow-floating` `--shadow-header` `--shadow-btn-primary` | Shadows |
| `--overlay` `--overlay-alpha` `--overlay-foreground` | Scrim and the type on it |

`--reading-font` is the reading theme's font family. `--reading-font-size`, `--reading-line-height`, and `--reading-max-w` are inline styles from the settings controls. Custom CSS does not override them.

## Nodes

Body copy sits in `.reading-prose`. Each block is `#content > .block` with `data-kind` of `paragraph`, `heading`, `list`, `blockquote`, `code`, `table`, `thematicBreak`, `html`, `yaml`, or `math`. Headings also have `data-depth="1"` … `"6"`. Page state is on `<html>`: `data-theme="light|dark"`, `data-mode="read|edit|source"`, and `data-reading-theme` (the current reading theme).

| Selector | What it is |
| --- | --- |
| `#titlebar` `#content` `#statusbar` `.sidebar` | Title bar, scrolling body, status row, outline sidebar |
| `.mode-opt` | Read / Edit / Source switch |
| `.block` `.block.focused` `.block-rail` `.block-handle` | A block, the block being edited, the read-mode rule, the edit-mode handle |
| `#content.source-doc` `.source-doc-host` | Source mode: one whole-document editor in the body |
| `.cm-host` | The focused block's editor |
| `.reading-prose h1` … `h6` | Headings |
| `.reading-prose p` `a` `hr` `ul` `ol` `li` | Paragraphs, links, rules, lists |
| `.reading-prose blockquote` | Quotes |
| `.reading-prose code` `pre` `pre.has-ln` `.ln-gutter` | Inline code, code blocks, a numbered block, the gutter |
| `.reading-prose .token.comment` `.token.string` `.token.number` `.token.keyword` | Code color. The same groups include `.prolog` `.string` `.char` `.attr-value` `.regex` `.url` `.inserted` `.boolean` `.constant` `.symbol` `.builtin` `.important` `.atrule` `.tag` `.selector` `.class-name` `.function` `.property` `.variable` |
| `.table-wrap` `table` `th` `td` | Tables. Alignment is `data-align="left\|center\|right"` |
| `.table-wrap.is-scroll` | A table wider than the column, scrolling inside it |
| `mark.html-mark` | `==highlight==` |
| `li.task` `.task-label` | Task lists |
| `.frontmatter` `.fm-key` `.fm-value` `.fm-tag` `.fm-empty` `.fm-list` | Frontmatter |
| `.html-details` | `<details>` |
| `.img-pending` | An image still uploading |
| `.math.math-inline` `.math.math-block` `.math-error` `.math-error-inline` | Math, and a failed formula |
| `.footnote-ref` `.footnote-definition` `.footnote-definition-anchor` `.footnote-definition-body` `.footnote-backref` | Footnotes |
| `.preform` `.preform.yaml` `.preform.unknown` | Source left as source (YAML, unknown blocks) |
| `.code-card` `.code-bar` `.code-copy` `.mermaid-export` | The toolbar on a code block or diagram |
| `.mermaid-diagram` `.mermaid-svg` `.mermaid-live` `.mermaid-error` | A diagram, its SVG, the live preview while editing, a render error |
| `.find-hit` | A find match |

## Mermaid keys you can override

A key under `themeVariables` replaces the built-in value of the same name. Anything you omit stays as it is. These are wired up:

`background` `fontFamily` `primaryColor` `primaryBorderColor` `primaryTextColor` `lineColor` `textColor` `nodeBorder` `mainBkg` `secondaryColor` `tertiaryColor` `clusterBkg` `clusterBorder` `edgeLabelBackground` `titleColor` `actorBkg` `actorBorder` `actorTextColor` `signalColor` `signalTextColor` `labelBoxBkgColor` `labelBoxBorderColor` `labelTextColor` `loopTextColor` `noteBkgColor` `noteBorderColor` `noteTextColor` `activationBkgColor` `activationBorderColor` `classText`

In dark mode, set `arrowheadColor` along with `lineColor`. Diagram options are not in that list; they sit at the top of the JSON, for example `flowchart`, `sequence`, `gantt`.

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
