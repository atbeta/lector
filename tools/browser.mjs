// 渲染层验证脚本共用的浏览器解析与启动。
//
// 为什么要有这一层：这几个脚本**大部分时候是在没有浏览器的服务器上被跑到的**。
// 直接 `chromium.launch()` 会抛一个栈很深、指向 playwright 内部、看不出该干什么的错
// ——而真实情况只是「这台机器没有浏览器」。那不该算失败，该是一次响亮的跳过。
//
// 解析顺序（先能跑起来的那份）：
//   1. `LECTOR_BROWSER=<exe>` 显式指定；`LECTOR_BROWSER=none` 强制走降级路径（用来验它）
//   2. 系统装的 Edge / Chrome / Chromium
//   3. Playwright 自带的 chromium（`npx playwright install chromium`）
//   4. 都没有 → null，调用方负责降级
// 系统装的排在自带之前，是因为本仓库实测过：某些机器上自带那份起不来（headless shell
// 卡住），而系统装的那份正常。
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

const WINDOWS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const MACOS = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const LINUX = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/brave-browser',
]

/** @returns {{ exe: string | null, why: string, bundled?: boolean }} */
export function resolveBrowser() {
  const explicit = process.env.LECTOR_BROWSER?.trim()
  if (explicit === 'none') return { exe: null, why: 'LECTOR_BROWSER=none（显式要求降级）' }
  if (explicit) {
    if (existsSync(explicit)) return { exe: explicit, why: 'LECTOR_BROWSER' }
    // 指定了却不存在：明说。静默改用别的会让人以为环境变量生效了
    console.warn(`[browser] LECTOR_BROWSER 指向的文件不存在：${explicit}`)
  }

  const candidates = process.platform === 'win32' ? WINDOWS : process.platform === 'darwin' ? MACOS : LINUX
  for (const exe of candidates) {
    if (existsSync(exe)) return { exe, why: '系统安装的浏览器' }
  }

  try {
    const exe = chromium.executablePath()
    if (exe && existsSync(exe)) return { exe, why: 'playwright 自带的 chromium', bundled: true }
  } catch {
    /* playwright 没装浏览器时会抛，落到下面的 null */
  }
  return { exe: null, why: '这台机器上没有找到任何浏览器' }
}

/** 起一个浏览器；没有可用浏览器时返回 null，调用方应降级而不是把脚本判失败。 */
export async function launchBrowser() {
  const { exe, why, bundled } = resolveBrowser()
  if (!exe) return null
  console.log(`[browser] ${exe}（${why}）`)
  // playwright 自带那份直接用默认路径启动；系统浏览器用 executablePath 指过去
  return bundled ? chromium.launch() : chromium.launch({ executablePath: exe })
}

/** 统一口径的跳过说明：告诉人「为什么跳过」以及「想跑起来该做什么」。 */
export function printSkip(what) {
  const { why } = resolveBrowser()
  console.log(`SKIP ${what}：${why}`)
  console.log('  这几个脚本量的是真实渲染，需要浏览器。三选一：')
  console.log('    LECTOR_BROWSER=/path/to/msedge   （或 chrome / chromium）')
  console.log('    npx playwright install chromium')
  console.log('    在装了 Edge / Chrome 的开发机上跑')
}

/**
 * 没有浏览器时的统一退出：默认 0（服务器上这是正常情况，不该弄红流水线），
 * `--strict` 时 1（想让「跳过」变成失败的人显式要）。
 */
export function exitSkipped(what, strict) {
  printSkip(what)
  if (strict) {
    console.log('  （--strict：把跳过当作失败）')
    process.exit(1)
  }
  process.exit(0)
}
