import { assetLocalPath } from './asset.ts'

/**
 * 图片菜单「复制图片」要交给壳的那串 source。
 *
 * 本地图用反解出的绝对路径（壳只读已打开文档目录里的文件）。
 * 图床用 http(s)。内嵌图用 data:image base64。其余（空 src、svg、blob）复制不了像素。
 */
export function clipboardImageSource(renderedSrc: string): string | null {
  const local = assetLocalPath(renderedSrc)
  if (local) return local
  const src = renderedSrc.trim()
  if (/^https?:\/\//i.test(src)) return src
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src)) return src
  return null
}
