import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport:{width:1200,height:820}, deviceScaleFactor:2 })
await p.addInitScript(()=>{ localStorage.setItem('lector-theme','light') })
const errs=[]; p.on('console',m=>m.type()==='error'&&errs.push(m.text())); p.on('pageerror',e=>errs.push(String(e)))
await p.goto('http://localhost:5199/', { waitUntil:'networkidle' })
await p.waitForSelector('#content .block')
const out = await p.evaluate(()=>{
  const cs=e=>getComputedStyle(e)
  const R=e=>{const r=e.getBoundingClientRect();return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),b:+r.bottom.toFixed(1),r:+r.right.toFixed(1)}}
  const c=document.getElementById('content')
  const blocks=[...document.querySelectorAll('#content > .block')].filter(e=>!e.classList.contains('gap'))
  const info=e=>{
    const s=cs(e), r=R(e)
    return {tag:e.tagName.toLowerCase(),kind:e.dataset.kind||null,depth:e.dataset.depth||null,
      x:r.x,y:r.y,w:r.w,h:r.h,fs:s.fontSize,fw:s.fontWeight,mt:s.marginTop,mb:s.marginBottom,
      pt:s.paddingTop,pb:s.paddingBottom,pl:s.paddingLeft,pr:s.paddingRight,lh:s.lineHeight,
      bg:s.backgroundColor,color:s.color,ta:s.textAlign,maxw:s.maxWidth,
      text:(e.textContent||'').trim().slice(0,28).replace(/\s+/g,' ')}
  }
  const rootCs=cs(document.documentElement)
  const tbl=document.querySelector('.reading-prose table')
  const pre=document.querySelector('.reading-prose pre')
  const cbChip=document.querySelector('.reading-prose p > code, .reading-prose p code')
  const cb=document.querySelector('.reading-prose li.task input')
  const cb2s=[...document.querySelectorAll('.reading-prose li.task input')].map(i=>{const s=cs(i),r=R(i);return {checked:i.checked,x:r.x,y:r.y,w:r.w,h:r.h,bg:s.backgroundColor,bd:s.borderColor,bw:s.borderWidth,ap:s.appearance}})
  const worktree = {}
  return {
    rootFontSize: rootCs.fontSize, htmlBoxSizing: rootCs.boxSizing,
    bodyBoxSizing: cs(document.body).boxSizing,
    content: {...info(c), children: blocks.length},
    blocks: blocks.map(info),
    contentChildrenKinds: blocks.map(e=>`${e.dataset.kind}${e.dataset.depth?':'+e.dataset.depth:''}`),
    table: tbl?{rect:R(tbl),maxw:cs(tbl).maxWidth,tableLayout:cs(tbl).tableLayout,
      head:[...tbl.querySelectorAll('thead th')].map(e=>({t:e.textContent.trim(),...(()=>{const r=R(e);return {x:r.x,w:r.w}})()})),
      rows:[...tbl.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(e=>{const r=R(e);return {t:e.textContent.trim().slice(0,14),x:r.x,w:r.w,h:r.h,ta:cs(e).textAlign}})),
      fonts:[...tbl.querySelectorAll('td')].map(e=>cs(e).fontSize).slice(0,4),
    }:null,
    pre: pre?{rect:R(pre),bg:cs(pre).backgroundColor,fs:cs(pre).fontSize,lh:cs(pre).lineHeight,
      pl:cs(pre).paddingLeft,pr:cs(pre).paddingRight,pt:cs(pre).paddingTop,pb:cs(pre).paddingBottom,
      radius:cs(pre).borderRadius,overflowX:cs(pre).overflowX,whiteSpace:cs(pre).whiteSpace,
      maxw:cs(pre).maxWidth, fontFamily:cs(pre).fontFamily.slice(0,40), tokens: [...pre.querySelectorAll('span')].map(s=>({t:s.textContent.slice(0,16),c:cs(s).color})).slice(0,20),
      scrollW: pre.scrollWidth, clientW: pre.clientWidth,
    }:null,
    inlineCode: cbChip?{...info(cbChip),bg:cs(cbChip).backgroundColor,bd:cs(cbChip).borderColor,bw:cs(cbChip).borderWidth,radius:cs(cbChip).borderRadius}:null,
    inlineCodes: [...document.querySelectorAll('.reading-prose p code')].map(e=>{const r=R(e);const s=cs(e);return {t:e.textContent,bg:s.backgroundColor,color:s.color,x:r.x,w:r.w,h:r.h,fs:s.fontSize}}),
    checkboxes: cb2s,
    taskLis: [...document.querySelectorAll('.reading-prose li.task')].map(e=>{const r=R(e);const s=cs(e);const lab=e.querySelector('.task-label');const lr=lab?R(lab):null;const ls=lab?cs(lab):null;return {t:e.textContent.trim().slice(0,20),x:r.x,w:r.w,h:r.h,deco:s.textDecorationLine,labX:lr&&lr.x,labW:lr&&lr.w,labDeco:ls&&ls.textDecorationLine,labColor:ls&&ls.color}}) ,
    hr:(()=>{const e=document.querySelector('.reading-prose hr');if(!e)return null;const s=cs(e),r=R(e);return {...r,bg:s.backgroundColor,bs:s.borderStyle,bw:s.borderWidth,bc:s.borderColor}})() ,
    quote:(()=>{const e=document.querySelector('.reading-prose blockquote');if(!e)return null;const s=cs(e),r=R(e);return {...r,bg:s.backgroundColor,bl:s.borderLeftWidth,blc:s.borderLeftColor,pl:s.paddingLeft,ml:s.marginLeft}})() ,
    h:[1,2,3,4,5,6].map(n=>{const e=document.querySelector('.reading-prose h'+n);if(!e)return null;const s=cs(e),r=R(e);return {n,fs:s.fontSize,fw:s.fontWeight,mt:s.marginTop,mb:s.marginBottom,y:r.y,h:r.h}}),
    paras: [...document.querySelectorAll('.reading-prose p')].map(e=>{const r=R(e),s=cs(e);return {y:r.y,h:r.h,fs:s.fontSize,lh:s.lineHeight,mb:s.marginBottom,t:e.textContent.slice(0,16)}}),
    titlebar:(()=>{const e=document.getElementById('titlebar');const r=R(e);const s=cs(e);const title=document.querySelector('.titlebar-title');const tr=title?R(title):null;return {...r,bg:s.backgroundColor,borderBottom:s.borderBottomWidth+' '+s.borderBottomColor,pos:s.position,backdrop:s.backdropFilter,shadow:s.boxShadow,
      icons:[...document.querySelectorAll('#titlebar .btn-icon')].map(b=>{const br=R(b);const bs=cs(b);return {id:b.id,x:br.x,y:br.y,w:br.w,h:br.h,color:bs.color,title:b.title}}),
      title:{x:tr.x,w:tr.w,fs:cs(title).fontSize,cx:tr.x+tr.w/2,text:title.textContent.trim()},
      lead:(()=>{const l=document.querySelector('.titlebar-lead');const lr=R(l);return {x:lr.x,w:lr.w}})(),
      controls:[...document.querySelectorAll('.window-controls button')].map(b=>{const br=R(b);return {id:b.id||b.title,x:br.x,w:br.w,h:br.h,vis:br.w>0,title:b.title}}),
      shell: document.documentElement.getAttribute('data-shell'),
    }})(),
    scrollHeight: document.documentElement.scrollHeight,
    innerW: window.innerWidth, innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  }
})
console.log(JSON.stringify(out,null,1))
console.log('CONSOLE_ERRORS', JSON.stringify(errs))
await p.screenshot({ path:'.review/fresh-light-full.png', fullPage:true })
await b.close()
