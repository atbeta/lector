// 渲染层验证的统一入口：起 vite → 依次跑三个脚本 → 汇总。
//
// 为什么要一个入口：AGENTS 里写的是「先启动 Vite（端口 5199），再运行
// node tools/refactor-verify.mjs」，三步手工动作的结果就是没人跑。一条命令才有人跑。
//
//   node tools/verify-ui.mjs              # 自动起 vite、自动找浏览器
//   node tools/verify-ui.mjs --strict     # 没浏览器 / 跳过 → 失败
//   node tools/verify-ui.mjs --no-serve   # 复用已在跑的 server（不起）
//   LECTOR_VERIFY_PORT=5199 node tools/verify-ui.mjs
//
// 没浏览器时**不算失败**：服务器上本来就没有。会打印 SKIP 并以 0 退出。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveBrowser, printSkip } from './browser.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const noServe = args.includes('--no-serve')
const urlArg = args.find((a) => !a.startsWith('-'))
const PORT = Number(process.env.LECTOR_VERIFY_PORT ?? 5199)
const TARGET = urlArg ?? `http://localhost:${PORT}/`

/** 顺序有意义：ui-verify 最全，挂在最前面，挂了也好先看见。 */
const SCRIPTS = [
  ['ui-verify', 'tools/ui-verify.mjs'],
  ['refactor-verify', 'tools/refactor-verify.mjs'],
  ['block-indicator-verify', 'tools/block-indicator-verify.mjs'],
]

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok || res.status === 404 // 404 也算「server 在」
  } catch {
    return false
  }
}

async function waitUp(url, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await isUp(url)) return true
    await sleep(400)
  }
  return false
}

/** 起 vite（把 server 的启动噪声收进一个前缀，别和验证输出混在一起）。 */
function startServer() {
  const child = spawn('bun', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: `${ROOT}packages/editor`,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // POSIX 上开进程组，收尾能整组杀
  })
  const relay = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (line.trim()) console.log(`  [vite] ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`)
    }
  }
  child.stdout.on('data', relay)
  child.stderr.on('data', relay)
  return child
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    // bun 下面还挂着一层 vite，要连子树一起收
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/** 跑一个验证脚本：输出实时透传，同时判断它是「通过」还是「跳过」。 */
function runScript(name, file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, TARGET], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let skipped = false
    const relay = (buf) => {
      const text = String(buf)
      if (/^SKIP\b/m.test(text)) skipped = true
      process.stdout.write(text)
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    child.on('close', (code) => resolve({ name, code: code ?? 1, skipped }))
  })
}

// ── 主流程 ──

const { exe, why } = resolveBrowser()
if (!exe) {
  printSkip('渲染层验证')
  if (strict) {
    console.log('  （--strict：把跳过当作失败）')
    process.exit(1)
  }
  process.exit(0)
}

let server = null
let results = []
try {
  if (await isUp(TARGET)) {
    console.log(`[verify-ui] 复用已在运行的 ${TARGET}`)
  } else if (noServe) {
    console.error(`[verify-ui] ${TARGET} 没有在跑，而 --no-serve 要求复用。先起 vite：`)
    console.error(`  cd packages/editor && bun run dev -- --port ${PORT}`)
    process.exit(1)
  } else {
    console.log(`[verify-ui] 起 vite（端口 ${PORT}）…`)
    server = startServer()
    if (!(await waitUp(TARGET, 60_000))) {
      console.error(`[verify-ui] vite 在 60s 内没有就绪（${TARGET}）`)
      process.exit(1)
    }
  }

  console.log(`[verify-ui] 浏览器：${exe}（${why}）`)
  for (const [name, file] of SCRIPTS) {
    console.log(`\n──────── ${name} ────────`)
    results.push(await runScript(name, file))
  }
} finally {
  stopServer(server)
}

// ── 汇总 ──

console.log('\n──────── 汇总 ────────')
const failed = results.filter((r) => r.code !== 0)
const skipped = results.filter((r) => r.code === 0 && r.skipped)
for (const r of results) {
  const state = r.code !== 0 ? 'FAIL' : r.skipped ? 'SKIP' : 'PASS'
  console.log(`  ${state}  ${r.name}`)
}
if (failed.length) {
  console.error(`\n${failed.length} 个脚本失败：${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
if (skipped.length) {
  console.log(`\n${skipped.length} 个脚本跳过（没有浏览器）。它们在服务器上是正常情况。`)
  process.exit(strict ? 1 : 0)
}
console.log('\n全部通过。')
