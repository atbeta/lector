// 状态行上的三个可点能力（都是用户拍过的设计）：
//   ① 档位标签只在非阅读档出现，点它回到阅读档；
//   ② 保存状态在**有未保存改动时**才可点（干净时退化成纯读数，不给假按钮）；
//   ③ 左组缩放读数跟随缩放变化，点击复位 100%。
// 判定看行为，不看类名以外的实现细节：读 html[data-mode] 与状态行文本。
import { chromium } from 'playwright'

const urls = process.argv.slice(2)
const URL = (urls[0] ?? 'http://localhost:5199/').replace(/\/$/, '') + '/'
let errors = 0
const fail = (msg) => { errors++; console.log(`ERROR ${msg}`) }
const info = (msg) => console.log(`INFO  ${msg}`)

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 820 }, locale: 'zh-CN' })

const read = () =>
  p.evaluate(() => ({
    mode: document.documentElement.dataset.mode ?? '',
    left: (document.getElementById('status-left')?.textContent ?? '').trim(),
    rightAction: document.querySelectorAll('#status-right .status-item-action').length,
    leftAction: document.querySelectorAll('#status-left .status-item-action').length,
  }))

try {
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForTimeout(1500)

  const init = await read()
  if (init.leftAction !== 1) fail(`阅读档左组应有 1 个可点读数，实为 ${init.leftAction}`)
  if (!/^\d+%$/.test(init.left)) fail(`左组读数不是百分比："${init.left}"`)
  if (init.rightAction !== 0) fail(`干净文档的右组不该有可点项，实为 ${init.rightAction}`)
  info(`初始：左组读数 ${init.left}、右组可点项 ${init.rightAction}`)

  // ③ 缩放读数跟随 + 点击复位
  await p.evaluate(() => {
    const k = 'lector-settings'
    const s = JSON.parse(localStorage.getItem(k) ?? '{}')
    localStorage.setItem(k, JSON.stringify({ ...s, uiZoom: 125 }))
  })
  await p.reload({ waitUntil: 'load' })
  await p.waitForTimeout(1500)
  const zoomed = await read()
  if (zoomed.left !== '125%') fail(`缩放设为 125 后读数应为 125%，实为 "${zoomed.left}"`)
  await p.click('#status-left .status-item-action')
  await p.waitForTimeout(600)
  const reset = await read()
  if (reset.left !== '100%') fail(`点读数应复位到 100%，实为 "${reset.left}"`)
  info(`缩放读数：125% → 点击 → ${reset.left}`)

  // ① 档位标签：非阅读档出现且可点，点它回阅读档
  await p.keyboard.press('Control+2')
  await p.waitForTimeout(700)
  const editing = await read()
  if (editing.mode !== 'edit') fail(`按 Ctrl+2 应进编辑档，实为 "${editing.mode}"`)
  if (editing.rightAction !== 1) fail(`编辑档右组应有 1 个可点项（档位标签），实为 ${editing.rightAction}`)
  await p.click('#status-right .status-item-action')
  await p.waitForTimeout(700)
  const back = await read()
  if (back.mode !== 'read') fail(`点档位标签应回阅读档，实为 "${back.mode}"`)
  if (back.rightAction !== 0) fail(`回到阅读档后可点项应消失，实为 ${back.rightAction}`)
  info(`档位标签：edit → 点击 → ${back.mode}`)

  // macOS 顶栏让红绿灯，左内边距跟 --band-inset。状态行必须留在 14px，
  // 否则侧栏停靠时一两百像素的左留白会把窄窗口撑出横向滚动。
  // 同一次读取里量：壳会在下一帧按正文列重写 --band-inset，拆开量会把顶栏读成那个值。
  const pads = await p.evaluate(() => {
    const root = document.documentElement
    root.dataset.shell = 'macos'
    root.style.setProperty('--band-inset', '280px')
    const status = document.getElementById('statusbar')
    const title = document.getElementById('titlebar')
    return {
      statusLeft: status ? getComputedStyle(status).paddingLeft : '',
      titleLeft: title ? getComputedStyle(title).paddingLeft : '',
      overflow: root.scrollWidth - root.clientWidth,
    }
  })
  if (pads.statusLeft !== '14px') {
    fail(`macOS 状态行左内边距应是 14px，不受 --band-inset 影响，实为 ${pads.statusLeft}`)
  }
  if (pads.titleLeft !== '280px') {
    fail(`macOS 顶栏左内边距应跟着 280px 的 --band-inset，实为 ${pads.titleLeft}`)
  }
  if (pads.overflow > 0) fail(`状态行留白把文档撑出横向滚动 ${pads.overflow}px`)
  info(`macOS 留白：顶栏 ${pads.titleLeft}，状态行 ${pads.statusLeft}`)
} catch (e) {
  fail(`异常：${e instanceof Error ? e.message : String(e)}`)
}
await b.close()
console.log(errors ? `${errors} error` : '0 error')
process.exit(errors ? 1 : 0)
