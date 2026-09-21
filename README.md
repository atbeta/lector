# Lector

A reading-first Markdown editor for Windows and macOS. The disk file is
the single source of truth: open it, read it, edit it in place, save
back to the same path with byte-level fidelity.

Lector does not store, index, or shadow the document anywhere else.
No library, no workspace, no account, no sync.

[Releases](https://github.com/atbeta/lector/releases) ·
[Changelog](CHANGELOG.md) ·
[Contributing](AGENTS.md)

## Features

- **Source-position IR.** The parsed Markdown is sliced against the
  source file at block boundaries; previews stay in sync with the
  file even before any save, and untouched blocks are written back
  byte-identical.
- **Three view modes.** Read (rendered), write (raw source per
  block), and split (rendered, with click-to-edit). Toggle via
  `Ctrl+1` / `Ctrl+2` / `Ctrl+3`, or the title-bar button.
- **Outline and reading position.** A heading-sourced outline panel;
  reopen a file and the view snaps back to where you left off.
- **Inline Mermaid and KaTeX.** Diagrams and math render with
  theme-aware colors. Click to zoom; Esc / backdrop / close to
  dismiss.
- **Bare CodeMirror 6 for the focused block.** Only the block being
  edited mounts an editor; the rest of the document stays as a
  rendered preview, so the editor never rewrites content you did not
  touch.
- **Atomic write with conflict detection.** Save writes to a temp
  file in the same directory and renames into place. If the file
  changed on disk since you opened it, you are asked before
  overwriting.
- **Paste, drag-drop, or insert images.** Relative paths live next
  to the document; an optional command-based uploader can return a
  remote URL but always keeps a local copy as fallback.
- **Themes, fonts, and bilingual UI.** Light / dark / follow system;
  multiple palettes; per-document font, size, line-height, and
  column-width controls. Simplified Chinese and English.

## Platform support

| OS      | Status                                                          |
| ------- | --------------------------------------------------------------- |
| Windows | Released (NSIS installer + portable archive, x86_64)            |
| macOS   | Released (signed & notarized DMG + ZIP, Apple Silicon)          |

Linux is not in scope.

## Install

Download the latest release from
[GitHub Releases](https://github.com/atbeta/lector/releases). Each
release provides:

- **Windows** — `Lector_<version>_x64-setup.exe` (NSIS installer, no
  admin required, registers `.md` / `.markdown` / `.txt` associations
  and an icon) and `lector-portable.zip` (portable archive; opt in to
  file associations via `register-file-assoc.cmd`).
- **macOS** — `Lector_<version>_arm64-apple-darwin.dmg` (signed and
  notarized disk image; drag `Lector.app` to Applications) and the
  matching `.zip`.
- **Checksums** — `SHA256SUMS.txt`. Verify with
  `certutil -hashfile <file> SHA256` on Windows or
  `shasum -a 256 <file>` on macOS.

## Develop

Requirements: [Bun](https://bun.sh) ≥ 1.4, [Rust](https://rustup.rs)
stable with the `x86_64-pc-windows-msvc` target on Windows, and the
Tauri 2 prerequisites for your platform.

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

The shell's Rust unit tests run on the Windows CI runner
(`cargo test --locked`); run them locally on macOS or Linux with the
matching target installed.

For architecture, locked decisions, and contribution conventions, see
[AGENTS.md](AGENTS.md).

## Release

```bash
node tools/release.mjs <version>
```

Bumps the four version sites, runs the local quality gates, generates
a per-version notes file from `CHANGELOG.md`, commits, tags, and
pushes. CI on the Windows runner verifies the tag, rebuilds, runs the
silent install / uninstall / registry assertion, and publishes the
assets. The per-version release notes are kept under
[`.github/release-notes/`](.github/release-notes/); see
[CHANGELOG.md](CHANGELOG.md) for the full history.

## License

[MIT](LICENSE)
