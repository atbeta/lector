import type { BlockView } from '@lector/core'
import { isImageMime, pastedFileName, safeDropName } from './imageInsert.ts'
import { t } from './i18n.ts'
import type { ImageInsertRef } from './imageController.ts'

export function bindImageTransfer({
  getBlocks,
  ingestImageFile,
}: {
  getBlocks(): readonly BlockView[]
  ingestImageFile(file: File, name: string | null, insertRef?: ImageInsertRef | null): Promise<void>
}): void {
  function imageFilesFromList(list: FileList | DataTransferItemList | undefined | null): File[] {
    if (!list) return []
    const out: File[] = []
    for (const item of list) {
      if (item instanceof File) {
        if (isImageMime(item.type) || safeDropName(item.name)) out.push(item)
        continue
      }
      if (item.kind === 'file' && isImageMime(item.type)) {
        const f = item.getAsFile()
        if (f) out.push(f)
      }
    }
    return out
  }

  window.addEventListener(
    'paste',
    (e) => {
      const files = imageFilesFromList(e.clipboardData?.items)
      if (files.length === 0) return
      e.preventDefault()
      void (async () => {
        for (const f of files) {
          await ingestImageFile(f, pastedFileName(new Date(), f.type) ?? safeDropName(f.name), { type: 'caret' })
        }
      })()
    },
    true,
  )

  // 拖放反馈：没给一个「松手就落这」的提示，用户会以为没拖中。
  // 读到图片就加一个全窗 overlay，松开/离开就摘掉。不拦 md 或非图片文件的 drop。
  let dropOverlayEl: HTMLElement | null = null
  function showDropOverlay(): void {
    if (dropOverlayEl) return
    const el = document.createElement('div')
    el.className = 'drop-overlay'
    el.textContent = t('dropImageHint')
    document.body.appendChild(el)
    dropOverlayEl = el
  }
  function hideDropOverlay(): void {
    dropOverlayEl?.remove()
    dropOverlayEl = null
  }

  /** 落点所在的块 id：用 elementFromPoint 命中 `.block:not(.gap)`。 */
  function blockIdUnderPoint(x: number, y: number): { blockId: string; index: number } | null {
    const el = document.elementFromPoint(x, y)
    const blockEl = el?.closest<HTMLElement>('.block:not(.gap)')
    if (!blockEl) return null
    const id = blockEl.dataset.blockId
    if (!id) return null
    const index = getBlocks().findIndex((b) => b.id === id)
    if (index < 0) return null
    return { blockId: id, index }
  }

  window.addEventListener('dragover', (e) => {
    const hasImage = imageFilesFromList(e.dataTransfer?.files).length > 0
    if (hasImage) {
      e.preventDefault()
      showDropOverlay()
    }
  })

  window.addEventListener('dragleave', (e) => {
    // 离开窗口 / 进入子元素才算结束；用 relatedTarget 判是否还在文档内
    const related = e.relatedTarget as Node | null
    if (!related || !document.body.contains(related)) hideDropOverlay()
  })

  window.addEventListener('drop', (e) => {
    hideDropOverlay()
    const files = imageFilesFromList(e.dataTransfer?.files)
    if (files.length === 0) return
    e.preventDefault()
    const hit = blockIdUnderPoint(e.clientX, e.clientY)
    const insertRef: Parameters<typeof ingestImageFile>[2] = hit
      ? { type: 'afterBlock', blockId: hit.blockId }
      : { type: 'caret' }
    void (async () => {
      for (const f of files) {
        await ingestImageFile(f, safeDropName(f.name) ?? pastedFileName(new Date(), f.type), insertRef)
      }
    })()
  })
}
