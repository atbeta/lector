# Lector 更新日志

本文件记录面向用户的改动,按版本倒序排列。每版按 Conventional Commits
前缀分类,归入三栏:

- **新增** — 新功能
- **修复** — Bug 修复
- **改进** — 重构、性能、样式、CI 等不引入新功能的改动
- **内部** — 文档/注释/对用户不可见的杂项

不计入日志的提交类型:`chore:`(仓库维护)、`test:`(测试代码)、release 自身。
[全部 compare](https://github.com/atbeta/lector/commits/main)

## v0.29.0 (2026-09-18)

### 新增

- scale the UI with native webview zoom
- widen the default column to 800px and the manual theme to 1000px

### 修复

- keep row labels on one line and tidy the test-command row
- keep the outline sidebar from scrolling away its left padding
- stop advanced settings textareas from overflowing and resizing
- keep a poisoned lock from taking the whole shell down

### 改进

- make global shortcut dispatch a pure decision table
- split io.rs into domain modules
- finish splitting platform.ts into domain modules
- start splitting platform.ts - extract the shared core

### 内部

- add v1 acceptance record for perf and IME
- align the project package with what shipped
- point stale io.rs references at io/window.rs
- bring the shell contract back in line with the code

[v0.29.0]: https://github.com/atbeta/lector/compare/v0.28.1...v0.29.0

## v0.28.1 (2026-09-18)

### 修复

- stop the resize grip from drawing a second line on hover
- make the rot check survive a shallow clone

[v0.28.1]: https://github.com/atbeta/lector/compare/v0.28.0...v0.28.1

## v0.28.0 (2026-09-18)

### 新增

- re-implement the reading-polish line on our branch
- show the window only after the page has painted

### 修复

- restore two user-visible strings damaged by encoding rot
- five visual problems from the polish pass
- drop the stray pnpm lockfile, keep bun as the only package manager

### 改进

- make the right-click decision table pure and tested
- split app.css into five ordered partials

[v0.28.0]: https://github.com/atbeta/lector/compare/v0.27.5...v0.28.0

## v0.27.5 (2026-09-17)

### 新增

- open dropped md/txt via native drag-drop channel;

[v0.27.5]: https://github.com/atbeta/lector/compare/v0.27.4...v0.27.5

## v0.27.4 (2026-09-17)

### 修复

- drop stale micromark-extension-gfm imports;

[v0.27.4]: https://github.com/atbeta/lector/compare/v0.27.3...v0.27.4

## v0.27.3 (2026-09-17)

### 新增

- refactor codePreview.ts for mermaid rendering & resize observer
- enhance Gantt chart task bar width handling in mermaid rendering
- add new icon and update footnote backref display
- enhance footnote rendering and scrolling logic
- update micromark extensions to latest versions

### 修复

- gantt canvas floor 1000px with min-width lock;

[v0.27.3]: https://github.com/atbeta/lector/compare/v0.27.2...v0.27.3

## v0.27.2 (2026-09-17)

### 修复

- add missing gfm-footnote tokenizer;

[v0.27.2]: https://github.com/atbeta/lector/compare/v0.27.1...v0.27.2

## v0.27.1 (2026-09-17)

### 修复

- allow anchor clicks in shouldOpenHref;

[v0.27.1]: https://github.com/atbeta/lector/compare/v0.27.0...v0.27.1

## v0.27.0 (2026-09-17)

### 新增

- tint diagrams with dedicated indigo accent;
- in-document anchor links jump to headings (GitHub slug compat)
- per-codeblock wrap toggle button next to copy (pref persists)
- footnote rendering, ==mark== highlight, details/kbd HTML whitelist

### 修复

- suppress console flash when opening external links on Windows
- center diagrams;

[v0.27.0]: https://github.com/atbeta/lector/compare/v0.26.10...v0.27.0

## v0.26.10 (2026-09-17)

### 修复

- drop redundant tooltip on recent-file list items
- overlay covers entire export;

[v0.26.10]: https://github.com/atbeta/lector/compare/v0.26.9...v0.26.10

## v0.26.9 (2026-09-17)

### 修复

- spinner covers theme flip and mermaid wait;
- keep copy button right-aligned on code blocks without a language label

[v0.26.9]: https://github.com/atbeta/lector/compare/v0.26.8...v0.26.9

## v0.26.8 (2026-09-17)

### 修复

- all visual changes after save dialog;

[v0.26.8]: https://github.com/atbeta/lector/compare/v0.26.7...v0.26.8

## v0.26.7 (2026-09-17)

### 新增

- add exporting PDF feedback and update exportPdf function

### 修复

- theme flip via setThemeMode so mermaid re-renders light;

[v0.26.7]: https://github.com/atbeta/lector/compare/v0.26.6...v0.26.7

## v0.26.6 (2026-09-17)

### 修复

- overlay must not be captured;

[v0.26.6]: https://github.com/atbeta/lector/compare/v0.26.5...v0.26.6

## v0.26.5 (2026-09-17)

### 修复

- drop offscreen print window;

[v0.26.5]: https://github.com/atbeta/lector/compare/v0.26.4...v0.26.5

## v0.26.4 (2026-09-17)

### 修复

- runtime window placement, step-title diagnostics, error bridge, print-* capabil…

[v0.26.4]: https://github.com/atbeta/lector/compare/v0.26.3...v0.26.4

## v0.26.3 (2026-09-17)

### 新增

- export via offscreen print window;

[v0.26.3]: https://github.com/atbeta/lector/compare/v0.26.2...v0.26.3

## v0.26.2 (2026-09-17)

### 新增

- enhance print and PDF export styles for better rendering

### 修复

- print styles as .printing class with !

[v0.26.2]: https://github.com/atbeta/lector/compare/v0.26.1...v0.26.2

## v0.26.1 (2026-09-17)

### 修复

- re-raise snap overlay after WebView2 settles its z-order

[v0.26.1]: https://github.com/atbeta/lector/compare/v0.26.0...v0.26.1

## v0.26.0 (2026-09-17)

### 新增

- enhance file handling with closeWindow and reload confirmations
- enhance window scaling and update export button icon

[v0.26.0]: https://github.com/atbeta/lector/compare/v0.25.7...v0.26.0

## v0.25.7 (2026-09-17)

### 修复

- render() must not wipe empty state when no document is open
- compile pdf export against real webview2-com API;
- register pdf export deps in Cargo.lock

[v0.25.7]: https://github.com/atbeta/lector/compare/v0.25.6...v0.25.7

## v0.25.6 (2026-09-17)

### 新增

- PDF export via WebView2 PrintToPdf with shared print CSS

### 修复

- single-path window restore, shell-injected early theme, palette appearance icon

[v0.25.6]: https://github.com/atbeta/lector/compare/v0.25.5...v0.25.6

## v0.25.5 (2026-09-17)

### 修复

- empty paragraph keeps a clickable surface;

[v0.25.5]: https://github.com/atbeta/lector/compare/v0.25.4...v0.25.5

## v0.25.4 (2026-09-17)

### 新增

- code line numbers with settings toggle;
- add code line numbers setting and display in editor

### 修复

- drop chcp 65001 from assoc cmds;
- image context menu gains delete and insert-paragraph actions

### 改进

- encode portable cmds as GBK and assert it in smoke test

[v0.25.4]: https://github.com/atbeta/lector/compare/v0.25.3...v0.25.4

## v0.25.3 (2026-09-17)

### 改进

- dedicated 6px media radius for images, tables, code blocks
- instant modal backdrop, snappier card entrance

[v0.25.3]: https://github.com/atbeta/lector/compare/v0.25.2...v0.25.3

## v0.25.2 (2026-09-17)

### 新增

- portable zip ships md icon and file-assoc cmd scripts

### 修复

- carve GFM-absorbed paragraph lines out of table blocks

### 改进

- assemble portable zip with icon and assoc scripts
- instant nav/find jumps;

[v0.25.2]: https://github.com/atbeta/lector/compare/v0.25.1...v0.25.2

## v0.25.1 (2026-09-17)

### 修复

- make the link path tests platform-neutral

[v0.25.1]: https://github.com/atbeta/lector/compare/v0.25.0...v0.25.1

## v0.25.0 (2026-09-17)

### 新增

- let users configure mermaid themselves
- follow local links from a document
- show block boundaries and put the block menu on a handle

### 修复

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

### 改进

- split main.ts into focused controller modules

[v0.25.0]: https://github.com/atbeta/lector/compare/v0.24.10...v0.25.0

## v0.24.10 (2026-09-16)

### 新增

- syntax highlighting for fenced code in focused blocks

### 修复

- table op icons shrunk by global button padding;

[v0.24.10]: https://github.com/atbeta/lector/compare/v0.24.9...v0.24.10

## v0.24.9 (2026-09-16)

### 新增

- table row reorder, unified icon ops, image alt edit and replace

[v0.24.9]: https://github.com/atbeta/lector/compare/v0.24.8...v0.24.9

## v0.24.8 (2026-09-16)

### 新增

- mermaid live preview panel, syntax highlighting, insert template

[v0.24.8]: https://github.com/atbeta/lector/compare/v0.24.7...v0.24.8

## v0.24.7 (2026-09-16)

### 修复

- bind mermaid font to UI sans and stop OpenType feature leak

[v0.24.7]: https://github.com/atbeta/lector/compare/v0.24.6...v0.24.7

## v0.24.6 (2026-09-16)

### 改进

- polish reading surface details

[v0.24.6]: https://github.com/atbeta/lector/compare/v0.24.5...v0.24.6

## v0.24.5 (2026-09-16)

### 修复

- document icon never shows

[v0.24.5]: https://github.com/atbeta/lector/compare/v0.24.4...v0.24.5

## v0.24.4 (2026-09-16)

### 修复

- defer window creation out of the single-instance wndproc

[v0.24.4]: https://github.com/atbeta/lector/compare/v0.24.3...v0.24.4

## v0.24.3 (2026-09-16)

### 修复

- kill the Lector title flash;

[v0.24.3]: https://github.com/atbeta/lector/compare/v0.24.2...v0.24.3

## v0.24.2 (2026-09-16)

### 修复

- never call Tauri from the window procedure (second-window hang)

[v0.24.2]: https://github.com/atbeta/lector/compare/v0.24.1...v0.24.2

## v0.24.1 (2026-09-16)

### 修复

- set the window title from the document at creation
- links opened with window.open are swallowed in the shell

[v0.24.1]: https://github.com/atbeta/lector/compare/v0.24.0...v0.24.1

## v0.24.0 (2026-09-16)

### 新增

- give .md its own document icon instead of the app icon
- redesign the About pane as a centered card
- a quiet hint where the recent list would be
- highlight code with Prism, with aliases and semiconductor languages
- close file back to the home screen
- image action menu on click
- refine the entry page and titlebar chrome
- editable plain-text fallback for large files

### 修复

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

### 改进

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

### 修复

- tauri has no toggle_maximize — dispatch via is_maximized

[v0.23.1]: https://github.com/atbeta/lector/compare/v0.23.0...v0.23.1

## v0.23.0 (2026-09-15)

### 新增

- Windows 11 Snap Layouts on the custom maximize button
- quick task toggles, code card header, shortcut popover, file linkage, large-fil…

### 修复

- second document window froze the app on macOS
- dropping an image onto the window did nothing

[v0.23.0]: https://github.com/atbeta/lector/compare/v0.22.0...v0.23.0

## v0.22.0 (2026-09-15)

### 改进

- drop the brand blue — ink accent by default, theme accents stay

[v0.22.0]: https://github.com/atbeta/lector/compare/v0.21.0...v0.22.0

## v0.21.0 (2026-09-15)

### 新增

- real app icon, flicker-free window restore, polished empty state, about section

[v0.21.0]: https://github.com/atbeta/lector/compare/v0.20.0...v0.21.0

## v0.20.0 (2026-09-15)

### 改进

- adopt Lector monogram logo
- refine client window and empty state
- refine reading surfaces and chrome

[v0.20.0]: https://github.com/atbeta/lector/compare/v0.19.1...v0.20.0

## v0.19.1 (2026-09-15)

### 修复

- empty state fits short windows

[v0.19.1]: https://github.com/atbeta/lector/compare/v0.19.0...v0.19.1

## v0.19.0 (2026-09-15)

### 新增

- keyboard shortcuts panel
- large-file mode, copy rules, shortcuts out of tips
- new document from the empty state

### 修复

- an empty document is a writable document
- empty file stays an editable document
- clamp tips by their own size;

[v0.19.0]: https://github.com/atbeta/lector/compare/v0.18.1...v0.19.0

## v0.18.1 (2026-09-15)

### 新增

- shift palette to warm-neutral slate (NoteFast direction);

[v0.18.1]: https://github.com/atbeta/lector/compare/v0.18.0...v0.18.1

## v0.18.0 (2026-09-15)

### 新增

- typography-led empty state;

[v0.18.0]: https://github.com/atbeta/lector/compare/v0.17.0...v0.18.0

## v0.17.0 (2026-09-15)

### 新增

- polish empty state, add recent-list clear, round window corners on Windows

[v0.17.0]: https://github.com/atbeta/lector/compare/v0.16.0...v0.17.0

## v0.16.0 (2026-09-15)

### 新增

- three-mode image insert pipeline (images / assets / command)
- dir template + command split helpers;
- image insert working schema (images/assets/command + command args)
- tidy titlebar and find-bar;

### 修复

- sidebar aria-label i18n;
- currency-as-math, invisible footnotes, and per-formula render isolation

### 内部

- record the new image-command shell role and updated IPC contract

[v0.16.0]: https://github.com/atbeta/lector/compare/v0.15.0...v0.16.0

## v0.15.0 (2026-09-14)

### 新增

- recent files list in the empty state

[v0.15.0]: https://github.com/atbeta/lector/compare/v0.14.0...v0.15.0

## v0.14.0 (2026-09-14)

### 新增

- 查找选项与正则、表格数字列右对齐、mermaid 调色板绑 token

[v0.14.0]: https://github.com/atbeta/lector/compare/v0.13.0...v0.14.0

## v0.13.0 (2026-09-14)

### 新增

- 外部变更提示改成可操作（补强 #1）

[v0.13.0]: https://github.com/atbeta/lector/compare/v0.12.1...v0.13.0

## v0.12.1 (2026-09-14)

### 修复

- 大纲三级及以下不再用小字号（各级统一 14px）

[v0.12.1]: https://github.com/atbeta/lector/compare/v0.12.0...v0.12.1

## v0.12.0 (2026-09-14)

### 新增

- 设置改两栏 + 搜索、未保存草稿恢复、自定义样式

[v0.12.0]: https://github.com/atbeta/lector/compare/v0.11.2...v0.12.0

## v0.11.2 (2026-09-14)

### 新增

- 代码块与表格改版、大纲字号、动效收敛；壳不再恢复最大化

[v0.11.2]: https://github.com/atbeta/lector/compare/v0.11.1...v0.11.2

## v0.11.1 (2026-09-14)

### 修复

- 补 window-state 的 trait 引入（v0.11.0 构建失败的真因）

[v0.11.1]: https://github.com/atbeta/lector/compare/v0.11.0...v0.11.1

## v0.11.0 (2026-09-14)

### 修复

- 存不了盘 / 查找不显示第几处且不高亮 / 全屏恢复闪烁 / 缩放没读数

[v0.11.0]: https://github.com/atbeta/lector/compare/v0.10.1...v0.11.0

## v0.10.1 (2026-09-14)

### 修复

- 补上 window-state 插件的 Cargo.lock（v0.10.0 的 CI 就是栽在这里）

[v0.10.1]: https://github.com/atbeta/lector/compare/v0.10.0...v0.10.1

## v0.10.0 (2026-09-14)

### 新增

- 界面缩放、编辑态选区浮条、窗口状态记忆

[v0.10.0]: https://github.com/atbeta/lector/compare/v0.9.0...v0.10.0

## v0.9.0 (2026-09-14)

### 新增

- 状态行贴窗口右下角、侧栏不再浮层、顶栏文件名与间距打磨

[v0.9.0]: https://github.com/atbeta/lector/compare/v0.8.1...v0.9.0

## v0.8.1 (2026-09-14)

### 修复

- mermaid 渲染与 notefast 对齐（正文自然尺寸 + 灯箱内联 SVG）

[v0.8.1]: https://github.com/atbeta/lector/compare/v0.8.0...v0.8.1

## v0.8.0 (2026-09-14)

### 新增

- 灯箱缩放平移、细滚动条、去掉大纲节数

[v0.8.0]: https://github.com/atbeta/lector/compare/v0.7.0...v0.8.0

## v0.7.0 (2026-09-14)

### 新增

- 侧栏可调宽、树形大纲、图表与右键修复

[v0.7.0]: https://github.com/atbeta/lector/compare/v0.6.0...v0.7.0

## v0.6.0 (2026-09-14)

### 新增

- 阅读主题 6 款 + 三档视图模式改名与打磨

### 改进

- Python heredoc open() 显式 encoding='utf-8'
- Tag 版本号检查显式走 Git Bash

[v0.6.0]: https://github.com/atbeta/lector/compare/v0.5.0...v0.6.0

## v0.5.0 (2026-09-14)

### 新增

- 三视图模式 read / write / split
- KaTeX 数学公式渲染
- 图片粘贴去重,同会话内同图只占一份磁盘

### 修复

- 保存错误不再静默吞掉,toast 带 Rust 错误字符串

### 改进

- 抽 loadState.ts,空/加载态从 main.ts 拆出
- 缓存 theme+code → SVG,LRU 上限 200
- 解耦 ci / build-windows,消除 main push 重复跑 Windows 构建

[v0.5.0]: https://github.com/atbeta/lector/compare/v0.4.0...v0.5.0

## v0.4.0 (2026-09-14)

### 新增

- 只读模式默认 + 编辑模式切换 + mermaid 放大
- 自绘 Tip 组件,全量替换 11 处 title=

### 修复

- 打开文件时进入加载态,不再闪「打开文件」按钮
- 滚动条仅在滚动时短暂出现

### 改进

- 删除右侧阅读导航轨

[v0.4.0]: https://github.com/atbeta/lector/compare/v0.3.0...v0.4.0

## v0.3.0 (2026-09-14)

### 新增

- Mermaid 图表渲染

### 修复

- 非 macOS 隐藏菜单栏 + Web 端补快捷键
- 表格打开再关上不应让文件变脏
- 拖选区不会被随后的 click 事件清掉
- notefast 风格滚动条（默认隐形，悬停渐显）

### 改进

- LibreChat 风格阅读导航轨

[v0.3.0]: https://github.com/atbeta/lector/compare/v0.2.0...v0.3.0

## v0.2.0 (2026-09-14)

### 新增

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

### 修复

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

### 改进

- make the publish step end in a published release, not a draft
- assert the published release is actually attached to the tag
- tag-driven auto release, with a version gate in front of it
- gate the design tokens in the check job
- build NSIS installer and patch file association icon
- refine reading table, task list, and inline code
- sharpen focused-block and image affordance
- route open/save/watch through platform IO

### 内部

- document what each audit measures and why both exist
- record the verified Windows packaging path and pitfalls
- define shell-web message contract

