# Lector Changelog

Per-version user-facing changes, newest first. Each release is grouped by
Conventional Commits prefix into four buckets:

- **Added** — new features
- **Fixed** — bug fixes
- **Improved** — refactors, performance, styling, CI, and other non-feature changes
- **Internal** — docs, comments, and other non-user-visible cleanup

Skipped from the changelog: `chore:` (repo maintenance), `test:` (test code),
and the `chore(release):` commits themselves.
[compare all](https://github.com/atbeta/lector/commits/main)

> Note: bullets are taken verbatim from commit messages, so a single version
> may mix Chinese and English depending on who wrote each commit. Translation
> would break `git blame` traceability, so it is intentionally not done.

## v0.34.8 (2026-09-20)

### Fixed

- fix(shell): repair scrambled monitor_from_point block that broke the Windows build in v0.34.7

[v0.34.8]: https://github.com/atbeta/lector/compare/v0.34.7...v0.34.8

## v0.34.7 (2026-09-20)

### Added

- feat(stats): count via mdast rendered text - exclude frontmatter/URLs, keep contractions, add char count

### Fixed

- fix(shell): restore minimized window when reopening its document

### Improved

- perf(stats): incremental per-block counting via cached mdast - 1MB doc 3.1s to 40ms

[v0.34.7]: https://github.com/atbeta/lector/compare/v0.34.6...v0.34.7

## v0.34.0 (2026-09-20)

### Added

- insert images from a picker and expose setting homes

### Improved

- fix auto-pair label and tighten image hint

[v0.34.0]: https://github.com/atbeta/lector/compare/v0.33.0...v0.34.0

## v0.33.0 (2026-09-20)

### Added

- keep data beside the app and open it from settings
- report uncaught errors to the shell log

### Fixed

- keep error reporting from looping and flooding

### Improved

- align settings search and tighten copy

[v0.33.0]: https://github.com/atbeta/lector/compare/v0.32.0...v0.33.0

## v0.32.0 (2026-09-20)

### Added

- give macOS an inset satin Dock icon

### Fixed

- align titlebar buttons to native traffic lights
- keep the outline scrollbar out from under the grip
- keep pipes inside code spans as one cell
- size gantt charts to the reading column
- enter the block on click in edit mode

### Improved

- sign and notarize arm64 releases

[v0.32.0]: https://github.com/atbeta/lector/compare/v0.31.0...v0.32.0

## v0.31.0 (2026-09-19)

### Added

- render GitHub emoji shortcodes in preview
- render HTML mark and img via the preview whitelist
- split image settings into copy and upload axes
- honor GFM column alignment and add column rules
- add an Extensions section for math and ==highlight==
- surface open-with in the file action group
- rework external-app config as a dedicated section

### Fixed

- stop double-spacing the divider in read mode
- stop toggling content-visibility on every render
- keep the scrollbar thin in WKWebView
- show the same external app name in the menu and settings
- hide stranded dividers in the empty state
- copy plain text works in source mode
- make find hits and inline sub/sup render correctly

### Improved

- keep mid-size docs smooth while typing and reading
- keep scroll at 60fps by caching outline offsets
- skip unchanged blocks when re-rendering
- reorganize settings and polish window chrome
- drop the toolbar button, open the sheet with Cmd+/
- trim the toolbar and dock the find bar
- cleaner lead-group icons, literal PDF glyph
- give the 32px Windows bar breathing room
- fit the appearance section without scrolling
- unify block labels, group app list, protect hint tokens
- polish settings panel surfaces and controls

[v0.31.0]: https://github.com/atbeta/lector/compare/v0.30.1...v0.31.0

## v0.29.0 (2026-09-18)

### Added

- scale the UI with native webview zoom
- widen the default column to 800px and the manual theme to 1000px

### Fixed

- keep row labels on one line and tidy the test-command row
- keep the outline sidebar from scrolling away its left padding
- stop advanced settings textareas from overflowing and resizing
- keep a poisoned lock from taking the whole shell down

### Improved

- make global shortcut dispatch a pure decision table
- split io.rs into domain modules
- finish splitting platform.ts into domain modules
- start splitting platform.ts - extract the shared core

### Internal

- add v1 acceptance record for perf and IME
- align the project package with what shipped
- point stale io.rs references at io/window.rs
- bring the shell contract back in line with the code

[v0.29.0]: https://github.com/atbeta/lector/compare/v0.28.1...v0.29.0

## v0.28.1 (2026-09-18)

### Fixed

- stop the resize grip from drawing a second line on hover
- make the rot check survive a shallow clone

[v0.28.1]: https://github.com/atbeta/lector/compare/v0.28.0...v0.28.1

## v0.28.0 (2026-09-18)

### Added

- re-implement the reading-polish line on our branch
- show the window only after the page has painted

### Fixed

- restore two user-visible strings damaged by encoding rot
- five visual problems from the polish pass
- drop the stray pnpm lockfile, keep bun as the only package manager

### Improved

- make the right-click decision table pure and tested
- split app.css into five ordered partials

[v0.28.0]: https://github.com/atbeta/lector/compare/v0.27.5...v0.28.0

## v0.27.5 (2026-09-17)

### Added

- open dropped md/txt via native drag-drop channel;

[v0.27.5]: https://github.com/atbeta/lector/compare/v0.27.4...v0.27.5

## v0.27.4 (2026-09-17)

### Fixed

- drop stale micromark-extension-gfm imports;

[v0.27.4]: https://github.com/atbeta/lector/compare/v0.27.3...v0.27.4

## v0.27.3 (2026-09-17)

### Added

- refactor codePreview.ts for mermaid rendering & resize observer
- enhance Gantt chart task bar width handling in mermaid rendering
- add new icon and update footnote backref display
- enhance footnote rendering and scrolling logic
- update micromark extensions to latest versions

### Fixed

- gantt canvas floor 1000px with min-width lock;

[v0.27.3]: https://github.com/atbeta/lector/compare/v0.27.2...v0.27.3

## v0.27.2 (2026-09-17)

### Fixed

- add missing gfm-footnote tokenizer;

[v0.27.2]: https://github.com/atbeta/lector/compare/v0.27.1...v0.27.2

## v0.27.1 (2026-09-17)

### Fixed

- allow anchor clicks in shouldOpenHref;

[v0.27.1]: https://github.com/atbeta/lector/compare/v0.27.0...v0.27.1

## v0.27.0 (2026-09-17)

### Added

- tint diagrams with dedicated indigo accent;
- in-document anchor links jump to headings (GitHub slug compat)
- per-codeblock wrap toggle button next to copy (pref persists)
- footnote rendering, ==mark== highlight, details/kbd HTML whitelist

### Fixed

- suppress console flash when opening external links on Windows
- center diagrams;

[v0.27.0]: https://github.com/atbeta/lector/compare/v0.26.10...v0.27.0

## v0.26.10 (2026-09-17)

### Fixed

- drop redundant tooltip on recent-file list items
- overlay covers entire export;

[v0.26.10]: https://github.com/atbeta/lector/compare/v0.26.9...v0.26.10

## v0.26.9 (2026-09-17)

### Fixed

- spinner covers theme flip and mermaid wait;
- keep copy button right-aligned on code blocks without a language label

[v0.26.9]: https://github.com/atbeta/lector/compare/v0.26.8...v0.26.9

## v0.26.8 (2026-09-17)

### Fixed

- all visual changes after save dialog;

[v0.26.8]: https://github.com/atbeta/lector/compare/v0.26.7...v0.26.8

## v0.26.7 (2026-09-17)

### Added

- add exporting PDF feedback and update exportPdf function

### Fixed

- theme flip via setThemeMode so mermaid re-renders light;

[v0.26.7]: https://github.com/atbeta/lector/compare/v0.26.6...v0.26.7

## v0.26.6 (2026-09-17)

### Fixed

- overlay must not be captured;

[v0.26.6]: https://github.com/atbeta/lector/compare/v0.26.5...v0.26.6

## v0.26.5 (2026-09-17)

### Fixed

- drop offscreen print window;

[v0.26.5]: https://github.com/atbeta/lector/compare/v0.26.4...v0.26.5

## v0.26.4 (2026-09-17)

### Fixed

- runtime window placement, step-title diagnostics, error bridge, print-* capabil…

[v0.26.4]: https://github.com/atbeta/lector/compare/v0.26.3...v0.26.4

## v0.26.3 (2026-09-17)

### Added

- export via offscreen print window;

[v0.26.3]: https://github.com/atbeta/lector/compare/v0.26.2...v0.26.3

## v0.26.2 (2026-09-17)

### Added

- enhance print and PDF export styles for better rendering

### Fixed

- print styles as .printing class with !

[v0.26.2]: https://github.com/atbeta/lector/compare/v0.26.1...v0.26.2

## v0.26.1 (2026-09-17)

### Fixed

- re-raise snap overlay after WebView2 settles its z-order

[v0.26.1]: https://github.com/atbeta/lector/compare/v0.26.0...v0.26.1

## v0.26.0 (2026-09-17)

### Added

- enhance file handling with closeWindow and reload confirmations
- enhance window scaling and update export button icon

[v0.26.0]: https://github.com/atbeta/lector/compare/v0.25.7...v0.26.0

## v0.25.7 (2026-09-17)

### Fixed

- render() must not wipe empty state when no document is open
- compile pdf export against real webview2-com API;
- register pdf export deps in Cargo.lock

[v0.25.7]: https://github.com/atbeta/lector/compare/v0.25.6...v0.25.7

## v0.25.6 (2026-09-17)

### Added

- PDF export via WebView2 PrintToPdf with shared print CSS

### Fixed

- single-path window restore, shell-injected early theme, palette appearance icon

[v0.25.6]: https://github.com/atbeta/lector/compare/v0.25.5...v0.25.6

## v0.25.5 (2026-09-17)

### Fixed

- empty paragraph keeps a clickable surface;

[v0.25.5]: https://github.com/atbeta/lector/compare/v0.25.4...v0.25.5

## v0.25.4 (2026-09-17)

### Added

- code line numbers with settings toggle;
- add code line numbers setting and display in editor

### Fixed

- drop chcp 65001 from assoc cmds;
- image context menu gains delete and insert-paragraph actions

### Improved

- encode portable cmds as GBK and assert it in smoke test

[v0.25.4]: https://github.com/atbeta/lector/compare/v0.25.3...v0.25.4

## v0.25.3 (2026-09-17)

### Improved

- dedicated 6px media radius for images, tables, code blocks
- instant modal backdrop, snappier card entrance

[v0.25.3]: https://github.com/atbeta/lector/compare/v0.25.2...v0.25.3

## v0.25.2 (2026-09-17)

### Added

- portable zip ships md icon and file-assoc cmd scripts

### Fixed

- carve GFM-absorbed paragraph lines out of table blocks

### Improved

- assemble portable zip with icon and assoc scripts
- instant nav/find jumps;

[v0.25.2]: https://github.com/atbeta/lector/compare/v0.25.1...v0.25.2

## v0.25.1 (2026-09-17)

### Fixed

- make the link path tests platform-neutral

[v0.25.1]: https://github.com/atbeta/lector/compare/v0.25.0...v0.25.1

## v0.25.0 (2026-09-17)

### Added

- let users configure mermaid themselves
- follow local links from a document
- show block boundaries and put the block menu on a handle

### Fixed

- keep the context menu from stealing focus from a selection
- stop "insert below" gluing the new block to the line above
- keep editing actions out of the read-mode menus
- read the clipboard through the shell so menu paste works
- retry mermaid and katex after a failed chunk load
- stop ui-verify matching Chinese labels
- stop repeating the copy format and the section label
- tighten find bar grouping and drop the empty count gap
- make table grid chrome symmetric and aligned
- repair truncated head script that swallowed favicon and title setup

### Improved

- split main.ts into focused controller modules

[v0.25.0]: https://github.com/atbeta/lector/compare/v0.24.10...v0.25.0

## v0.24.10 (2026-09-16)

### Added

- syntax highlighting for fenced code in focused blocks

### Fixed

- table op icons shrunk by global button padding;

[v0.24.10]: https://github.com/atbeta/lector/compare/v0.24.9...v0.24.10

## v0.24.9 (2026-09-16)

### Added

- table row reorder, unified icon ops, image alt edit and replace

[v0.24.9]: https://github.com/atbeta/lector/compare/v0.24.8...v0.24.9

## v0.24.8 (2026-09-16)

### Added

- mermaid live preview panel, syntax highlighting, insert template

[v0.24.8]: https://github.com/atbeta/lector/compare/v0.24.7...v0.24.8

## v0.24.7 (2026-09-16)

### Fixed

- bind mermaid font to UI sans and stop OpenType feature leak

[v0.24.7]: https://github.com/atbeta/lector/compare/v0.24.6...v0.24.7

## v0.24.6 (2026-09-16)

### Improved

- polish reading surface details

[v0.24.6]: https://github.com/atbeta/lector/compare/v0.24.5...v0.24.6

## v0.24.5 (2026-09-16)

### Fixed

- document icon never shows

[v0.24.5]: https://github.com/atbeta/lector/compare/v0.24.4...v0.24.5

## v0.24.4 (2026-09-16)

### Fixed

- defer window creation out of the single-instance wndproc

[v0.24.4]: https://github.com/atbeta/lector/compare/v0.24.3...v0.24.4

## v0.24.3 (2026-09-16)

### Fixed

- kill the Lector title flash;

[v0.24.3]: https://github.com/atbeta/lector/compare/v0.24.2...v0.24.3

## v0.24.2 (2026-09-16)

### Fixed

- never call Tauri from the window procedure (second-window hang)

[v0.24.2]: https://github.com/atbeta/lector/compare/v0.24.1...v0.24.2

## v0.24.1 (2026-09-16)

### Fixed

- set the window title from the document at creation
- links opened with window.open are swallowed in the shell

[v0.24.1]: https://github.com/atbeta/lector/compare/v0.24.0...v0.24.1

## v0.24.0 (2026-09-16)

### Added

- give .md its own document icon instead of the app icon
- redesign the About pane as a centered card
- a quiet hint where the recent list would be
- highlight code with Prism, with aliases and semiconductor languages
- close file back to the home screen
- image action menu on click
- refine the entry page and titlebar chrome
- editable plain-text fallback for large files

### Fixed

- stop design-audit failing on Windows paths
- suppress the webview context menu on every surface
- scope the context menu to the document surface
- close for real after choosing discard
- keep chrome buttons ink and outline dialog buttons
- actually confirm before closing a dirty window
- show the recent list on ordinary window heights
- keep the empty-state hint on short windows
- image zero-height race and the vanishing Windows title
- platform and path handling audit
- correct local paths for reveal and copy on Windows
- images and saves on Windows
- make Windows 11 Snap Layouts actually fire

### Improved

- make the image settings follow the selected mode
- put settings before the shortcuts button in the titlebar
- hide the status bar when there is no document
- use a document glyph for open, not a folder
- drop the titlebar brand mark
- token the tooltip duration, honor reduced-motion
- make code keywords readable on the ink theme
- consolidate path helpers and drop dead code
- partition layout, fix outline truncation, standard horizontal rule
- give the confirm dialog a real design, and drop one that was not needed

[v0.24.0]: https://github.com/atbeta/lector/compare/v0.23.1...v0.24.0

## v0.23.1 (2026-09-15)

### Fixed

- tauri has no toggle_maximize — dispatch via is_maximized

[v0.23.1]: https://github.com/atbeta/lector/compare/v0.23.0...v0.23.1

## v0.23.0 (2026-09-15)

### Added

- Windows 11 Snap Layouts on the custom maximize button
- quick task toggles, code card header, shortcut popover, file linkage, large-fil…

### Fixed

- second document window froze the app on macOS
- dropping an image onto the window did nothing

[v0.23.0]: https://github.com/atbeta/lector/compare/v0.22.0...v0.23.0

## v0.22.0 (2026-09-15)

### Improved

- drop the brand blue — ink accent by default, theme accents stay

[v0.22.0]: https://github.com/atbeta/lector/compare/v0.21.0...v0.22.0

## v0.21.0 (2026-09-15)

### Added

- real app icon, flicker-free window restore, polished empty state, about section

[v0.21.0]: https://github.com/atbeta/lector/compare/v0.20.0...v0.21.0

## v0.20.0 (2026-09-15)

### Improved

- adopt Lector monogram logo
- refine client window and empty state
- refine reading surfaces and chrome

[v0.20.0]: https://github.com/atbeta/lector/compare/v0.19.1...v0.20.0

## v0.19.1 (2026-09-15)

### Fixed

- empty state fits short windows

[v0.19.1]: https://github.com/atbeta/lector/compare/v0.19.0...v0.19.1

## v0.19.0 (2026-09-15)

### Added

- keyboard shortcuts panel
- large-file mode, copy rules, shortcuts out of tips
- new document from the empty state

### Fixed

- an empty document is a writable document
- empty file stays an editable document
- clamp tips by their own size;

[v0.19.0]: https://github.com/atbeta/lector/compare/v0.18.1...v0.19.0

## v0.18.1 (2026-09-15)

### Added

- shift palette to warm-neutral slate (NoteFast direction);

[v0.18.1]: https://github.com/atbeta/lector/compare/v0.18.0...v0.18.1

## v0.18.0 (2026-09-15)

### Added

- typography-led empty state;

[v0.18.0]: https://github.com/atbeta/lector/compare/v0.17.0...v0.18.0

## v0.17.0 (2026-09-15)

### Added

- polish empty state, add recent-list clear, round window corners on Windows

[v0.17.0]: https://github.com/atbeta/lector/compare/v0.16.0...v0.17.0

## v0.16.0 (2026-09-15)

### Added

- three-mode image insert pipeline (images / assets / command)
- dir template + command split helpers;
- image insert working schema (images/assets/command + command args)
- tidy titlebar and find-bar;

### Fixed

- sidebar aria-label i18n;
- currency-as-math, invisible footnotes, and per-formula render isolation

### Internal

- record the new image-command shell role and updated IPC contract

[v0.16.0]: https://github.com/atbeta/lector/compare/v0.15.0...v0.16.0

## v0.15.0 (2026-09-14)

### Added

- recent files list in the empty state

[v0.15.0]: https://github.com/atbeta/lector/compare/v0.14.0...v0.15.0

## v0.14.0 (2026-09-14)

### Added

- 查找选项与正则、表格数字列右对齐、mermaid 调色板绑 token

[v0.14.0]: https://github.com/atbeta/lector/compare/v0.13.0...v0.14.0

## v0.13.0 (2026-09-14)

### Added

- 外部变更提示改成可操作（补强 #1）

[v0.13.0]: https://github.com/atbeta/lector/compare/v0.12.1...v0.13.0

## v0.12.1 (2026-09-14)

### Fixed

- 大纲三级及以下不再用小字号（各级统一 14px）

[v0.12.1]: https://github.com/atbeta/lector/compare/v0.12.0...v0.12.1

## v0.12.0 (2026-09-14)

### Added

- 设置改两栏 + 搜索、未保存草稿恢复、自定义样式

[v0.12.0]: https://github.com/atbeta/lector/compare/v0.11.2...v0.12.0

## v0.11.2 (2026-09-14)

### Added

- 代码块与表格改版、大纲字号、动效收敛；壳不再恢复最大化

[v0.11.2]: https://github.com/atbeta/lector/compare/v0.11.1...v0.11.2

## v0.11.1 (2026-09-14)

### Fixed

- 补 window-state 的 trait 引入（v0.11.0 构建失败的真因）

[v0.11.1]: https://github.com/atbeta/lector/compare/v0.11.0...v0.11.1

## v0.11.0 (2026-09-14)

### Fixed

- 存不了盘 / 查找不显示第几处且不高亮 / 全屏恢复闪烁 / 缩放没读数

[v0.11.0]: https://github.com/atbeta/lector/compare/v0.10.1...v0.11.0

## v0.10.1 (2026-09-14)

### Fixed

- 补上 window-state 插件的 Cargo.lock（v0.10.0 的 CI 就是栽在这里）

[v0.10.1]: https://github.com/atbeta/lector/compare/v0.10.0...v0.10.1

## v0.10.0 (2026-09-14)

### Added

- 界面缩放、编辑态选区浮条、窗口状态记忆

[v0.10.0]: https://github.com/atbeta/lector/compare/v0.9.0...v0.10.0

## v0.9.0 (2026-09-14)

### Added

- 状态行贴窗口右下角、侧栏不再浮层、顶栏文件名与间距打磨

[v0.9.0]: https://github.com/atbeta/lector/compare/v0.8.1...v0.9.0

## v0.8.1 (2026-09-14)

### Fixed

- mermaid 渲染与 notefast 对齐（正文自然尺寸 + 灯箱内联 SVG）

[v0.8.1]: https://github.com/atbeta/lector/compare/v0.8.0...v0.8.1

## v0.8.0 (2026-09-14)

### Added

- 灯箱缩放平移、细滚动条、去掉大纲节数

[v0.8.0]: https://github.com/atbeta/lector/compare/v0.7.0...v0.8.0

## v0.7.0 (2026-09-14)

### Added

- 侧栏可调宽、树形大纲、图表与右键修复

[v0.7.0]: https://github.com/atbeta/lector/compare/v0.6.0...v0.7.0

## v0.6.0 (2026-09-14)

### Added

- 阅读主题 6 款 + 三档视图模式改名与打磨

### Improved

- Python heredoc open() 显式 encoding='utf-8'
- Tag 版本号检查显式走 Git Bash

[v0.6.0]: https://github.com/atbeta/lector/compare/v0.5.0...v0.6.0

## v0.5.0 (2026-09-14)

### Added

- 三视图模式 read / write / split
- KaTeX 数学公式渲染
- 图片粘贴去重,同会话内同图只占一份磁盘

### Fixed

- 保存错误不再静默吞掉,toast 带 Rust 错误字符串

### Improved

- 抽 loadState.ts,空/加载态从 main.ts 拆出
- 缓存 theme+code → SVG,LRU 上限 200
- 解耦 ci / build-windows,消除 main push 重复跑 Windows 构建

[v0.5.0]: https://github.com/atbeta/lector/compare/v0.4.0...v0.5.0

## v0.4.0 (2026-09-14)

### Added

- 只读模式默认 + 编辑模式切换 + mermaid 放大
- 自绘 Tip 组件,全量替换 11 处 title=

### Fixed

- 打开文件时进入加载态,不再闪「打开文件」按钮
- 滚动条仅在滚动时短暂出现

### Improved

- 删除右侧阅读导航轨

[v0.4.0]: https://github.com/atbeta/lector/compare/v0.3.0...v0.4.0

## v0.3.0 (2026-09-14)

### Added

- Mermaid 图表渲染

### Fixed

- 非 macOS 隐藏菜单栏 + Web 端补快捷键
- 表格打开再关上不应让文件变脏
- 拖选区不会被随后的 click 事件清掉
- notefast 风格滚动条（默认隐形，悬停渐显）

### Improved

- LibreChat 风格阅读导航轨

[v0.3.0]: https://github.com/atbeta/lector/compare/v0.2.0...v0.3.0

## v0.2.0 (2026-09-14)

### Added

- reading rail, table grid editor, wider sidebar, custom scrollbars
- undoable block ops, and pasted HTML becomes Markdown
- context menu, reading position memory, outline ancestry
- formatting shortcuts, code copy, image zoom;
- highlight the current section, and jump to the top
- native menu bar, and render frontmatter as a metadata card
- dock the outline, add a status line, regroup the top bar
- rebuild the UI on the NoteFast/SolBoard design language
- open recent list and save as
- paste and drop images into ./images/ with relative links
- make block editing feel like continuous reading
- dialog plugin and non-blocking menu-driven open
- native menu bar and overlay titlebar;
- SVG icons, redesigned titlebar, custom settings controls
- surface native menu events and harden open
- parse GFM tables and task lists into mdast
- in-document find and replace-all
- outline panel and structural block keymaps
- settings panel and reading customization
- persist settings in app config dir
- reading-first settings schema with strict normalization
- single-process multi-window shell with file protocol
- platform IPC adapter with browser fallback
- block preview with focused-block CodeMirror
- slice markdown into source-position blocks

### Fixed

- one vertical line for the whole shell
- restore the macOS window frame and unify window creation
- rebuild the top bar as three anchored zones
- make the anti-flash script read the settings that exist
- watch the document scroller, not the window
- make the outline read as an overlay, not a docked sidebar
- bring light-theme code comments up to AA
- repair the task list, the flat light theme, and the rhythm
- target the class key Tauri actually registers
- run the Tauri build from the repo root like local dev does
- make the build hooks config-relative so they run anywhere
- gate the macOS-only Opened event so Windows compiles
- restore file IO to the shell and stop silent data loss
- read/write via fs plugin like NoteFast, correct permissions
- use official dialog plugin and surface open errors
- correct frontendDist depth and build script order

### Improved

- make the publish step end in a published release, not a draft
- assert the published release is actually attached to the tag
- tag-driven auto release, with a version gate in front of it
- gate the design tokens in the check job
- build NSIS installer and patch file association icon
- refine reading table, task list, and inline code
- sharpen focused-block and image affordance
- route open/save/watch through platform IO

### Internal

- document what each audit measures and why both exist
- record the verified Windows packaging path and pitfalls
- define shell-web message contract

