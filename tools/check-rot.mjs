// 挡住**新引入**的替换字符（U+FFFD）。
//
// 为什么要挡在门口：仓库里那 455 处注释腐化不是一次事故——查过提交历史，
// 它是**一次次编辑攒出来的**，某些提交新增的行里就已经带着替换字符。只清存量、
// 不管入口，过几天又是一片。所以这条规则盯的是 diff：
//
//   node tools/check-rot.mjs                 # 查暂存区（pre-commit 用）
//   node tools/check-rot.mjs --range a..b    # 查某个提交区间（CI 用）
//
// 存量注释是另一笔账（可以慢慢清，也可以不清），不该用它把这条守卫弄红——
// 所以永远只看「新增的行」。整棵树的代码与字符串另有 bun test 的 text-integrity
// 守着（那一条存量已经清零了）。
//
// 为什么用这个字符做判据而不是「非 ASCII 是否正常」：U+FFFD 是解码失败的**明确信号**，
// 出现即意味着上游某处用了非 UTF-8 感知的读写。文案里的生僻字、emoji、方框符号
// 都不会误报。
//
// 例外：**讨论这个字符本身的行**（比如 text-integrity.test.ts 里那句说明、
// 本文件）允许出现它。
import { execFileSync } from 'node:child_process'

const REPLACEMENT = '\uFFFD'
const argv = process.argv.slice(2)
const rangeIdx = argv.indexOf('--range')
let range = rangeIdx >= 0 ? argv[rangeIdx + 1] : null

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

/** 区间为空/无效（例如首个提交、或 CI 上拿不到 before）时退化成「最后一个提交」。 */
function normalizeRange(r) {
  if (!r) return null
  const [a, b] = r.split('..')
  if (!a || !b || /^0+$/.test(a) || /^0+$/.test(b)) return null
  try {
    git(['rev-parse', '--verify', '--quiet', a])
    git(['rev-parse', '--verify', '--quiet', b])
    return r
  } catch {
    return null
  }
}

function diffArgs() {
  if (range === null) return ['diff', '--cached', '--unified=0', '--no-color']
  const r = normalizeRange(range) ?? 'HEAD~1..HEAD'
  console.log(`[check-rot] 检查区间 ${r}`)
  return ['diff', '--unified=0', '--no-color', r]
}

/** 只看新增行，并带上它们在**新文件**里的行号（读 `@@ -a,b +c,d @@` 头推进）。 */
function addedLines(diff) {
  const out = []
  let file = null
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    const fileHeader = raw.match(/^\+\+\+ b\/(.+)$/)
    if (fileHeader) {
      file = fileHeader[1]
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ file, line: lineNo, text: raw.slice(1) })
      lineNo++
    } else if (raw.startsWith(' ')) {
      lineNo++
    }
  }
  return out.filter((l) => l.file && l.file !== '/dev/null')
}

const diff = git(diffArgs())
const bad = addedLines(diff).filter(
  (l) => l.text.includes(REPLACEMENT) && !l.text.includes('U+FFFD'), // 讨论它本身的行放行
)

if (bad.length === 0) {
  console.log('[check-rot] OK：新增行里没有替换字符')
  process.exit(0)
}

console.error(`[check-rot] 新增了 ${bad.length} 行带替换字符（U+FFFD）的文本：`)
for (const b of bad.slice(0, 20)) {
  console.error(`  ${b.file}:${b.line}  ${b.text.trim().slice(0, 90)}`)
}
if (bad.length > 20) console.error(`  …还有 ${bad.length - 20} 行`)
console.error('')
console.error('替换字符意味着写入时用了非 UTF-8 感知的读写——不要手改这行，先查写入路径：')
console.error('  1) 是不是某个编辑器/工具把文件按别的方式解码后写回了')
console.error('  2) 用 `git diff` 看原文，按上下文补回丢掉的字')
process.exit(1)
