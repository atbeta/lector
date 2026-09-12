import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport:{width:1200,height:820}, deviceScaleFactor:2 })
await p.goto('http://localhost:5199/', { waitUntil:'networkidle' })
await p.waitForSelector('#content .block')
const r = await p.evaluate(()=>{
  const cs=e=>getComputedStyle(e)
  const kids=[...document.getElementById('content').children]
  return {
    contentStyle:(()=>{const s=cs(document.getElementById('content'));return {display:s.display,flexDirection:s.flexDirection,overflow:s.overflow}})(),
    kids:kids.map(e=>{const s=cs(e),r=e.getBoundingClientRect();return {i:kids.indexOf(e),cls:e.className.replace('block','').trim(),kind:e.dataset.kind||'',h:+r.height.toFixed(1),top:+r.top.toFixed(1),bot:+r.bottom.toFixed(1),mt:s.marginTop,mb:s.marginBottom,of:s.overflow}}),
    total:kids.length,
    // measure actual collapsing: gap between consecutive ink blocks
  }
})
console.log(JSON.stringify(r,null,1))
await b.close()
