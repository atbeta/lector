# Lector

A reading-first Markdown editor for Windows and macOS. Open a `.md` file,
read it in a comfortable rendering, edit it in place, save back to the
original path with byte-level fidelity.

The disk file is the single source of truth. No library, no workspace,
no account, no sync. The application does not own the document — the file
owns itself.

[Releases](https://github.com/atbeta/lector/releases) ·
[Changelog](CHANGELOG.md) ·
[Contributing](AGENTS.md)

## Features

**Reading**
- Single-document window with a centered reading column
- Source-position IR over the parsed Markdown, so previews stay in sync
  with the file even before any save
- Outline panel sourced from the document headings; click to jump
- Reading-position memory — reopen a file and the view snaps back where
  you left off
- Mermaid diagrams and KaTeX math render inline, theme-aware
- Image lightbox (also for Mermaid), Esc / backdrop / close button all
  dismiss
- Three view modes: **read** (rendered), **write** (raw source per block),
  **split** (rendered + click-to-edit). Default is read.

**Editing**
- Focused block uses a bare CodeMirror 6 instance for that block's source
  only; everything else stays as a rendered preview, so the editor never
  rewrites content the user did not touch
- Reading rail, table-grid editor, customizable keyboard shortcuts
- Atomic write with conflict detection if the file changed on disk
- Image insertion via paste, drag-drop, or insert menu. Relative paths
  kept next to the document; optional command-based uploader writes the
  returned URL but always keeps a local copy as fallback
- Theme: light / dark / follow system; multiple palettes; per-document
  font / size / line-height / column-width controls
- Bilingual UI (Simplified Chinese, English)

**File handling**
- Single source of truth: the file on disk. Save writes back the same
  path. Untouched blocks are returned byte-identical
- CRLF / LF / mixed line endings preserved; UTF-8 BOM preserved on read
  and restored on write
- External file changes watched and surfaced for reload
- `.md` / `.markdown` / `.txt` file associations registered on Windows
  install

## Platform support

| OS      | Status                                                          |
| ------- | --------------------------------------------------------------- |
| Windows | Released (NSIS installer + portable archive, x86_64)            |
| macOS   | Released (signed & notarized DMG + ZIP, Apple Silicon)          |

Linux is not in scope.

## Install

Download the latest release from
[GitHub Releases](https://github.com/atbeta/lector/releases). Each release
provides:

- `Lector_<version>_x64-setup.exe` — NSIS installer, no admin required,
  registers `.md` / `.markdown` / `.txt` associations and an icon
- `lector-portable.zip` — portable archive, includes `.md` icon and
  `register-file-assoc.cmd` / `unregister-file-assoc.cmd` to opt in to
  file associations
- `Lector_<version>_arm64-apple-darwin.dmg` — signed & notarized disk image
  (Apple Silicon). Drag `Lector.app` onto Applications
- `Lector_<version>_arm64-apple-darwin.zip` — the same notarized `.app`
- `SHA256SUMS.txt` — checksums

Verify with `certutil -hashfile <file> SHA256` on Windows, or
`shasum -a 256 <file>` on macOS.

## Use

| Action            | Shortcut                |
| ----------------- | ----------------------- |
| Open              | `Ctrl+O`                |
| Save              | `Ctrl+S`                |
| Find / Replace    | `Ctrl+F`                |
| Toggle view mode  | `Ctrl+E`                |
| Read / Write / Split | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Outline panel     | `Ctrl+Shift+O`          |
| Settings          | `Ctrl+,`                |

Shortcuts are customizable in **Settings → Shortcuts**.

## Architecture

The application is split into four layers:

- `packages/core` — pure-Markdown core. Source document, IR over the
  parsed tree, block slicing, byte-level serialize. No DOM, no IO, no
  shell dependency. Test-first; golden tests cover that the slice
  tiles the source without gaps and that an untouched save is
  byte-identical to the original.
- `packages/editor` — IR view + the focused-block bare CodeMirror 6.
  Also runs standalone under Vite for browser-side preview work.
- `packages/shell-web` — IPC adapter. All `invoke` calls are funneled
  through one module; the rest of the Web layer cannot read arbitrary
  paths.
- `clients/tauri` — Tauri 2 thin shell (macOS + Windows). Owns the
  file dialog, file association, window management, drag-and-drop,
  atomic write, external change listener, and the optional image-upload
  command runner.

The deliberate constraints:

- The file is the source of truth. The application does not store,
  index, or shadow it anywhere else.
- No document library, no folder tree, no tabs, no sync, no account,
  no cross-file search.
- File IO is shell-mediated; the Web layer cannot read arbitrary paths.

For the full architecture rationale and per-decision records, see
[AGENTS.md](AGENTS.md). For the originating brief and product research,
see [`.ai/`](.ai/).

## Develop

Requirements: [Bun](https://bun.sh) ≥ 1.4, [Rust](https://rustup.rs) stable
with the `x86_64-pc-windows-msvc` target on Windows, the Tauri 2
prerequisites for your platform.

```bash
git clone https://github.com/atbeta/lector
cd lector
bun install
bun run tauri:dev    # development run with hot reload
```

Quality gates (run before pushing):

```bash
bun test              # unit + golden tests in core and editor
bun run typecheck     # tsc --noEmit across all workspaces
node tools/design-audit.mjs   # design-token static audit
```

The shell's Rust unit tests run on the Windows CI runner (`cargo test
--locked`); run them locally on macOS or Linux with the matching target
installed.

For AI agents or contributors working on this repo, read [AGENTS.md](AGENTS.md)
first — it lists the locked decisions (Tauri 2 dual-target, source-slicing
IR, no tabs, no document library) and the conventions that come with them.

## Release

Releases are cut from `main`. One entry point:

```bash
node tools/release.mjs <version>
```

It bumps the four version sites (`tauri.conf.json`,
`clients/tauri/package.json`, `Cargo.toml`, `Cargo.lock`), runs the local
quality gates, generates a per-version notes file from `CHANGELOG.md`,
commits, tags, and pushes. CI on the Windows runner verifies the tag,
rebuilds, runs the silent install / uninstall / registry assertion, and
publishes the assets.

`v*` tags ship as full releases. Branches only produce artifacts. The
per-version release notes are kept under [`.github/release-notes/`](.github/release-notes/);
see [CHANGELOG.md](CHANGELOG.md) for the full history.

## License

[MIT](LICENSE)
