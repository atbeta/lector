// 长文档解析基线。每个测量项单独起一个子进程：同进程顺序跑会被 JIT 冷启动与 GC 互相污染。
//
//   bun tools/perf-bench.ts            生成 perf-fixtures/（已 gitignore）并跑全部测量
//   bun tools/perf-bench.ts --measure  只跑测量（夹具已存在时）
//
// 输出：整篇 fromMarkdown / parseBlocks 耗时（热身一次后取 3 次中位数）、块数、
// 最大块尺寸、内存峰值（maxRSS，heapUsed 前后差是增量不是峰值）。

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'perf-fixtures')

/** 生成器：name → 文本。体积按 UTF-8 字节计。 */
const generators: Record<string, () => string> = {
  'mixed-0.5mb.md': () => repeatUntil(mixedUnit, 0.5 * MB),
  'mixed-1mb.md': () => repeatUntil(mixedUnit, 1 * MB),
  'mixed-3mb.md': () => repeatUntil(mixedUnit, 3 * MB),
  'headings-3mb.md': () => repeatUntil('## 第 N 节 标题 heading\n\n' + '正文 line。\n'.repeat(18) + '\n', 3 * MB),
  'footnotes-tail.md': () => footnotesTail(1 * MB),
  'defs-nested.md': () => defsNested(),
  'hardwrap-1mb.md': () => hardwrap(1 * MB),
  'list-1mb.md': () => listDoc(1 * MB),
  'crlf-3mb.md': () => repeatUntil(mixedUnit, 3 * MB).replace(/\n/g, '\r\n'),
  'bom-3mb.md': () => '\uFEFF' + repeatUntil(mixedUnit, 3 * MB),
}

const MB = 1024 * 1024

const mixedUnit = [
  '## 第 N 节 标题 Section heading\n\n',
  '这是一段中文正文，包含 **加粗**、*斜体*、`code` 和 [链接](https://example.com)。Lorem ipsum dolor sit amet.\n\n',
  '- 列表项一\n- 列表项二 ~~删除~~\n  - 嵌套 [x] 任务\n\n',
  '| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n',
  '```ts\nconst x = 1\nfunction f() { return x }\n```\n\n',
  '> 引用一段文字 quote\n\n',
  '$$\na^2+b^2=c^2\n$$\n\n',
].join('')

function repeatUntil(unit: string, bytes: number): string {
  const parts: string[] = []
  let n = 0
  let i = 0
  while (n < bytes) {
    const u = unit.replaceAll('N', String(i++))
    parts.push(u)
    n += Buffer.byteLength(u)
  }
  return parts.join('')
}

/** 正文里引用 [^n]，定义全部堆在文末。 */
function footnotesTail(bytes: number): string {
  const refs: string[] = []
  const defs: string[] = []
  let n = 0
  let i = 0
  while (n < bytes * 0.8) {
    const line = `见注[^${i}]，这是正文。\n\n`
    refs.push(line)
    defs.push(`[^${i}]: 注 ${i} 的说明文字。\n`)
    n += Buffer.byteLength(line) + Buffer.byteLength(defs.at(-1)!)
    i++
  }
  return refs.join('') + '\n' + defs.join('')
}

/** 定义不在顶层：引用块里、列表项里、跨行标签。 */
function defsNested(): string {
  return [
    '顶层引用 [foo][bar]。\n\n',
    '> [bar]: https://example.com/bar "标题"\n\n',
    '列表里的定义 [baz]。\n\n',
    '- [baz]: https://example.com/baz\n\n',
    '跨行标签 [foo\nbar] 见定义。\n\n',
    '[foo bar]: https://example.com/wrap\n\n',
    '脚注在引用里 x[^a]。\n\n',
    '> [^a]: 引用块中的脚注\n',
  ].join('')
}

/** 硬换行：整篇没有空行。 */
function hardwrap(bytes: number): string {
  const line = '这是一行硬换行的笔记 hard wrap line。\n'
  return line.repeat(Math.ceil(bytes / Buffer.byteLength(line)))
}

/** 整篇一个松散列表。 */
function listDoc(bytes: number): string {
  const item = '- 列表项 item 内容\n\n'
  return item.repeat(Math.ceil(bytes / Buffer.byteLength(item)))
}

function generate(): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, gen] of Object.entries(generators)) {
    const text = gen()
    writeFileSync(join(dir, name), text)
    console.log(`generated ${name}  ${Buffer.byteLength(text)} bytes`)
  }
}

/** 子进程里跑的测量体。 */
const workerFile = join(root, 'packages/core/_bench-worker.ts')
const worker = `
import { readFileSync } from 'node:fs'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parseBlocks } from './src/index.ts'
import { extensions, mdastExtensions } from './src/parse.ts'

const text = readFileSync(process.argv[2], 'utf8')
const which = process.argv[3]

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function time(fn: () => void): number {
  fn() // 热身
  const samples: number[] = []
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  return median(samples)
}

if (which === 'whole') {
  const ms = time(() => fromMarkdown(text, { extensions, mdastExtensions }))
  console.log(JSON.stringify({ ms: Math.round(ms) }))
} else {
  const blocks = parseBlocks(text)
  const ms = time(() => parseBlocks(text))
  let maxBlock = 0
  for (const b of blocks) maxBlock = Math.max(maxBlock, b.raw.length)
  console.log(JSON.stringify({
    ms: Math.round(ms),
    blocks: blocks.length,
    maxBlock,
  }))
}
`

function measure(file: string, which: 'whole' | 'blocks'): { ms: number; blocks?: number; maxBlock?: number; rssMb: number } {
  writeFileSync(workerFile, worker)
  const res = spawnSync('bun', [workerFile, join(dir, file), which], {
    cwd: join(root, 'packages/core'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`${file} ${which} 失败：${res.stderr.slice(-500)}`)
  }
  const line = (res.stdout ?? '').trim().split('\n').at(-1) ?? '{}'
  const rssKb = res.resourceUsage?.maxRSS ?? 0
  // macOS 的 maxRSS 单位是字节，Linux 是 KB
  const rssMb = Math.round((process.platform === 'darwin' ? rssKb / MB : rssKb / 1024) * 10) / 10
  return { ...JSON.parse(line), rssMb }
}

function main(): void {
  if (!process.argv.includes('--measure')) generate()
  console.log('\nfile | fromMarkdown ms | parseBlocks ms | blocks | maxBlock | rss(parse) MB')
  for (const name of Object.keys(generators)) {
    const whole = measure(name, 'whole')
    const blocks = measure(name, 'blocks')
    console.log(
      `${name} | ${whole.ms} | ${blocks.ms} | ${blocks.blocks} | ${blocks.maxBlock} | ${blocks.rssMb}`,
    )
  }
}

main()
