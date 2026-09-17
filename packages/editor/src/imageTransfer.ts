import type { BlockView } from '@lector/core'
import { isImageMime, pastedFileName, safeDropName } from './imageInsert.ts'
import { t } from './i18n.ts'
import { detectEnv, listenShell, readBytes } from '@lector/shell-web'
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
  // 全窗 overlay，按拖的东西给不同文案（图片=插入，文档=打开）。
  let dropOverlayEl: HTMLElement | null = null
  function showDropOverlay(text: string): void {
    if (dropOverlayEl) {
      dropOverlayEl.textContent = text
      return
    }
    const el = document.createElement('div')
    el.className = 'drop-overlay'
    el.textContent = text
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

  function insertImagesAt(files: File[], insertRef: Parameters<typeof ingestImageFile>[2]): void {
    void (async () => {
      for (const f of files) {
        await ingestImageFile(f, safeDropName(f.name) ?? pastedFileName(new Date(), f.type), insertRef)
      }
    })()
  }

  if (detectEnv() === 'shell') {
    // 壳内走原生通道：文件拖放被 wry 的原生处理器接管，HTML5 drop 不会来。
    // 壳分发（lib.rs RunEvent::WindowEvent）：md/txt 由壳直接开窗（不经过这里），
    // 图片带逻辑坐标 emit 过来；悬停时按内容类型亮不同提示。
    void (async () => {
      await listenShell<'image' | 'doc' | 'other' | 'none'>('lector:drag-hover', (kind) => {
        if (kind === 'image') showDropOverlay(t('dropImageHint'))
        else if (kind === 'doc') showDropOverlay(t('dropDocHint'))
        else hideDropOverlay()
      })
      await listenShell<{ paths: string[]; x: number; y: number }>('lector:drop-files', ({ paths, x, y }) => {
        hideDropOverlay()
        if (paths.length === 0) return
        const hit = blockIdUnderPoint(x, y)
        const insertRef: Parameters<typeof ingestImageFile>[2] = hit
          ? { type: 'afterBlock', blockId: hit.blockId }
          : { type: 'caret' }
        void (async () => {
          for (const p of paths) {
            // WebView 的 File 对象拿不到磁盘路径，字节由壳读（read_file_bytes），
            // 包成 File 走既有插入管线——落点定位、复制进 assets 全部不变。
            const bytes = await readBytes(p)
            const name = p.split(/[\\/]/).pop() ?? 'image'
            await ingestImageFile(new File([bytes], name), safeDropName(name), insertRef)
          }
        })()
      })
    })()
    return
  }

  // 浏览器 dev（无壳）：HTML5 通道。打包壳里不存在这条路径。
  window.addEventListener('dragover', (e) => {
    const hasImage = imageFilesFromList(e.dataTransfer?.files).length > 0
    if (hasImage) {
      e.preventDefault()
      showDropOverlay(t('dropImageHint'))
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
    insertImagesAt(files, insertRef)
  })
}
