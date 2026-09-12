import { chromium } from 'playwright'
const b = await chromium.launch()
for (const theme of ['light','dark']) {
  const p = await b.newPage({ viewport:{width:1200,height:820}, deviceScaleFactor:2 })
  await p.addInitScript((t)=>{ localStorage.setItem('lector-theme',t) }, theme)
  await p.goto('http://localhost:5199/', { waitUntil:'networkidle' })
  await p.waitForSelector('#content .block')
  const r = await p.evaluate(()=>{
    const cs=e=>getComputedStyle(e)
    const q=document.querySelector('.reading-prose blockquote')
    const qp=document.querySelector('.reading-prose blockquote p')||q
    const lab=document.querySelector('.reading-prose li.task:has(input:checked) .task-label')
    const tbl=document.querySelector('.reading-prose table')
    const th=tbl&&tbl.querySelector('thead th')
    const td=tbl&&tbl.querySelector('tbody td')
    const hr=document.querySelector('.reading-prose hr')
    const pre=document.querySelector('.reading-prose pre')
    const code=document.querySelector('.reading-prose code')
    const h1=document.querySelector('.reading-prose h1')
    const info=e=>e?{fs:cs(e).fontSize,fw:cs(e).fontWeight,color:cs(e).color,bg:cs(e).backgroundColor,
      borderTop:cs(e).borderTopWidth+' '+cs(e).borderTopColor, borderBottom:cs(e).borderBottomWidth+' '+cs(e).borderBottomColor,
      deco:cs(e).textDecorationLine, decoColor:cs(e).textDecorationColor, decoThick:cs(e).textDecorationThickness,
      pad:cs(e).padding, mar:cs(e).margin, radius:cs(e).borderRadius}:null
    return {
      quote:info(q), quoteP:info(qp), taskLabel:info(lab), th:info(th), td:info(td),
      hr:info(hr), pre:info(pre), code:info(code), h1:info(h1),
      contentFlex: cs(document.getElementById('content')).display,
      contentGap: cs(document.getElementById('content')).rowGap,
      tableRowBorder: td?cs(td).borderBottomWidth+' '+cs(td).borderBottomColor:null,
      thBorder: th?cs(th).borderBottomWidth+' '+cs(th).borderBottomColor:null,
      thBg: th?cs(th).backgroundColor:null, tdBg: td?cs(td).backgroundColor:null,
      tableBorder: tbl?cs(tbl).border:null,
      quoteBarColor: q?cs(q).borderLeftColor:null,
      hrColor: hr?cs(hr).backgroundColor:null,
      preWidth: pre?pre.getBoundingClientRect().width:null,
      columnWidth: document.getElementById('content').getBoundingClientRect().width,
      readingMaxW: cs(document.documentElement).getPropertyValue('--reading-max-w'),
      taskLabelDisplay: lab?cs(lab).display:null,
      taskLabelChild: lab&&lab.firstElementChild?lab.firstElementChild.tagName+':'+cs(lab.firstElementChild).display:null,
      liTaskDisplay: cs(document.querySelector('.reading-prose li.task')).display,
      liTaskChildren: [...document.querySelector('.reading-prose li.task').children].map(c=>c.tagName+':'+cs(c).display),
    }
  })
  console.log('==== '+theme.toUpperCase())
  console.log(JSON.stringify(r,null,1))
  await p.close()
}
await b.close()
