import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport:{width:1200,height:820}, deviceScaleFactor:2 })
await p.addInitScript(()=>{ localStorage.setItem('lector-theme','light') })
await p.goto('http://localhost:5199/', { waitUntil:'networkidle' })
await p.waitForSelector('#content .block')
await p.screenshot({ path:'.review/vp-scroll0.png' })
await p.evaluate(()=>window.scrollTo(0,300)); await p.waitForTimeout(300)
await p.screenshot({ path:'.review/vp-scroll300.png' })
await p.evaluate(()=>window.scrollTo(0,643)); await p.waitForTimeout(300)
await p.screenshot({ path:'.review/vp-scroll643.png' })
const info = await p.evaluate(()=>{
  const bs=getComputedStyle(document.body)
  const hs=getComputedStyle(document.documentElement)
  return {bodyBg:bs.backgroundImage, bodySize:bs.backgroundSize, bodyRepeat:bs.backgroundRepeat,
    bodyAttach:bs.backgroundAttachment, bodyH:bs.height, htmlH:hs.height, htmlBg:hs.backgroundImage,
    scrollH:document.documentElement.scrollHeight, bodyRect:document.body.getBoundingClientRect().height,
    gradientCount:(bs.backgroundImage.match(/gradient/g)||[]).length}
})
console.log(JSON.stringify(info,null,1))
await b.close()
