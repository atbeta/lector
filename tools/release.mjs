#!/usr/bin/env node
// 发版：改版本号 → 跑质量门 → 提交 → 打 tag → 推；剩下的交给 CI。
//
// 为什么要有这个脚本：一次发版要动的版本号散在四处
// （`tauri.conf.json`、`clients/tauri/package.json`、`Cargo.toml`、`Cargo.lock`）。
// 漏一处的代价不一样：CI 的版本闸门会当场拦下前三处，而漏了 Cargo.lock 要到
// Windows runner 上 `cargo test --locked` 才炸——三分钟之后，还看不出是人漏了。
// 版本号是发版的唯一真相，那就别交给记忆。
//
//   node tools/release.mjs 0.2.0             # 一条命令发一版
//   node tools/release.mjs 0.2.0 --dry-run   # 只看要改什么，不写盘
//   node tools/release.mjs 0.2.0 --no-push   # 提交并打 tag，但不推（自己看一眼再推）
//
// tag 推上去之后 CI 会重新跑全套检查（含 Windows 上的静默安装与注册表校验），
// 然后把安装器与便携版挂到 Release。macOS 签名不在当前范围。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const argv = process.argv.slice(2)
const version = argv.find((a) => !a.startsWith('-'))
const dryRun = argv.includes('--dry-run')
const noPush = argv.includes('--no-push')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** 跑一条命令，返回 stdout；失败时把 stderr 一起抛出来。 */
function sh(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    throw new Error(`${cmd} ${args.join(' ')} 失败：\n${out}`)
  }
}

/** 单次替换：命中数不是 1 就报错——静默没改是这类脚本最危险的失败方式。 */
function replaceOnce(text, pattern, replacement, what) {
  // 计数要用一份 global 的正则：非 global 的 match 只回第一处，
  // 而且带捕获组时返回的是 [整段, 组1, 组2]，拿 length 当命中数会数错。
  const counting = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')
  const hits = text.match(counting)
  if (!hits || hits.length !== 1) {
    fail(`${what}：期望命中 1 处，实际 ${hits ? hits.length : 0} 处。版本号的写法变了？`)
  }
  return text.replace(pattern, replacement)
}

function plan() {
  // 每个模式都把「当前版本号」捕进一个组：显示时用它，而不是去猜文件里
  // 第一串像版本号的数字（Cargo.lock 里第一个 3 位数字是别人的依赖版本）。
  const files = [
    {
      file: 'clients/tauri/src-tauri/tauri.conf.json',
      pattern: /"version":\s*"([^"]+)"/,
      group: 1,
      replacement: (v) => `"version": "${v}"`,
    },
    {
      file: 'clients/tauri/package.json',
      pattern: /"version":\s*"([^"]+)"/,
      group: 1,
      replacement: (v) => `"version": "${v}"`,
    },
    {
      file: 'clients/tauri/src-tauri/Cargo.toml',
      pattern: /^version = "([^"]+)"/m,
      group: 1,
      replacement: (v) => `version = "${v}"`,
    },
    {
      file: 'clients/tauri/src-tauri/Cargo.lock',
      pattern: /(\[\[package\]\]\nname = "lector"\nversion = ")([^"]+)(")/,
      group: 2,
      // 漏了这里，Windows runner 上 `cargo test --locked` 会拒绝构建
      replacement: (v) => `$1${v}$3`,
    },
  ]
  return files.map((entry) => {
    const abs = path.join(ROOT, entry.file)
    const before = readFileSync(abs, 'utf8')
    const counting = new RegExp(entry.pattern.source, entry.pattern.flags.replace('g', '') + 'g')
    const hits = before.match(counting)
    if (!hits || hits.length !== 1) {
      fail(`${entry.file}：期望命中 1 处，实际 ${hits ? hits.length : 0} 处。版本号的写法变了？`)
    }
    const after = replaceOnce(before, entry.pattern, entry.replacement(version), entry.file)
    return {
      file: entry.file,
      abs,
      after,
      current: entry.pattern.exec(before)[entry.group],
      changed: before !== after,
    }
  })
}

// ── 前置检查 ──

if (!version) fail('用法：node tools/release.mjs <版本号> [--dry-run] [--no-push]')
if (!SEMVER.test(version)) fail(`版本号 ${version} 不是 semver（形如 1.2.3 或 1.2.3-rc.1）`)

const tag = `v${version}`
const edits = plan()

// 新版本号不能比当前的低——发版发反了是最难查的一类事故
const currentVersion = edits[0].current
const [cur] = currentVersion.split('-')
const [next] = version.split('-')
if (cur === next) fail(`当前版本已经是 ${currentVersion}，没有可发的改动`)
const cmp = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}
if (cmp(next, cur) < 0) fail(`新版本 ${version} 比当前 ${currentVersion} 还低`)

if (dryRun) {
  console.log(`将发 ${tag}，改动如下：`)
  for (const e of edits) {
    console.log(`  ${e.changed ? '改' : '不变'} ${e.file}  ${e.current} → ${version}`)
  }
  console.log('\n（--dry-run：没有写盘，也没有跑质量门）')
  process.exit(0)
}

const dirty = sh('git', ['status', '--porcelain'])
if (dirty) fail(`工作区不干净，先提交或收起来：\n${dirty}`)

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') console.warn(`! 当前分支是 ${branch}，不是 main`)

const tags = sh('git', ['tag', '--list', tag])
if (tags) fail(`tag ${tag} 已存在`)
const remoteTag = sh('git', ['ls-remote', '--tags', 'origin', tag])
if (remoteTag) fail(`远端已有 tag ${tag}`)

// ── 写盘 + 质量门 ──

for (const e of edits) {
  if (e.changed) writeFileSync(e.abs, e.after)
  console.log(`  ${e.changed ? '改' : '不变'} ${e.file}`)
}

try {
  console.log('\n质量门（bun test / typecheck / design-audit）…')
  sh('bun', ['test'])
  sh('bun', ['run', 'typecheck'])
  sh('node', ['tools/design-audit.mjs'])
} catch (err) {
  fail(`${err.message}\n\n质量门没过，版本号已经改了，用 git checkout -- . 撤回。`)
}

// ── 提交 + tag + 推 ──

// 从 CHANGELOG.md 抽出本版小节,写进 .github/release-notes/<version>.md。
// CI 的 release job 拿这个文件作为本版发布说明(替代之前那个全版本同款模板)。
// CHANGELOG.md 缺失或没本版小节则不生成文件——CI 退回到通用 notes。
function extractVersionSection(version) {
  const file = path.join(ROOT, 'CHANGELOG.md')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  // 节头格式: `## vX.Y.Z (YYYY-MM-DD)` —— startsWith 容忍日期后缀
  const headerPrefix = `## ${version}`
  const startIdx = lines.findIndex((l) => l.trim().startsWith(headerPrefix))
  if (startIdx < 0) return null
  // 下一个 ## 出现前结束(版本之间不再含 '##')
  let nextIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) {
      nextIdx = i
      break
    }
  }
  const body = lines.slice(startIdx, nextIdx).join('\n').trimEnd()
  // 去掉 compare 链接(发行说明里与 GitHub auto-notes 重复)
  return body.replace(/\n*\[[^\]]+\]: https:\/\/github\.com\/.*\n*$/, '').trimEnd() + '\n'
}

const versionSection = extractVersionSection(version)
const notesPath = path.join(ROOT, '.github', 'release-notes', `${tag}.md`)
const stagedFiles = edits.map((e) => e.file)
if (versionSection) {
  writeFileSync(notesPath, versionSection)
  stagedFiles.push(path.relative(ROOT, notesPath))
  console.log(`  生成 ${path.relative(ROOT, notesPath)}(本版日志,${versionSection.split('\n').length} 行)`)
}

sh('git', ['add', ...stagedFiles])
sh('git', ['commit', '-m', `chore(release): ${tag}`])
sh('git', ['tag', '-a', tag, '-m', `Lector ${tag}`])

if (noPush) {
  console.log(`\n✓ ${tag} 已经在本地：提交与 tag 都做好了，没推。\n  git push origin ${branch} && git push origin ${tag}`)
  process.exit(0)
}

sh('git', ['push', 'origin', branch])
sh('git', ['push', 'origin', tag])

console.log(`\n✓ ${tag} 已推送。CI 正在构建并发布：`)
console.log('  gh run watch $(gh run list --limit 1 --json databaseId --jq ".[0].databaseId")')
console.log(`  gh release view ${tag} --web`)
