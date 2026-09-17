/**
 * 查找命中高亮：把正文里匹配到的文字包成 `<mark class="find-hit">`，当前命中再加深一层。
 *
 * 为什么直接改 DOM、而不进渲染管线：
 *   - 查找结果是**临时的**，不属于文档模型——写进块数据会污染 dirty 判定，
 *     用户只是搜了一下，状态行就变成「未保存」，甚至可能被写回磁盘；
 *   - 重建整篇又会让长文档在输入框里每敲一个字就整页重排。
 * 所以这里只做「临时标记」，关掉查找时原样拆掉（unwrap + normalize），
 * 文档数据一个字节都不动。
 *
 * 三个容易踩的点：
 *   1. 只处理文本节点，且跳过编辑器（块内源码）、脚本、以及已经标过的命中——
 *      对已包裹的节点再包一层会越包越深；
 *   2. 大小写不敏感，但保留原文大小写（mark 里放原文）；
 *   3. 拆/装都要成对：clear 用 replaceChild + normalize 把文本合回去。
 */

import { compileFind, type FindOptions } from './findMatch.ts'

const HIT = 'find-hit'
const CURRENT = 'find-hit--current'

/** 收集可安全标记的文本节点 */
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // 跳过的都是「不是文档正文」的文本：
      //   .cm-editor  块内源码（另有自己的高亮）
      //   script/style 不是内容
      //   mark.find-hit 已标过的，再包一层会越包越深
      //   .mermaid-svg 图里的文字是 SVG 生成的，不是正文
      //   .ln-gutter   代码块的行号列——**装饰**，文本内容是 "1\n2\n3..."。
      //                漏掉它的后果很具体：搜 "1" 会把行号也点亮，于是
      //                「计数 6 处 / 高亮 10 个」对不上，而计数才是对的。
      if (parent.closest('.cm-editor, script, style, mark.find-hit, .mermaid-svg, .ln-gutter')) {
        return NodeFilter.FILTER_REJECT
      }
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const out: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) out.push(n as Text)
  return out
}

/** 拆掉所有命中标记，文本复原（查找关闭、查询清空、文档重绘前都要调） */
export function clearFindHighlight(root: HTMLElement): void {
  for (const mark of [...root.querySelectorAll(`mark.${HIT}`)]) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  }
}

/**
 * 标记当前文档里所有命中。返回标记到的数量。
 *
 * 走**统一匹配器**（findMatch.ts）：高亮的命中集合必须和计数、替换完全一致，
 * 否则会出现「计数说 3 处、只标出 2 处」这种谁也说不清的问题——
 * 而这类不一致在字符串模式下看不出来，一开正则/全词就冒出来。
 */
export function applyFindHighlight(root: HTMLElement, query: string, opts: FindOptions): number {
  clearFindHighlight(root)
  if (!query) return 0
  const c = compileFind(query, opts)
  if (!c.ok) return 0
  let hits = 0
  for (const node of textNodes(root)) {
    const text = node.nodeValue ?? ''
    const found = c.find(text)
    if (found.length === 0) continue
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const h of found) {
      if (h.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, h.start)))
      const mark = document.createElement('mark')
      mark.className = HIT
      mark.textContent = text.slice(h.start, h.end)
      frag.appendChild(mark)
      hits++
      cursor = h.end
    }
    frag.appendChild(document.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(frag, node)
  }
  return hits
}

/**
 * 把某个块里第 nth 个命中标成「当前」，并滚动到它。
 * 滚动用 scrollIntoView 的 center：命中可能贴着视口边缘，居中才看得清上下文。
 */
export function focusFindHit(blockEl: HTMLElement, nth: number): boolean {
  for (const m of blockEl.querySelectorAll(`mark.${CURRENT}`)) m.classList.remove(CURRENT)
  const hit = blockEl.querySelectorAll(`mark.${HIT}`)[nth]
  if (!hit) return false
  hit.classList.add(CURRENT)
  hit.scrollIntoView({ block: 'center', behavior: 'auto' })
  return true
}
