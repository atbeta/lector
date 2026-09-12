import { chromium } from 'playwright'
const b = await chromium.launch()
for (const theme of ['light','dark']) {
  const p = await b.newPage({ viewport:{width:1200,height:820}, deviceScaleFactor:2 })
  await p.addInitScript((t)=>{ localStorage.setItem('lector-theme',t) }, theme)
  await p.goto('http://localhost:5199/', { waitUntil:'networkidle' })
  await p.waitForSelector('#content .block')
  const r = await p.evaluate(()=>{
    const out=[]
    for (const el of document.querySelectorAll('#content *')) {
      const b=el.getBoundingClientRect()
      if (b.width>0 && (b.right>window.innerWidth+0.5 || b.left<-0.5)) out.push({tag:el.tagName.toLowerCase(),cls:String(el.className).slice(0,26),l:+b.left.toFixed(1),r:+b.right.toFixed(1)})
    }
    const zero=[...document.querySelectorAll('#content .block')].filter(e=>e.getBoundingClientRect().height===0&&!e.classList.contains('gap')).length
    // check clashing overlaps between sibling blocks
    const blocks=[...document.querySelectorAll('#content > .block')].filter(e=>!e.classList.contains('gap'))
    let overlaps=0
    for (let i=1;i<blocks.length;i++){ if (blocks[i].getBoundingClientRect().top < blocks[i-1].getBoundingClientRect().bottom-0.5) overlaps++ }
    // code block internal overflow
    const pre=document.querySelector('.reading-prose pre')
    const preOv = pre ? {scrollW:pre.scrollWidth, clientW:pre.clientWidth, overflow: pre.scrollWidth>pre.clientWidth+1} : null
    const scrollbars=[]
    for (const el of document.querySelectorAll('#content *')) if (el.scrollWidth>el.clientWidth+1 && getComputedStyle(el).overflowX!=='visible') scrollbars.push(el.tagName+'.'+String(el.className).slice(0,18))
    return {overflow:out, zeroHeightNonGapBlocks:zero, siblingOverlaps:overlaps, preOv, scrollbars, docScrollW:document.documentElement.scrollWidth, winW:window.innerWidth}
  })
  console.log(theme.toUpperCase(), JSON.stringify(r))
  await p.close()
}
await b.close()
