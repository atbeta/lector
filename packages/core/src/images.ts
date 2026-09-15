// 块内图片的定位与改写。
//
// 为什么放 core：图片动作（跳到源码、上传图床后换 src）都需要「按渲染顺序拿到
// 第 n 张图在 raw 里的精确区间」。用 mdast 的 position 而不是正则/字符串匹配——
// 正则会在 alt 里带括号、URL 里带空格时改错位置，而这类错误没有任何报错，
// 只会把用户的链接悄悄改坏。纯函数，测试先行。

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'

const extensions = [gfm(), math(), frontmatter()]
const mdastExtensions = [gfmFromMarkdown(), mathFromMarkdown(), frontmatterFromMarkdown()]

export interface ImageRef {
  url: string
  alt: string
  title: string | null
  /** 在 raw 中的 [start, end)（UTF-16 下标，来自 mdast position） */
  start: number
  end: number
}

interface MdNode {
  type?: string
  url?: string
  alt?: string | null
  title?: string | null
  children?: MdNode[]
  position?: { start?: { offset?: number }; end?: { offset?: number } } | null
}

function collect(nodes: MdNode[], out: ImageRef[]): void {
  for (const n of nodes) {
    if (n.type === 'image') {
      const s = n.position?.start?.offset
      const e = n.position?.end?.offset
      if (typeof s === 'number' && typeof e === 'number' && e > s) {
        out.push({ url: n.url ?? '', alt: n.alt ?? '', title: n.title ?? null, start: s, end: e })
      }
    }
    if (Array.isArray(n.children)) collect(n.children, out)
  }
}

/** 按文档顺序列出块内所有 Markdown 图片。 */
export function listImages(raw: string): ImageRef[] {
  if (!raw) return []
  const tree = fromMarkdown(raw, { extensions, mdastExtensions }) as { children: MdNode[] }
  const out: ImageRef[] = []
  collect(tree.children, out)
  return out
}

/**
 * 把第 index 张图片的 URL 换掉，其余字节原样保留。
 *
 * 只替换 `](` 与 `)` 之间那一段：重建整个 `![alt](url)` 要处理 alt 的转义，
 * 反而容易在特殊字符上引入偏差；直接切 URL 段最稳。
 * index 越界 / 语法畸形返回 null（调用方据此放弃这次改写，绝不猜着改）。
 */
export function replaceImageUrl(raw: string, index: number, url: string): string | null {
  const img = listImages(raw)[index]
  if (!img) return null
  const open = raw.indexOf('](', img.start)
  if (open < 0 || open >= img.end) return null
  const urlStart = open + 2
  let urlEnd = urlStart
  if (raw[urlEnd] === '<') {
    // <url with spaces> 形式：连尖括号一起换掉
    const gt = raw.indexOf('>', urlEnd)
    if (gt < 0 || gt >= img.end) return null
    urlEnd = gt + 1
  } else {
    while (urlEnd < img.end && !/[\s)]/.test(raw[urlEnd]!)) urlEnd++
  }
  if (raw[urlEnd] !== ')' && !/\s/.test(raw[urlEnd] ?? '')) return null
  return raw.slice(0, urlStart) + url + raw.slice(urlEnd)
}
